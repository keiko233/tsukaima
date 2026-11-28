import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAuditApi, PluginLogger } from "@tsukaima/sdk";
import type { AcpPreset } from "./config.ts";
import type { AcpPathBinaryResolver } from "./installer.ts";

const STATUS_TIMEOUT_MS = 10_000;
const INITIAL_OUTPUT_WAIT_MS = 3_000;
const LOGIN_LIFETIME_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;
// Built from a code point so the linter's control-character rule only sees ordinary source.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export type AcpAuthPreset = Exclude<AcpPreset, "custom">;

export type AcpAuthLoginState = "authorized" | "expired" | "failed" | "idle" | "pending";

export interface AcpAuthSpec {
	readonly binaryName: string;
	readonly displayName: string;
	readonly loginArgs: readonly string[];
	readonly preset: AcpAuthPreset;
	readonly statusArgs?: readonly string[];
}

export const ACP_AUTH_SPECS: Readonly<Record<AcpAuthPreset, AcpAuthSpec>> = {
	antigravity: {
		binaryName: "agy",
		displayName: "Antigravity (agy)",
		loginArgs: ["acp", "--login"],
		preset: "antigravity",
	},
	"claude-code": {
		binaryName: "claude",
		displayName: "Claude Code (claude)",
		loginArgs: ["auth", "login"],
		preset: "claude-code",
		statusArgs: ["auth", "status", "--json"],
	},
	codex: {
		binaryName: "codex",
		displayName: "Codex (codex)",
		loginArgs: ["login", "--device-auth"],
		preset: "codex",
		statusArgs: ["login", "status"],
	},
};

export interface AcpAuthProviderStatus {
	readonly authenticated: boolean | null;
	readonly available: boolean;
	readonly binaryName: string;
	readonly binaryPath?: string;
	readonly detail?: string;
	readonly displayName: string;
	readonly loginPending: boolean;
	readonly preset: AcpAuthPreset;
}

export interface AcpAuthStatusSnapshot {
	readonly providers: readonly AcpAuthProviderStatus[];
}

export interface AcpAuthLoginResult {
	readonly message?: string;
	readonly output?: string;
	readonly preset: AcpAuthPreset;
	readonly status: AcpAuthLoginState;
	readonly userCode?: string;
	readonly verificationUri?: string;
}

export interface AcpAuthCommandResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export interface AcpAuthLoginProcess {
	readonly exitCode: number | null;
	kill(): void;
	onError(listener: (error: Error) => void): void;
	onExit(listener: (exitCode: number | null) => void): void;
	onOutput(listener: (chunk: string) => void): void;
}

