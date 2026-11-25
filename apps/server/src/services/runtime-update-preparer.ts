import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GitCli } from "@tsukaima/coding";
import type { Logger } from "../logging.ts";
import type { DependencyInstallerExecResult } from "./dependency-installer.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type RuntimeUpdatePreparerExec = (
	command: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal | undefined;
		readonly timeoutMs: number;
	},
) => Promise<DependencyInstallerExecResult>;

export interface RuntimeUpdatePreparerOptions {
	readonly dependencyInstaller: Pick<RuntimeDependencyInstaller, "install">;
	/**
	 * Override for process execution (used by tests).
	 */
	readonly exec?: RuntimeUpdatePreparerExec | undefined;
	readonly logger?: Logger | undefined;
	readonly repositoryRoot: string;
	readonly timeoutMs?: number | undefined;
	readonly webDistDir: string;
}

interface RuntimeDependencyInstaller {
	install(options?: { readonly signal?: AbortSignal | undefined }): Promise<void>;
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
	return await new Promise<DependencyInstallerExecResult>((resolvePromise, rejectPromise) => {
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
			rejectPromise(error);
		});
		child.on("close", (exitCode: number | null) => {
			clearTimeout(timer);
			if (timedOut) {
				rejectPromise(
					new Error(
						`Command "${command} ${args.join(" ")}" timed out after ${options.timeoutMs}ms`,
					),
				);
				return;
			}
			resolvePromise({ exitCode, stderr, stdout });
		});
	});
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function fileHash(path: string): Promise<string> {
	const bytes = await Bun.file(path).bytes();
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Prepares an in-container runtime update: install dependencies and rebuild the WebUI.
 *
 * The WebUI build happens in a sibling staging directory and is swapped in with a rename, so
 * a failed build never leaves a half-written `dist` behind while the server keeps serving it.
 * Repeated `prepare()` calls for the same checkout revision are coalesced, because both the
 * upgrade service and the restart coordinator prepare the same update minutes apart.
 */
export class RuntimeUpdatePreparer {
	readonly #dependencyInstaller: RuntimeDependencyInstaller;
	readonly #exec: RuntimeUpdatePreparerExec;
	readonly #gitCli: GitCli;
	readonly #logger: Logger | undefined;
	readonly #repositoryRoot: string;
	readonly #timeoutMs: number;
	readonly #webDistDir: string;
	#preparedKey: string | undefined;
	#tail: Promise<void> = Promise.resolve();

	constructor(options: RuntimeUpdatePreparerOptions) {
		this.#dependencyInstaller = options.dependencyInstaller;
		this.#exec = options.exec ?? defaultExec;
		this.#gitCli = new GitCli({ repositoryPath: options.repositoryRoot });
		this.#logger = options.logger?.child("tsukaima::server::prepare");
		this.#repositoryRoot = options.repositoryRoot;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#webDistDir = resolve(options.webDistDir);
	}

	async prepare(options: { readonly signal?: AbortSignal | undefined } = {}): Promise<void> {
		const run = async () => await this.#prepareOnce(options);
		const current = this.#tail.then(run, run);
		this.#tail = current.catch(() => undefined);
		await current;
	}

	async #prepareOnce(options: { readonly signal?: AbortSignal | undefined }): Promise<void> {
		const key = await this.#revisionKey();
		if (key !== undefined && key === this.#preparedKey && (await this.#distReady())) {
			this.#logger?.debug("runtime update preparation already completed for this revision", {
				key,
			});
			return;
		}

		await this.#dependencyInstaller.install(
			options.signal === undefined ? {} : { signal: options.signal },
		);

		if (await this.#hasWebApp()) {
			await this.#buildWebUi(options);
		}

		if (key !== undefined) this.#preparedKey = key;
	}

	async #hasWebApp(): Promise<boolean> {
		return await pathExists(join(this.#repositoryRoot, "apps/web/package.json"));
	}

	async #distReady(): Promise<boolean> {
		if (!(await this.#hasWebApp())) return true;
		return await pathExists(join(this.#webDistDir, "index.html"));
	}

	/**
	 * The revision key ties a successful preparation to the exact checkout, lockfile, and dist
	 * target. A new commit or a changed lockfile must run the install/build again.
	 */
	async #revisionKey(): Promise<string | undefined> {
		const head = await this.#gitCli.exec(["rev-parse", "HEAD"], {
			timeoutMs: Math.min(this.#timeoutMs, 15_000),
		});
		if (head.exitCode !== 0) return undefined;
		const commit = head.stdout.trim();
		if (commit.length === 0) return undefined;
		const lockfilePath = join(this.#repositoryRoot, "bun.lock");
		const lockHash = (await pathExists(lockfilePath)) ? await fileHash(lockfilePath) : "";
		return `${commit}:${lockHash}:${this.#webDistDir}`;
	}

	async #buildWebUi(options: { readonly signal?: AbortSignal | undefined }): Promise<void> {
		const appDir = join(this.#repositoryRoot, "apps/web");
		const bunCommand = process.execPath || "bun";
		const env: Record<string, string> = {
			...processEnvRecord(process.env),
			CI: "1",
		};
		// Docker sets NODE_ENV=production, which hides the devDependencies a build needs.
		delete env.NODE_ENV;
		const signal = options.signal;

		this.#logger?.info("building WebUI for runtime update", {
			repositoryRoot: this.#repositoryRoot,
			webDistDir: this.#webDistDir,
		});
		await this.#run(bunCommand, ["run", "i18n:plugins"], {
			cwd: appDir,
			env,
			timeoutMs: this.#timeoutMs,
			...(signal === undefined ? {} : { signal }),
		});

		const stagingDir = join(dirname(this.#webDistDir), `.dist-staging-${randomUUID()}`);
		let backupDir: string | undefined;
		try {
			await mkdir(stagingDir, { recursive: true });
			await this.#run(
				bunCommand,
				["run", "vite", "build", "--outDir", stagingDir, "--emptyOutDir"],
				{
					cwd: appDir,
					env,
					timeoutMs: this.#timeoutMs,
					...(signal === undefined ? {} : { signal }),
				},
			);

			if (!(await pathExists(join(stagingDir, "index.html")))) {
				throw new Error("WebUI build did not produce an index.html");
			}

			await mkdir(dirname(this.#webDistDir), { recursive: true });
			if (await pathExists(this.#webDistDir)) {
				backupDir = join(dirname(this.#webDistDir), `.dist-backup-${randomUUID()}`);
				await rename(this.#webDistDir, backupDir);
			}
			try {
				await rename(stagingDir, this.#webDistDir);
			} catch (error) {
				if (backupDir !== undefined) {
					try {
						await rename(backupDir, this.#webDistDir);
						backupDir = undefined;
					} catch (restoreError) {
						throw new Error(
							`WebUI dist swap failed and the previous dist could not be restored: ${
								restoreError instanceof Error ? restoreError.message : String(restoreError)
							}; swap error: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: restoreError },
						);
					}
				}
				throw error;
			}
			if (backupDir !== undefined) {
				try {
					await rm(backupDir, { force: true, recursive: true });
				} catch (error) {
					this.#logger?.warn("failed to remove previous WebUI dist backup", {
						backupDir,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			this.#logger?.info("WebUI rebuilt for runtime update", { webDistDir: this.#webDistDir });
		} finally {
			// A leftover staging directory would untrack the checkout and block later upgrades.
			try {
				await rm(stagingDir, { force: true, recursive: true });
			} catch (error) {
				this.#logger?.warn("failed to remove WebUI staging directory", {
					error: error instanceof Error ? error.message : String(error),
					stagingDir,
				});
			}
		}
	}

	async #run(
		command: string,
		args: readonly string[],
		options: {
			readonly cwd: string;
			readonly env: Readonly<Record<string, string>>;
			readonly signal?: AbortSignal | undefined;
			readonly timeoutMs: number;
		},
	): Promise<void> {
		const result = await this.#exec(command, args, options);
		if (result.exitCode === 0) return;
		const detail =
			result.stderr.trim() ||
			result.stdout.trim() ||
			(result.exitCode === null ? "command did not exit" : `exit code ${result.exitCode}`);
		throw new Error(`Command "${command} ${args.join(" ")}" failed: ${detail}`);
	}
}
