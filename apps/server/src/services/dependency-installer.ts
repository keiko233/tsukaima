import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "../logging.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface DependencyInstallerExecResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export interface DependencyInstallerOptions {
	/**
	 * Override for process execution (used by tests).
	 */
	readonly exec?:
		| ((
				command: string,
				args: readonly string[],
				options: {
					readonly cwd: string;
					readonly env: Readonly<Record<string, string>>;
					readonly signal?: AbortSignal | undefined;
					readonly timeoutMs: number;
				},
		  ) => Promise<DependencyInstallerExecResult>)
		| undefined;
	readonly logger?: Logger | undefined;
	readonly repositoryRoot: string;
	readonly timeoutMs?: number | undefined;
}

function processEnvRecord(
	source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

async function defaultExec(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal | undefined;
		readonly timeoutMs: number;
	},
): Promise<DependencyInstallerExecResult> {
	return await new Promise<DependencyInstallerExecResult>((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			...(options.signal === undefined ? {} : { signal: options.signal }),
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
			reject(error);
		});
		child.on("close", (exitCode: number | null) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(
					new Error(
						`Command "${command} ${args.join(" ")}" timed out after ${options.timeoutMs}ms`,
					),
				);
				return;
			}
			resolve({ exitCode, stderr, stdout });
		});
	});
}

/**
 * Installs dependencies and regenerates workspace symlinks before an update restart.
 *
 * Runs `bun install --frozen-lockfile` in the repository root, falling back to `bun install`
 * if lockfile changes are detected. If installation fails, throws an error so the caller can
 * abort the restart instead of restarting into a crash loop.
 */
export class DependencyInstaller {
	readonly #exec: (
		command: string,
		args: readonly string[],
		options: {
			readonly cwd: string;
			readonly env: Readonly<Record<string, string>>;
			readonly signal?: AbortSignal | undefined;
			readonly timeoutMs: number;
		},
	) => Promise<DependencyInstallerExecResult>;
	readonly #logger: Logger | undefined;
	readonly #repositoryRoot: string;
	readonly #timeoutMs: number;

	constructor(options: DependencyInstallerOptions) {
		this.#exec = options.exec ?? defaultExec;
		this.#logger = options.logger?.child("tsukaima::server::deps");
		this.#repositoryRoot = options.repositoryRoot;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	get repositoryRoot(): string {
		return this.#repositoryRoot;
	}

	async install(options: { readonly signal?: AbortSignal | undefined } = {}): Promise<void> {
		const packageJsonPath = join(this.#repositoryRoot, "package.json");
		if (!(await Bun.file(packageJsonPath).exists())) {
			this.#logger?.debug(
				"package.json not found in repository root; skipping dependency installation",
				{ repositoryRoot: this.#repositoryRoot },
			);
			return;
		}

		const bunCommand = process.execPath || "bun";
		const env = {
			...processEnvRecord(process.env),
			CI: "1",
		};
		const timeoutMs = this.#timeoutMs;

		this.#logger?.info("installing dependencies with frozen lockfile", {
			command: `${bunCommand} install --frozen-lockfile`,
			repositoryRoot: this.#repositoryRoot,
		});

		const frozenResult = await this.#exec(bunCommand, ["install", "--frozen-lockfile"], {
			cwd: this.#repositoryRoot,
			env,
			timeoutMs,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});

		if (frozenResult.exitCode === 0) {
			this.#logger?.info("dependencies installed successfully with frozen lockfile", {
				repositoryRoot: this.#repositoryRoot,
			});
			return;
		}

		this.#logger?.warn("bun install --frozen-lockfile failed; attempting bun install fallback", {
			exitCode: frozenResult.exitCode,
			stderr: frozenResult.stderr.trim(),
			stdout: frozenResult.stdout.trim(),
		});

		const fallbackResult = await this.#exec(bunCommand, ["install"], {
			cwd: this.#repositoryRoot,
			env,
			timeoutMs,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});

		if (fallbackResult.exitCode === 0) {
			this.#logger?.info("dependencies installed successfully with fallback bun install", {
				repositoryRoot: this.#repositoryRoot,
			});
			return;
		}

		const detail =
			fallbackResult.stderr.trim() ||
			fallbackResult.stdout.trim() ||
			frozenResult.stderr.trim() ||
			frozenResult.stdout.trim() ||
			`exit code ${fallbackResult.exitCode}`;

		const message = `Dependency installation failed: ${detail}`;
		this.#logger?.error("dependency installation failed", {
			error: message,
			fallbackExitCode: fallbackResult.exitCode,
			frozenExitCode: frozenResult.exitCode,
		});
		throw new Error(message);
	}
}
