import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { GitHubLoginPoll, GitHubLoginStart, GitHubStatus } from "@tsukaima/contracts";
import type { Logger } from "../logging.ts";

/**
 * GitHub authentication owned by the runtime `gh` CLI.
 *
 * The server never parses or stores an OAuth token itself: login is a `gh auth login` child
 * process, status comes from `gh auth status --json`, and a token is requested from
 * `gh auth token` only for the single git or REST call that needs it. `GH_CONFIG_DIR` lives on
 * the data volume so the session survives a restart and stays out of the repository.
 */

export type GitHubCliErrorCode =
	| "github_cli_failed"
	| "github_cli_missing"
	| "github_not_authenticated";

export class GitHubCliError extends Error {
	readonly code: GitHubCliErrorCode;

	constructor(code: GitHubCliErrorCode, message: string) {
		super(message);
		this.name = "GitHubCliError";
		this.code = code;
	}
}

export interface GhCommandResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export interface GhCommandOptions {
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

export interface GhLoginProcess {
	readonly exitCode: number | null;
	kill(): void;
	onError(listener: (error: Error) => void): void;
	onExit(listener: (exitCode: number | null) => void): void;
	onOutput(listener: (chunk: string) => void): void;
}

export interface GitHubCliServiceOptions {
	readonly dataDir: string;
	readonly exec?: (args: readonly string[], options: GhCommandOptions) => Promise<GhCommandResult>;
	readonly host?: string;
	readonly logger?: Logger;
	readonly now?: () => number;
	readonly spawnLogin?: (
		args: readonly string[],
		options: { readonly env: Readonly<Record<string, string>> },
	) => GhLoginProcess;
}

const DEFAULT_HOST = "github.com";
const COMMAND_TIMEOUT_MS = 20_000;
const LOGIN_CODE_TIMEOUT_MS = 15_000;
const LOGIN_LIFETIME_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_ERROR_CHARS = 300;
const CREDENTIAL_ENV_KEYS = [
	"GH_ENTERPRISE_TOKEN",
	"GH_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GITHUB_TOKEN",
] as const;
// Built from a code point so the linter's control-character rule only sees ordinary source.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

const hostAccountSchema = z.object({
	active: z.boolean().optional(),
	error: z.string().optional(),
	gitProtocol: z.string().optional(),
	host: z.string().optional(),
	login: z.string().optional(),
	scopes: z.union([z.array(z.string()), z.string()]).nullish(),
	state: z.string().optional(),
});

const statusSchema = z.object({
	hosts: z.record(z.string(), z.array(hostAccountSchema)),
});

interface LoginSession {
	readonly expiresAtMs: number;
	exitCode: number | null;
	readonly process: GhLoginProcess;
	output: string;
	timer: ReturnType<typeof setTimeout> | undefined;
	userCode: string | undefined;
	verificationUri: string | undefined;
}

/** Public GitHub uses `github.com`; GitHub Enterprise Server uses its web host. */
export function githubHostFromApiUrl(apiBaseUrl: string): string {
	const url = new URL(apiBaseUrl);
	return url.hostname === "api.github.com" ? "github.com" : url.host;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function boundedError(value: string): string {
	const text = stripAnsi(value).replace(/\s+/gu, " ").trim();
	return text.length === 0 ? "GitHub CLI failed" : text.slice(0, MAX_ERROR_CHARS);
}

function processEnvironment(configDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of CREDENTIAL_ENV_KEYS) delete env[key];
	env.GH_CONFIG_DIR = configDir;
	env.GH_NO_UPDATE_NOTIFIER = "1";
	env.GH_PAGER = "cat";
	env.GIT_CONFIG_GLOBAL = join(configDir, "gitconfig");
	env.GIT_TERMINAL_PROMPT = "0";
	env.NO_COLOR = "1";
	return env;
}

function mapSpawnError(error: Error): GitHubCliError {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") {
		return new GitHubCliError(
			"github_cli_missing",
			"GitHub CLI (gh) is not installed in the server image",
		);
	}
	return new GitHubCliError("github_cli_failed", `GitHub CLI could not start: ${error.message}`);
}

