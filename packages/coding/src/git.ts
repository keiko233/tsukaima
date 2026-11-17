import { spawn } from "node:child_process";

/**
 * Host-side `git` execution for the governed repository surfaces.
 *
 * This is the only place the server spawns `git`. `argv` is always an array and never a shell
 * string, the binary is resolved by the operating system rather than by a caller-supplied path,
 * output is capped, and every call has a timeout. Callers that pass model-supplied values must
 * validate them first (`assertSafeBaseRef` in `worktree.ts`), because git parses options and
 * pathspecs out of `argv` itself.
 *
 * Unlike `runner.ts`, which scrubs the environment for commands a model can influence, host git
 * deliberately keeps the operator environment: `HOME`, the ssh agent socket, and credential
 * helpers are what make `fetch` and `push` work against a real remote. A caller holding a
 * short-lived credential passes it through `env`, scoped to that single invocation, so it never
 * reaches `.git/config`, a credentials file, or a log line.
 */

export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const GIT_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Environment that makes one network git call use a GitHub token.
 *
 * The rewrite matters inside a container: deployments often keep an SSH remote and an
 * operator-specific `core.sshCommand`, but the runtime image has no `ssh` binary and no deploy
 * key. GitHub's SSH and HTTPS endpoints address the same repository, so a token-bearing call can
 * transparently use HTTPS. The credential helper overrides any operator helper for this one
 * invocation only, and the token never reaches `argv`, `.git/config`, or the log.
 */
export function gitCredentialEnvironment(
	token: string | undefined,
): Record<string, string> | undefined {
	if (token === undefined || token.length === 0) return undefined;
	return {
		GH_TOKEN: token,
		GIT_CONFIG_COUNT: "3",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: "credential.helper",
		GIT_CONFIG_VALUE_1: "!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f",
		GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
		GIT_CONFIG_VALUE_2: "git@github.com:",
		GIT_TERMINAL_PROMPT: "0",
	};
}

export interface GitCliOptions {
	/** Base environment; defaults to the current process environment. */
	readonly baseEnv?: Readonly<Record<string, string>>;
	readonly maxOutputBytes?: number;
	readonly repositoryPath: string;
	readonly timeoutMs?: number;
}

export interface GitExecOptions {
	readonly cwd?: string;
	/** Merged over the base environment for this call only. */
	readonly env?: Readonly<Record<string, string>>;
	readonly maxOutputBytes?: number;
	readonly timeoutMs?: number;
}

export interface GitCommandResult {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
	readonly timedOut: boolean;
}

export class GitCommandError extends Error {
	readonly args: readonly string[];
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;

	constructor(message: string, result: GitCommandResult) {
		super(message);
		this.name = "GitCommandError";
		this.args = result.args;
		this.exitCode = result.exitCode;
		this.stderr = result.stderr;
		this.timedOut = result.timedOut;
	}
}

/** Copy a `process.env`-shaped record, dropping entries the runtime left undefined. */
export function processEnvRecord(
	source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

export class GitCli {
	readonly #baseEnv: Readonly<Record<string, string>>;
	readonly #maxOutputBytes: number;
	readonly #repositoryPath: string;
	readonly #timeoutMs: number;

	constructor(options: GitCliOptions) {
		this.#baseEnv = options.baseEnv ?? processEnvRecord(process.env);
		this.#maxOutputBytes = options.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES;
		this.#repositoryPath = options.repositoryPath;
		this.#timeoutMs = options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
	}

	get repositoryPath(): string {
		return this.#repositoryPath;
	}

	async exec(args: readonly string[], options: GitExecOptions = {}): Promise<GitCommandResult> {
		if (args.length === 0) {
			throw new Error("git requires at least one argument");
		}
		for (const arg of args) {
			if (arg.includes("\0")) {
				throw new Error("git arguments must not contain null bytes");
			}
		}
		const cwd = options.cwd ?? this.#repositoryPath;
		const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
		const maxOutputBytes = options.maxOutputBytes ?? this.#maxOutputBytes;
		const env = { ...this.#baseEnv, ...options.env };
		const startedAt = performance.now();
		return await new Promise<GitCommandResult>((resolvePromise, rejectPromise) => {
			const child = spawn("git", [...args], {
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.stdout?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				if (stdout.length >= maxOutputBytes) {
					stdoutTruncated = true;
					return;
				}
				stdout += text.slice(0, maxOutputBytes - stdout.length);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				if (stderr.length >= maxOutputBytes) {
					stderrTruncated = true;
					return;
				}
				stderr += text.slice(0, maxOutputBytes - stderr.length);
			});
			child.on("error", (error: Error) => {
				clearTimeout(timer);
				rejectPromise(error);
			});
			child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
				clearTimeout(timer);
				resolvePromise({
					args: [...args],
					cwd,
					durationMs: Math.round(performance.now() - startedAt),
					exitCode,
					signal,
					stderr,
					stderrTruncated,
					stdout,
					stdoutTruncated,
					timedOut,
				});
			});
		});
	}

	/** Run a command and return its stdout, throwing `GitCommandError` on a non-zero exit. */
	async run(args: readonly string[], options: GitExecOptions = {}): Promise<string> {
		const result = await this.exec(args, options);
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
			throw new GitCommandError(`git ${args[0] ?? ""} failed: ${detail}`, result);
		}
		return result.stdout;
	}

	/**
	 * Run a command that is expected to fail in ordinary operation (for example `rev-parse` on a
	 * repository with no upstream). Returns stdout on success and `undefined` on a non-zero exit;
	 * a spawn failure still rejects.
	 */
	async tryRun(args: readonly string[], options: GitExecOptions = {}): Promise<string | undefined> {
		const result = await this.exec(args, options);
		return result.exitCode === 0 ? result.stdout : undefined;
	}
}