export interface AcpAuthServiceOptions {
	readonly audit?: PluginAuditApi;
	readonly exec?: (
		command: string,
		args: readonly string[],
		options: { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
	) => Promise<AcpAuthCommandResult>;
	readonly initialWaitMs?: number;
	readonly loginLifetimeMs?: number;
	readonly logger?: PluginLogger;
	readonly now?: () => number;
	readonly pathEnv?: string;
	readonly resolvePathBinary?: AcpPathBinaryResolver;
	readonly spawnLogin?: (
		command: string,
		args: readonly string[],
		options: { readonly env: Readonly<Record<string, string>> },
	) => AcpAuthLoginProcess;
	readonly toolsRootDir: string;
}

interface ActiveLoginSession {
	error?: string;
	exitCode: number | null;
	readonly expiresAtMs: number;
	output: string;
	readonly preset: AcpAuthPreset;
	readonly process: AcpAuthLoginProcess;
	status: AcpAuthLoginState;
	timer: ReturnType<typeof setTimeout> | undefined;
	userCode: string | undefined;
	verificationUri: string | undefined;
}

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export function parseAuthOutput(output: string): {
	readonly userCode?: string;
	readonly verificationUri?: string;
} {
	const text = stripAnsi(output);
	const urlMatch = /(https?:\/\/[^\s"'<>)\]]+)/u.exec(text);
	const verificationUri = urlMatch?.[1]?.replace(/[.,;:]+$/u, "");
	const codeMatch =
		/(?:one-time code|enter (?:the )?code|user code|device code|code)[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+)/iu.exec(
			text,
		) ?? /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/u.exec(text);
	const userCode = codeMatch?.[1]?.trim();
	return {
		...(userCode === undefined || userCode.length === 0 ? {} : { userCode }),
		...(verificationUri === undefined || verificationUri.length === 0 ? {} : { verificationUri }),
	};
}

export function parseAuthStatusOutput(
	preset: AcpAuthPreset,
	result: AcpAuthCommandResult,
): { readonly authenticated: boolean | null; readonly detail?: string } {
	const combined = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
	if (preset === "claude-code") {
		try {
			const parsed: unknown = JSON.parse(result.stdout.trim());
			if (typeof parsed === "object" && parsed !== null) {
				const record = parsed as Record<string, unknown>;
				if (typeof record.loggedIn === "boolean") {
					const email = typeof record.email === "string" ? record.email : undefined;
					const authMethod = typeof record.authMethod === "string" ? record.authMethod : undefined;
					const detail = [email, authMethod].filter(Boolean).join(" · ");
					return {
						authenticated: record.loggedIn,
						...(detail.length === 0 ? {} : { detail }),
					};
				}
			}
		} catch {
			// Fall back to exit code / plain text parsing below.
		}
	}
	if (result.exitCode === 0) {
		const lower = combined.toLowerCase();
		if (lower.includes("not logged in") || lower.includes("logged out")) {
			return {
				authenticated: false,
				...(combined.length === 0 ? {} : { detail: firstLine(combined) }),
			};
		}
		return {
			authenticated: true,
			...(combined.length === 0 ? {} : { detail: firstLine(combined) }),
		};
	}
	return {
		authenticated: false,
		...(combined.length === 0 ? {} : { detail: firstLine(combined) }),
	};
}

export class AcpAuthService {
	readonly #audit: PluginAuditApi | undefined;
	readonly #exec: NonNullable<AcpAuthServiceOptions["exec"]>;
	readonly #initialWaitMs: number;
	readonly #loginLifetimeMs: number;
	readonly #logger: PluginLogger | undefined;
	readonly #now: () => number;
	readonly #pathEnv: string;
	readonly #resolvePathBinary: AcpPathBinaryResolver;
	readonly #sessions = new Map<AcpAuthPreset, ActiveLoginSession>();
	readonly #spawnLogin: NonNullable<AcpAuthServiceOptions["spawnLogin"]>;
	readonly #toolsRootDir: string;

	constructor(options: AcpAuthServiceOptions) {
		this.#audit = options.audit;
		this.#exec = options.exec ?? defaultAuthExec;
		this.#initialWaitMs = options.initialWaitMs ?? INITIAL_OUTPUT_WAIT_MS;
		this.#loginLifetimeMs = options.loginLifetimeMs ?? LOGIN_LIFETIME_MS;
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
		this.#pathEnv = options.pathEnv ?? process.env.PATH ?? "";
		this.#toolsRootDir = options.toolsRootDir;
		this.#resolvePathBinary =
			options.resolvePathBinary ??
			((binaryName) => Bun.which(binaryName, { PATH: this.#pathEnv }) ?? undefined);
		this.#spawnLogin = options.spawnLogin ?? defaultSpawnLogin;
	}

	async status(preset?: AcpAuthPreset): Promise<AcpAuthStatusSnapshot> {
		const targets: readonly AcpAuthPreset[] =
			preset === undefined ? (["antigravity", "codex", "claude-code"] as const) : [preset];
		const providers = await Promise.all(targets.map((target) => this.#inspectProvider(target)));
		return { providers };
	}

	async startLogin(preset: AcpAuthPreset): Promise<AcpAuthLoginResult> {
		const spec = ACP_AUTH_SPECS[preset];
		const binaryPath = await this.#findBinary(spec.binaryName);
		if (binaryPath === undefined) {
			return {
				message: `${spec.displayName} (${spec.binaryName}) is not installed.`,
				preset,
				status: "failed",
			};
		}

		this.#cancelSession(preset);

		const env = this.#buildEnv();
		const proc = this.#spawnLogin(binaryPath, spec.loginArgs, { env });
		const session: ActiveLoginSession = {
			exitCode: proc.exitCode,
			expiresAtMs: this.#now() + this.#loginLifetimeMs,
			output: "",
			preset,
			process: proc,
			status: "pending",
			timer: undefined,
			userCode: undefined,
			verificationUri: undefined,
		};
		this.#sessions.set(preset, session);

		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const updateParsed = () => {
			const parsed = parseAuthOutput(session.output);
			if (parsed.verificationUri !== undefined) session.verificationUri = parsed.verificationUri;
			if (parsed.userCode !== undefined) session.userCode = parsed.userCode;
			if (
				session.verificationUri !== undefined &&
				(preset !== "codex" || session.userCode !== undefined)
			) {
				resolveReady();
			}
		};

		proc.onOutput((chunk) => {
			if (session.output.length < MAX_OUTPUT_CHARS) {
				session.output += chunk.slice(0, MAX_OUTPUT_CHARS - session.output.length);
			}
			updateParsed();
		});

		proc.onError((error) => {
			if (session.status === "pending") {
				session.status = "failed";
				session.error = error.message;
			}
			clearTimeout(session.timer);
			resolveReady();
		});

		proc.onExit((exitCode) => {
			session.exitCode = exitCode;
			clearTimeout(session.timer);
			if (session.status === "pending") {
				if (exitCode === 0) {
					session.status = "authorized";
				} else {
					session.status = "failed";
					session.error =
						firstLine(stripAnsi(session.output)) ||
						`Login exited with code ${exitCode ?? "unknown"}`;
				}
			}
			resolveReady();
		});

		session.timer = setTimeout(() => {
			if (session.status === "pending") {
				session.status = "expired";
				try {
					proc.kill();
				} catch {
					// Ignore already-exited process.
				}
			}
		}, this.#loginLifetimeMs);

		await Promise.race([
			ready,
			new Promise<void>((resolve) => setTimeout(resolve, this.#initialWaitMs)),
		]);

		await this.#recordAudit("acp.auth.login_start", preset, session.status);
		this.#logger?.info("ACP auth login started", { preset, status: session.status });
		return this.#toLoginResult(session);
	}

	pollLogin(preset: AcpAuthPreset): AcpAuthLoginResult {
		const session = this.#sessions.get(preset);
		if (session === undefined) {
			return { preset, status: "idle" };
		}
		if (session.status === "pending" && this.#now() >= session.expiresAtMs) {
			session.status = "expired";
			clearTimeout(session.timer);
			try {
				session.process.kill();
			} catch {
				// Ignore already-exited process.
			}
		}
		const result = this.#toLoginResult(session);
		if (session.status !== "pending") {
			this.#sessions.delete(preset);
		}
		return result;
	}

	cancelLogin(preset: AcpAuthPreset): AcpAuthLoginResult {
		this.#cancelSession(preset);
		return { preset, status: "idle" };
	}

	dispose(): void {
		for (const preset of this.#sessions.keys()) {
			this.#cancelSession(preset);
		}
	}

	#cancelSession(preset: AcpAuthPreset): void {
		const existing = this.#sessions.get(preset);
		if (existing === undefined) return;
		clearTimeout(existing.timer);
		this.#sessions.delete(preset);
		if (existing.status === "pending") {
			try {
				existing.process.kill();
			} catch {
				// Ignore already-exited process.
			}
		}
	}

	#toLoginResult(session: ActiveLoginSession): AcpAuthLoginResult {
		const cleaned = stripAnsi(session.output).trim();
		return {
			preset: session.preset,
			status: session.status,
			...(session.error === undefined ? {} : { message: session.error }),
			...(cleaned.length === 0 ? {} : { output: cleaned }),
			...(session.userCode === undefined ? {} : { userCode: session.userCode }),
			...(session.verificationUri === undefined
				? {}
				: { verificationUri: session.verificationUri }),
		};
	}

	async #inspectProvider(preset: AcpAuthPreset): Promise<AcpAuthProviderStatus> {
		const spec = ACP_AUTH_SPECS[preset];
		const binaryPath = await this.#findBinary(spec.binaryName);
		const loginPending = this.#sessions.get(preset)?.status === "pending";
		if (binaryPath === undefined) {
			return {
				authenticated: null,
				available: false,
				binaryName: spec.binaryName,
				displayName: spec.displayName,
				loginPending,
				preset,
			};
		}
		if (spec.statusArgs === undefined) {
			return {
				authenticated: null,
				available: true,
				binaryName: spec.binaryName,
				binaryPath,
				displayName: spec.displayName,
				loginPending,
				preset,
			};
		}
		try {
			const result = await this.#exec(binaryPath, spec.statusArgs, {
				env: this.#buildEnv(),
				timeoutMs: STATUS_TIMEOUT_MS,
			});
			const parsed = parseAuthStatusOutput(preset, result);
			return {
				authenticated: parsed.authenticated,
				available: true,
				binaryName: spec.binaryName,
				binaryPath,
				...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
				displayName: spec.displayName,
				loginPending,
				preset,
			};
		} catch (error) {
			return {
				authenticated: null,
				available: true,
				binaryName: spec.binaryName,
				binaryPath,
				detail: error instanceof Error ? error.message : String(error),
				displayName: spec.displayName,
				loginPending,
				preset,
			};
		}
	}

	#buildEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) env[key] = value;
		}
		const managedDirs = [
			join(this.#toolsRootDir, "bin"),
			join(this.#toolsRootDir, "node_modules", ".bin"),
		];
		const sep = process.platform === "win32" ? ";" : ":";
		env.PATH = [...managedDirs, ...(this.#pathEnv.length > 0 ? [this.#pathEnv] : [])].join(sep);
		env.NO_COLOR = "1";
		return env;
	}

	async #findBinary(binaryName: string): Promise<string | undefined> {
		const binDirs = [
			join(this.#toolsRootDir, "bin"),
			join(this.#toolsRootDir, "node_modules", ".bin"),
		];
		const candidates =
			process.platform === "win32"
				? [binaryName, `${binaryName}.cmd`, `${binaryName}.exe`]
				: [binaryName];
		for (const binDir of binDirs) {
			for (const candidate of candidates) {
				const candidatePath = join(binDir, candidate);
				if (await isRegularFile(candidatePath)) return candidatePath;
			}
		}
		try {
			const resolved = await this.#resolvePathBinary(binaryName);
			if (resolved !== undefined && (await isRegularFile(resolved))) return resolved;
		} catch {
			// Ignore lookup failures.
		}
		return undefined;
	}

	async #recordAudit(
		action: string,
		preset: AcpAuthPreset,
		status: AcpAuthLoginState,
	): Promise<void> {
		if (this.#audit === undefined) return;
		try {
			await this.#audit.record({
				action,
				actorKind: "user",
				payload: { preset, status },
				reason: `ACP CLI login (${preset}): ${status}`,
				result: status === "failed" ? "failed" : "ok",
				targetId: preset,
				targetKind: "acp-auth",
			});
		} catch {
			// Ignore audit failures.
		}
	}
}

function firstLine(value: string): string {
	return (
		value
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	).slice(0, 240);
}

async function isRegularFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function defaultAuthExec(
	command: string,
	args: readonly string[],
	options: { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
): Promise<AcpAuthCommandResult> {
	return await new Promise<AcpAuthCommandResult>((resolvePromise, rejectPromise) => {
		const child = spawn(command, [...args], {
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_CHARS) {
				stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stdout.length);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT_CHARS) {
				stderr += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stderr.length);
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			if (timedOut) {
				rejectPromise(new Error(`Command timed out after ${options.timeoutMs}ms`));
				return;
			}
			resolvePromise({ exitCode, stderr, stdout });
		});
	});
}

function defaultSpawnLogin(
	command: string,
	args: readonly string[],
	options: { readonly env: Readonly<Record<string, string>> },
): AcpAuthLoginProcess {
	const child = spawn(command, [...args], {
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
			child.on("close", (exitCode) => listener(exitCode));
		},
		onOutput: (listener) => {
			child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
			child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
		},
	};
}