async function defaultExec(
	args: readonly string[],
	options: GhCommandOptions,
): Promise<GhCommandResult> {
	const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
	return await new Promise<GhCommandResult>((resolvePromise, rejectPromise) => {
		const child = spawn("gh", [...args], {
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) {
				stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES - stdout.length);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) {
				stderr += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES - stderr.length);
			}
		});
		child.on("error", (error: Error) => {
			clearTimeout(timer);
			rejectPromise(mapSpawnError(error));
		});
		child.on("close", (exitCode: number | null) => {
			clearTimeout(timer);
			if (timedOut) {
				rejectPromise(
					new GitHubCliError(
						"github_cli_failed",
						`GitHub CLI did not respond within ${timeoutMs / 1000} seconds`,
					),
				);
				return;
			}
			resolvePromise({ exitCode, stderr, stdout });
		});
	});
}

function defaultSpawnLogin(
	args: readonly string[],
	options: { readonly env: Readonly<Record<string, string>> },
): GhLoginProcess {
	const child = spawn("gh", [...args], {
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		get exitCode() {
			return child.exitCode;
		},
		kill: () => {
			child.kill("SIGKILL");
		},
		onError: (listener) => {
			child.on("error", listener);
		},
		onExit: (listener) => {
			child.on("close", (exitCode: number | null) => listener(exitCode));
		},
		onOutput: (listener) => {
			child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
			child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
		},
	};
}

function parseLoginPrompt(output: string): {
	userCode: string | undefined;
	verificationUri: string | undefined;
} {
	const text = stripAnsi(output);
	const code = /First copy your one-time code:\s*([A-Za-z0-9-]+)/u.exec(text)?.[1];
	const url =
		/Open this URL to continue in your web browser:\s*(https?:\/\/\S+)/u.exec(text)?.[1] ??
		/(https?:\/\/\S+\/login\/device)/u.exec(text)?.[1];
	return {
		userCode: code,
		verificationUri: url,
	};
}

function loginFailure(output: string): string {
	const lines = stripAnsi(output)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.includes("one-time code"))
		.filter((line) => !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(line));
	return boundedError(lines.at(-1) ?? "");
}

