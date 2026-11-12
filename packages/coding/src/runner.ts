import { spawn, type SpawnOptions } from "node:child_process";

export interface RunnerConfig {
	readonly allowedCommands: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly maxOutputBytes: number;
	readonly timeoutMs: number;
	readonly worktreePath: string;
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

		const startMs = performance.now();
		return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
			const spawnOptions: SpawnOptions = {
				cwd: this.#config.worktreePath,
				stdio: ["ignore", "pipe", "pipe"],
			};
			if (this.#config.env !== undefined) {
				spawnOptions.env = { ...this.#config.env };
			}

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
			}, this.#config.timeoutMs);

			stdoutStream.on("data", (chunk: Uint8Array) => {
				const collected = collectChunk(chunk, stdoutBytes, this.#config.maxOutputBytes);
				if (collected.truncated) {
					stdoutTruncated = true;
				}
				stdoutChunks.push(collected.data);
				stdoutBytes += collected.data.length;
			});

			stderrStream.on("data", (chunk: Uint8Array) => {
				const collected = collectChunk(chunk, stderrBytes, this.#config.maxOutputBytes);
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
					command,
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
