import { spawn, type SpawnOptions } from "node:child_process";

/**
 * Baseline environment for host-side command execution. Child processes never inherit the
 * server environment: self-iteration secrets (provider keys, channel tokens, admin credentials)
 * must not be reachable from a spawned command, and every execution site states its own
 * additions explicitly.
 */
export const SCRUBBED_COMMAND_ENV: Readonly<Record<string, string>> = Object.freeze({
	LANG: process.env.LANG ?? "C.UTF-8",
	PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
	TZ: process.env.TZ ?? "UTC",
});

import type { SandboxExecutor } from "./sandbox.ts";

export interface RunnerConfig {
	readonly allowedCommands: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Isolation boundary for the command. When set, every execution goes through it; a rejected
	 * provider fails the command instead of falling back to a plain `spawn`.
	 */
	readonly executor?: () => Promise<SandboxExecutor>;
	readonly maxOutputBytes: number;
	readonly timeoutMs: number;
	readonly worktreePath: string;
	/** Whether the sandbox may write inside `worktreePath`. */
	readonly writable?: boolean;
}

export interface CommandResult {
	readonly args: readonly string[];
	readonly command: string;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stderr: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
	readonly timedOut: boolean;
}

export class CommandRejectedError extends Error {
	constructor(command: string) {
		super(`Command "${command}" is not in the allowed command list`);
		this.name = "CommandRejectedError";
	}
}

export class CodingRunner {
	readonly #config: RunnerConfig;

	constructor(config: RunnerConfig) {
		this.#config = config;
	}

	get worktreePath(): string {
		return this.#config.worktreePath;
	}

	async exec(command: string, args: readonly string[] = []): Promise<CommandResult> {
		if (command.includes("/") || command.includes("\\")) {
			throw new CommandRejectedError(command);
		}
		if (!this.#config.allowedCommands.includes(command)) {
			throw new CommandRejectedError(command);
		}

		if (this.#config.executor !== undefined) {
			const executor = await this.#config.executor();
			return await executor.exec({
				args,
				command,
				cwd: this.#config.worktreePath,
				...(this.#config.env === undefined ? {} : { env: this.#config.env }),
				maxOutputBytes: this.#config.maxOutputBytes,
				timeoutMs: this.#config.timeoutMs,
				writable: this.#config.writable ?? false,
			});
		}

		return runManagedProcess({
			args,
			command,
			cwd: this.#config.worktreePath,
			env: this.#config.env ?? SCRUBBED_COMMAND_ENV,
			maxOutputBytes: this.#config.maxOutputBytes,
			timeoutMs: this.#config.timeoutMs,
		});
	}
}

export interface ManagedProcessOptions {
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly maxOutputBytes: number;
	readonly timeoutMs: number;
}

/**
 * Spawn one managed child process: piped stdio, bounded output, hard timeout, and an explicit
 * environment. Used by the host-side runner and the sandboxed runner so both share the same
 * process-supervision and output-capture semantics.
 */
export async function runManagedProcess(options: ManagedProcessOptions): Promise<CommandResult> {
	const { args, command, cwd, env, maxOutputBytes, timeoutMs } = options;
	const commandLabel = command.startsWith("/")
		? command.slice(command.lastIndexOf("/") + 1)
		: command;
	const startMs = performance.now();
	return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
		const spawnOptions: SpawnOptions = {
			cwd,
			env: { ...env },
			stdio: ["ignore", "pipe", "pipe"],
		};

		const child = spawn(command, [...args], spawnOptions);
		const stdoutStream = child.stdout;
		const stderrStream = child.stderr;
		if (!stdoutStream || !stderrStream) {
			rejectPromise(new Error("Expected stdout and stderr streams from pipe stdio"));
			return;
		}

		let timedOut = false;
		const stdoutChunks: Uint8Array[] = [];
		const stderrChunks: Uint8Array[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		stdoutStream.on("data", (chunk: Uint8Array) => {
			const collected = collectChunk(chunk, stdoutBytes, maxOutputBytes);
			if (collected.truncated) {
				stdoutTruncated = true;
			}
			stdoutChunks.push(collected.data);
			stdoutBytes += collected.data.length;
		});

		stderrStream.on("data", (chunk: Uint8Array) => {
			const collected = collectChunk(chunk, stderrBytes, maxOutputBytes);
			if (collected.truncated) {
				stderrTruncated = true;
			}
			stderrChunks.push(collected.data);
			stderrBytes += collected.data.length;
		});

		child.on("error", (error: Error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});

		child.on("close", (code: number | null, signal: string | null) => {
			clearTimeout(timer);
			const decoder = new TextDecoder("utf-8", { fatal: false });
			resolvePromise({
				args: [...args],
				command: commandLabel,
				durationMs: Math.round(performance.now() - startMs),
				exitCode: code,
				signal,
				stderr: decoder.decode(concatChunks(stderrChunks)),
				stderrTruncated,
				stdout: decoder.decode(concatChunks(stdoutChunks)),
				stdoutTruncated,
				timedOut,
			});
		});
	});
}

function collectChunk(
	chunk: Uint8Array,
	currentBytes: number,
	maxBytes: number,
): { data: Uint8Array; truncated: boolean } {
	if (currentBytes >= maxBytes) {
		return { data: new Uint8Array(0), truncated: chunk.length > 0 };
	}
	const remaining = maxBytes - currentBytes;
	if (chunk.length > remaining) {
		return { data: chunk.subarray(0, remaining), truncated: true };
	}
	return { data: chunk, truncated: false };
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}