export class GitHubCliService {
	readonly #configDir: string;
	readonly #exec: (args: readonly string[], options: GhCommandOptions) => Promise<GhCommandResult>;
	readonly #host: string;
	readonly #logger: Logger | undefined;
	readonly #now: () => number;
	readonly #spawnLogin: (
		args: readonly string[],
		options: { readonly env: Readonly<Record<string, string>> },
	) => GhLoginProcess;
	#configReady: Promise<void> | undefined;
	#login: LoginSession | undefined;

	constructor(options: GitHubCliServiceOptions) {
		this.#configDir = join(options.dataDir, "gh");
		this.#exec = options.exec ?? defaultExec;
		this.#host = options.host ?? DEFAULT_HOST;
		this.#logger = options.logger?.child("tsukaima::server::github-cli");
		this.#now = options.now ?? Date.now;
		this.#spawnLogin = options.spawnLogin ?? defaultSpawnLogin;
	}

	get host(): string {
		return this.#host;
	}

	async status(): Promise<GitHubStatus> {
		try {
			await this.#ready();
			const result = await this.#run([
				"auth",
				"status",
				"--json",
				"hosts",
				"--hostname",
				this.#host,
			]);
			if (result.exitCode !== 0) {
				return this.#statusError(result.stderr.length > 0 ? result.stderr : result.stdout, true);
			}
			const parsed = statusSchema.safeParse(JSON.parse(result.stdout));
			if (!parsed.success) {
				return this.#statusError("GitHub CLI returned an unexpected authentication status", true);
			}
			const entries = parsed.data.hosts[this.#host] ?? [];
			const entry = entries.find((candidate) => candidate.active === true) ?? entries[0];
			if (entry === undefined) {
				return {
					available: true,
					configured: false,
					error: null,
					gitProtocol: null,
					host: this.#host,
					login: null,
					scopes: [],
				};
			}
			const login = entry.login?.trim() ?? "";
			const scopes =
				entry.scopes === undefined || entry.scopes === null
					? []
					: Array.isArray(entry.scopes)
						? entry.scopes
						: entry.scopes
								.split(",")
								.map((scope) => scope.trim())
								.filter((scope) => scope.length > 0);
			return {
				available: true,
				configured: login.length > 0,
				error:
					login.length === 0 || entry.state === "success"
						? null
						: boundedError(entry.error ?? "GitHub CLI reported an authentication error"),
				gitProtocol: entry.gitProtocol ?? null,
				host: this.#host,
				login: login.length === 0 ? null : login,
				scopes,
			};
		} catch (error) {
			if (error instanceof GitHubCliError && error.code === "github_cli_missing") {
				return this.#statusError(error.message, false);
			}
			return this.#statusError(error instanceof Error ? error.message : String(error), true);
		}
	}

	/** A token for one git or REST call. It is never logged, cached, or returned by an RPC. */
	async token(): Promise<string> {
		await this.#ready();
		const result = await this.#run(["auth", "token", "--hostname", this.#host]);
		const token = result.stdout.trim();
		if (result.exitCode !== 0 || token.length === 0) {
			throw new GitHubCliError(
				"github_not_authenticated",
				`GitHub is not signed in: ${boundedError(result.stderr)}`,
			);
		}
		return token;
	}

	/** Optional credential for a repository call: no login means the operator's remote still works. */
	async gitCredential(): Promise<string | undefined> {
		try {
			return await this.token();
		} catch (error) {
			if (
				error instanceof GitHubCliError &&
				(error.code === "github_cli_missing" || error.code === "github_not_authenticated")
			) {
				return undefined;
			}
			throw error;
		}
	}

	async startLogin(): Promise<GitHubLoginStart> {
		await this.#ready();
		this.#cancelLogin();
		let process: GhLoginProcess;
		try {
			process = this.#spawnLogin(
				[
					"auth",
					"login",
					"--hostname",
					this.#host,
					"--git-protocol",
					"https",
					"--web",
					"--clipboard=false",
					"--insecure-storage",
					"--scopes",
					"repo",
				],
				{ env: processEnvironment(this.#configDir) },
			);
		} catch (error) {
			throw mapSpawnError(error instanceof Error ? error : new Error(String(error)));
		}
		const session: LoginSession = {
			expiresAtMs: this.#now() + LOGIN_LIFETIME_MS,
			exitCode: null,
			output: "",
			process,
			timer: undefined,
			userCode: undefined,
			verificationUri: undefined,
		};
		this.#login = session;
		this.#logger?.info("github cli login started", { host: this.#host });
		session.timer = setTimeout(() => {
			if (this.#login === session && session.exitCode === null) {
				process.kill();
			}
		}, LOGIN_LIFETIME_MS);
		session.timer.unref?.();

		return await new Promise<GitHubLoginStart>((resolvePromise, rejectPromise) => {
			let settled = false;
			const codeTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.#cancelLogin();
				rejectPromise(
					new GitHubCliError(
						"github_cli_failed",
						"GitHub CLI did not print a device code; check the server logs",
					),
				);
			}, LOGIN_CODE_TIMEOUT_MS);
			codeTimer.unref?.();

			const fail = (error: GitHubCliError): void => {
				if (settled) return;
				settled = true;
				clearTimeout(codeTimer);
				this.#cancelLogin();
				rejectPromise(error);
			};
			const succeed = (): void => {
				if (settled) return;
				if (session.userCode === undefined || session.verificationUri === undefined) return;
				settled = true;
				clearTimeout(codeTimer);
				resolvePromise({
					expiresAt: new Date(session.expiresAtMs).toISOString(),
					userCode: session.userCode,
					verificationUri: session.verificationUri,
				});
			};

			process.onError((error) => fail(mapSpawnError(error)));
			process.onExit((exitCode) => {
				session.exitCode = exitCode;
				if (settled) return;
				fail(
					new GitHubCliError(
						"github_cli_failed",
						exitCode === 0
							? "GitHub CLI exited before printing a device code"
							: loginFailure(session.output),
					),
				);
			});
			process.onOutput((chunk) => {
				session.output = stripAnsi(`${session.output}${chunk}`).slice(-MAX_OUTPUT_BYTES);
				const prompt = parseLoginPrompt(session.output);
				session.userCode = prompt.userCode ?? session.userCode;
				session.verificationUri =
					prompt.verificationUri ?? session.verificationUri ?? `https://${this.#host}/login/device`;
				succeed();
			});
		});
	}

	async pollLogin(): Promise<GitHubLoginPoll> {
		const session = this.#login;
		if (session === undefined) return { status: "idle" };
		if (this.#now() >= session.expiresAtMs) {
			this.#cancelLogin();
			return { status: "expired" };
		}
		if (session.exitCode === null) return { status: "pending" };

		this.#dropSession(session);
		if (session.exitCode !== 0) {
			return { message: loginFailure(session.output), status: "failed" };
		}
		const status = await this.status();
		if (!status.configured || status.login === null) {
			return {
				message: status.error ?? "GitHub CLI finished without a signed-in account",
				status: "failed",
			};
		}
		this.#logger?.info("github cli login completed", { login: status.login });
		return { login: status.login, status: "authorized" };
	}

	async logout(): Promise<GitHubStatus> {
		await this.#ready();
		this.#cancelLogin();
		const status = await this.status();
		if (!status.configured || status.login === null) return status;
		const result = await this.#run([
			"auth",
			"logout",
			"--hostname",
			this.#host,
			"--user",
			status.login,
		]);
		if (result.exitCode !== 0) {
			throw new GitHubCliError(
				"github_cli_failed",
				`GitHub CLI could not sign out: ${boundedError(result.stderr)}`,
			);
		}
		this.#logger?.info("github cli signed out", { login: status.login });
		return await this.status();
	}

	/** Stop a server-driven login when the lifecycle shuts down. */
	close(): void {
		this.#cancelLogin();
	}

	async #ready(): Promise<void> {
		this.#configReady ??= (async () => {
			await mkdir(this.#configDir, { mode: 0o700, recursive: true });
			await chmod(this.#configDir, 0o700).catch(() => undefined);
		})().catch((error: unknown) => {
			this.#configReady = undefined;
			throw new GitHubCliError(
				"github_cli_failed",
				`Could not prepare the GitHub CLI config directory: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
		await this.#configReady;
	}

	async #run(
		args: readonly string[],
		options: { readonly timeoutMs?: number } = {},
	): Promise<GhCommandResult> {
		await this.#ready();
		return await this.#exec(args, {
			env: { ...processEnvironment(this.#configDir), GH_PROMPT_DISABLED: "1" },
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		});
	}

	#statusError(message: string, available: boolean): GitHubStatus {
		return {
			available,
			configured: false,
			error: boundedError(message),
			gitProtocol: null,
			host: this.#host,
			login: null,
			scopes: [],
		};
	}

	#dropSession(session: LoginSession): void {
		if (session.timer !== undefined) clearTimeout(session.timer);
		if (this.#login === session) this.#login = undefined;
	}

	#cancelLogin(): void {
		const session = this.#login;
		if (session === undefined) return;
		this.#dropSession(session);
		if (session.exitCode === null) session.process.kill();
	}
}
