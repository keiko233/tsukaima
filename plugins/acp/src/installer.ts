import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PluginAuditApi, PluginLogger } from "@tsukaima/sdk";
import { ACP_RUNTIME_PACKAGES, type AcpPreset, type AcpRuntimePackageSpec } from "./config.ts";

const VERSION_TIMEOUT_MS = 3_000;
const INSTALL_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 4_000;
const TOOLS_PACKAGE_NAME = "tsukaima-acp-tools";
const PACKAGE_SPEC_PATTERN =
	/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[A-Za-z0-9._^~>=<+-]+)?$/u;

const MANAGED_PACKAGES = new Set(ACP_RUNTIME_PACKAGES.flatMap((spec) => spec.packages));

export type AcpRuntimeBinarySource = "managed" | "none" | "system";

export interface AcpRuntimeBinaryStatus {
	readonly id: string;
	readonly displayName: string;
	readonly binaryName: string;
	readonly preset: AcpPreset;
	readonly packages: readonly string[];
	readonly installMethod: "bun" | "system";
	readonly source: AcpRuntimeBinarySource;
	readonly binaryPath?: string;
	readonly version?: string;
	readonly installHint?: string;
}

export interface AcpCustomPackageStatus {
	readonly packageName: string;
	readonly versionSpec: string;
	readonly binaryName: string;
	readonly source: AcpRuntimeBinarySource;
	readonly binaryPath?: string;
	readonly version?: string;
}

export interface AcpRuntimeStatusSnapshot {
	readonly toolsRootDir: string;
	readonly runtimes: readonly AcpRuntimeBinaryStatus[];
	readonly customPackages: readonly AcpCustomPackageStatus[];
}

export interface CommandExecOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface CommandExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type CommandExecFn = (
	command: string,
	args: readonly string[],
	options: CommandExecOptions,
) => Promise<CommandExecResult>;

export type AcpPathBinaryResolver = (
	binaryName: string,
) => Promise<string | undefined> | string | undefined;

export interface AcpRuntimeInstallerOptions {
	readonly toolsRootDir: string;
	readonly exec?: CommandExecFn;
	readonly logger?: PluginLogger;
	readonly audit?: PluginAuditApi;
	readonly pathEnv?: string;
	readonly resolvePathBinary?: AcpPathBinaryResolver;
}

export interface AcpRuntimeInstallInput {
	readonly id?: string;
	readonly packageName?: string;
	readonly signal?: AbortSignal;
}

export type AcpRuntimeUninstallInput = AcpRuntimeInstallInput;

export interface AcpRuntimeOperationResult {
	readonly ok: boolean;
	readonly message: string;
	readonly id?: string;
	readonly packageName?: string;
	readonly packages?: readonly string[];
	readonly requiresManualInstall?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
}

interface BinaryProbe {
	readonly source: AcpRuntimeBinarySource;
	readonly binaryPath?: string;
	readonly version?: string;
}

export class AcpRuntimeInstaller {
	readonly #audit: PluginAuditApi | undefined;
	readonly #exec: CommandExecFn;
	readonly #logger: PluginLogger | undefined;
	readonly #resolvePathBinary: AcpPathBinaryResolver;
	readonly #toolsRootDir: string;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: AcpRuntimeInstallerOptions) {
		this.#audit = options.audit;
		this.#exec = options.exec ?? defaultCommandExec;
		this.#logger = options.logger;
		this.#toolsRootDir = options.toolsRootDir;
		const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
		this.#resolvePathBinary =
			options.resolvePathBinary ??
			((binaryName) => Bun.which(binaryName, { PATH: pathEnv }) ?? undefined);
	}

	async status(): Promise<AcpRuntimeStatusSnapshot> {
		const [runtimes, customPackages] = await Promise.all([
			Promise.all(ACP_RUNTIME_PACKAGES.map((spec) => this.#probeRuntime(spec))),
			this.#listCustomPackages(),
		]);
		return { customPackages, runtimes, toolsRootDir: this.#toolsRootDir };
	}

	async install(input: AcpRuntimeInstallInput): Promise<AcpRuntimeOperationResult> {
		return await this.#withLock(async () => await this.#install(input));
	}

	async uninstall(input: AcpRuntimeUninstallInput): Promise<AcpRuntimeOperationResult> {
		return await this.#withLock(async () => await this.#uninstall(input));
	}

	async #install(input: AcpRuntimeInstallInput): Promise<AcpRuntimeOperationResult> {
		const id = normalizeOptional(input.id);
		const packageName = normalizeOptional(input.packageName);
		let result: AcpRuntimeOperationResult;
		let auditTarget: string;
		let auditPackages: readonly string[];

		if (id !== undefined) {
			const spec = ACP_RUNTIME_PACKAGES.find((candidate) => candidate.id === id);
			if (spec === undefined) {
				result = failure(`Unknown ACP runtime id: ${id}`);
				auditTarget = id;
				auditPackages = [];
			} else if (spec.installMethod === "system") {
				result = {
					id: spec.id,
					message:
						spec.installHint ??
						`${spec.displayName} is installed by the operating system; use the OS package manager.`,
					ok: false,
					packages: spec.packages,
					requiresManualInstall: true,
				};
				auditTarget = spec.id;
				auditPackages = spec.packages;
			} else {
				const commandResult = await this.#runPackageCommand("add", spec.packages, input.signal);
				result = { ...commandResult, id: spec.id };
				auditTarget = spec.id;
				auditPackages = spec.packages;
			}
		} else if (packageName !== undefined) {
			if (!isValidPackageSpec(packageName)) {
				result = failure(`Invalid npm package name: ${packageName}`);
			} else {
				const commandResult = await this.#runPackageCommand("add", [packageName], input.signal);
				result = { ...commandResult, packageName };
			}
			auditTarget = packageName;
			auditPackages = [packageName];
		} else {
			result = failure("Provide a runtime id or an npm package name to install.");
			auditTarget = "unknown";
			auditPackages = [];
		}

		await this.#recordAudit("acp.runtime.install", auditTarget, auditPackages, result);
		this.#logOperation("install", auditTarget, result);
		return result;
	}

	async #uninstall(input: AcpRuntimeUninstallInput): Promise<AcpRuntimeOperationResult> {
		const id = normalizeOptional(input.id);
		const packageName = normalizeOptional(input.packageName);
		let result: AcpRuntimeOperationResult;
		let auditTarget: string;
		let auditPackages: readonly string[];

		if (id !== undefined) {
			const spec = ACP_RUNTIME_PACKAGES.find((candidate) => candidate.id === id);
			if (spec === undefined) {
				result = failure(`Unknown ACP runtime id: ${id}`);
				auditTarget = id;
				auditPackages = [];
			} else if (spec.installMethod === "system") {
				result = {
					id: spec.id,
					message: `${spec.displayName} is a system-installed binary; uninstall it with your OS package manager.`,
					ok: false,
					packages: spec.packages,
					requiresManualInstall: true,
				};
				auditTarget = spec.id;
				auditPackages = spec.packages;
			} else {
				const commandResult = await this.#runPackageCommand("remove", spec.packages, input.signal);
				result = { ...commandResult, id: spec.id };
				auditTarget = spec.id;
				auditPackages = spec.packages;
			}
		} else if (packageName !== undefined) {
			if (!isValidPackageSpec(packageName)) {
				result = failure(`Invalid npm package name: ${packageName}`);
			} else {
				const commandResult = await this.#runPackageCommand("remove", [packageName], input.signal);
				result = { ...commandResult, packageName };
			}
			auditTarget = packageName;
			auditPackages = [packageName];
		} else {
			result = failure("Provide a runtime id or an npm package name to uninstall.");
			auditTarget = "unknown";
			auditPackages = [];
		}

		await this.#recordAudit("acp.runtime.uninstall", auditTarget, auditPackages, result);
		this.#logOperation("uninstall", auditTarget, result);
		return result;
	}

	async #runPackageCommand(
		action: "add" | "remove",
		packages: readonly string[],
		signal: AbortSignal | undefined,
	): Promise<AcpRuntimeOperationResult> {
		if (packages.length === 0) {
			return failure(`No packages to ${action === "add" ? "install" : "remove"}.`);
		}
		try {
			await this.#ensureToolsPackageJson();
		} catch (error) {
			return failure(`Unable to prepare ${this.#toolsRootDir}: ${errorMessage(error)}`);
		}
		try {
			const result = await this.#exec("bun", [action, ...packages], {
				cwd: this.#toolsRootDir,
				timeoutMs: INSTALL_TIMEOUT_MS,
				...(signal === undefined ? {} : { signal }),
			});
			if (result.exitCode !== 0) {
				return {
					message: `bun ${action} failed with exit code ${result.exitCode}: ${commandDetail(result)}`,
					ok: false,
					packages,
					...(result.stderr.length === 0 ? {} : { stderr: truncate(result.stderr) }),
					...(result.stdout.length === 0 ? {} : { stdout: truncate(result.stdout) }),
				};
			}
			const verb = action === "add" ? "Installed" : "Removed";
			return {
				message: `${verb} ${packages.join(", ")} in ${this.#toolsRootDir}.`,
				ok: true,
				packages,
				...(result.stderr.length === 0 ? {} : { stderr: truncate(result.stderr) }),
				...(result.stdout.length === 0 ? {} : { stdout: truncate(result.stdout) }),
			};
		} catch (error) {
			return failure(`bun ${action} failed: ${errorMessage(error)}`, packages);
		}
	}

	async #ensureToolsPackageJson(): Promise<void> {
		await mkdir(this.#toolsRootDir, { recursive: true });
		const packageJsonPath = join(this.#toolsRootDir, "package.json");
		try {
			await writeFile(
				packageJsonPath,
				`${JSON.stringify({ name: TOOLS_PACKAGE_NAME, private: true }, null, "\t")}\n`,
				{ flag: "wx" },
			);
		} catch (error) {
			if (readErrorCode(error) !== "EEXIST") throw error;
		}
	}

	async #probeRuntime(spec: AcpRuntimePackageSpec): Promise<AcpRuntimeBinaryStatus> {
		const probe = await this.#probeBinary(spec.binaryName);
		return {
			binaryName: spec.binaryName,
			displayName: spec.displayName,
			id: spec.id,
			installMethod: spec.installMethod,
			packages: spec.packages,
			preset: spec.preset,
			source: probe.source,
			...(probe.binaryPath === undefined ? {} : { binaryPath: probe.binaryPath }),
			...(probe.version === undefined ? {} : { version: probe.version }),
			...(spec.installHint === undefined ? {} : { installHint: spec.installHint }),
		};
	}

	async #listCustomPackages(): Promise<readonly AcpCustomPackageStatus[]> {
		const manifest = await readJsonObject(join(this.#toolsRootDir, "package.json"));
		const dependencies = isRecord(manifest?.dependencies) ? manifest.dependencies : undefined;
		if (dependencies === undefined) return [];
		const entries = Object.entries(dependencies)
			.filter(
				(entry): entry is [string, string] =>
					typeof entry[1] === "string" &&
					isValidPackageSpec(entry[0]) &&
					!MANAGED_PACKAGES.has(entry[0]),
			)
			.toSorted(([left], [right]) => left.localeCompare(right));
		return await Promise.all(
			entries.map(async ([packageName, versionSpec]) => {
				const binaryName = await this.#resolveCustomBinaryName(packageName);
				const probe = await this.#probeBinary(binaryName);
				return {
					binaryName,
					packageName,
					source: probe.source,
					versionSpec,
					...(probe.binaryPath === undefined ? {} : { binaryPath: probe.binaryPath }),
					...(probe.version === undefined ? {} : { version: probe.version }),
				};
			}),
		);
	}

	async #resolveCustomBinaryName(packageName: string): Promise<string> {
		const fallback = packageName.split("/").at(-1) ?? packageName;
		const manifest = await readJsonObject(
			join(this.#toolsRootDir, "node_modules", ...packageName.split("/"), "package.json"),
		);
		const bin = manifest?.bin;
		if (typeof bin === "string") return basename(bin) || fallback;
		if (isRecord(bin)) {
			const firstKey = Object.keys(bin)[0];
			if (firstKey !== undefined && firstKey.length > 0) return basename(firstKey);
		}
		return fallback;
	}

	async #probeBinary(binaryName: string): Promise<BinaryProbe> {
		const managedPath = await this.#findManagedBinary(binaryName);
		let pathBinary: string | undefined;
		if (managedPath === undefined) {
			try {
				pathBinary = await this.#resolvePathBinary(binaryName);
			} catch {
				pathBinary = undefined;
			}
		}
		const binaryPath = managedPath ?? pathBinary;
		if (binaryPath === undefined || !(await isRegularFile(binaryPath))) {
			return { source: "none" };
		}
		const source: AcpRuntimeBinarySource = managedPath === undefined ? "system" : "managed";
		const version = await this.#probeVersion(binaryPath);
		return {
			binaryPath,
			source,
			...(version === undefined ? {} : { version }),
		};
	}

	async #findManagedBinary(binaryName: string): Promise<string | undefined> {
		const binDir = join(this.#toolsRootDir, "node_modules", ".bin");
		const candidates =
			process.platform === "win32"
				? [binaryName, `${binaryName}.cmd`, `${binaryName}.exe`]
				: [binaryName];
		for (const candidate of candidates) {
			const binaryPath = join(binDir, candidate);
			if (await isRegularFile(binaryPath)) return binaryPath;
		}
		return undefined;
	}

	async #probeVersion(binaryPath: string): Promise<string | undefined> {
		try {
			const result = await this.#exec(binaryPath, ["--version"], {
				cwd: await this.#execCwd(),
				timeoutMs: VERSION_TIMEOUT_MS,
			});
			if (result.exitCode !== 0) return undefined;
			return parseAcpRuntimeVersion(result.stdout) ?? parseAcpRuntimeVersion(result.stderr);
		} catch {
			return undefined;
		}
	}

	async #execCwd(): Promise<string> {
		try {
			const info = await stat(this.#toolsRootDir);
			if (info.isDirectory()) return this.#toolsRootDir;
		} catch {
			// Fall through to the process cwd so system binaries still report versions.
		}
		return process.cwd();
	}

	async #recordAudit(
		action: string,
		targetId: string,
		packages: readonly string[],
		result: AcpRuntimeOperationResult,
	): Promise<void> {
		if (this.#audit === undefined) return;
		try {
			await this.#audit.record({
				action,
				actorKind: "user",
				payload: {
					ok: result.ok,
					packages: [...packages],
					requiresManualInstall: result.requiresManualInstall === true,
				},
				reason: result.message,
				result: result.ok ? "ok" : "failed",
				targetId,
				targetKind: "acp-runtime",
			});
		} catch (error) {
			this.#logger?.warn("acp runtime audit failed", { error: errorMessage(error) });
		}
	}

	#logOperation(
		operation: "install" | "uninstall",
		targetId: string,
		result: AcpRuntimeOperationResult,
	): void {
		const details = { ok: result.ok, operation, targetId };
		if (result.ok) this.#logger?.info("acp runtime operation completed", details);
		else this.#logger?.warn("acp runtime operation failed", details);
	}

	async #withLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#queue;
		let release!: () => void;
		this.#queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export function isValidPackageSpec(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 214) return false;
	if (trimmed.startsWith("-") || trimmed.startsWith(".") || trimmed.startsWith("_")) return false;
	if (trimmed.includes("..")) return false;
	return PACKAGE_SPEC_PATTERN.test(trimmed);
}

export function parseAcpRuntimeVersion(output: string): string | undefined {
	const semver = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u.exec(output);
	if (semver !== null && semver[1] !== undefined) return semver[1];
	const line = output
		.split(/\r?\n/u)
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	return line === undefined ? undefined : line.slice(0, 120);
}

const defaultCommandExec: CommandExecFn = async (command, args, options) => {
	const controller = new AbortController();
	const abortFromParent = (): void => {
		controller.abort(options.signal?.reason);
	};
	if (options.signal !== undefined) {
		if (options.signal.aborted) abortFromParent();
		else options.signal.addEventListener("abort", abortFromParent, { once: true });
	}
	const timer = setTimeout(
		() => controller.abort(new Error("Command timed out")),
		options.timeoutMs,
	);
	try {
		const proc = Bun.spawn({
			cmd: [command, ...args],
			cwd: options.cwd,
			signal: controller.signal,
			stdin: "ignore",
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stderr: truncate(stderr), stdout: truncate(stdout) };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
};

function normalizeOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function failure(message: string, packages?: readonly string[]): AcpRuntimeOperationResult {
	return {
		message,
		ok: false,
		...(packages === undefined ? {} : { packages }),
	};
}

function commandDetail(result: CommandExecResult): string {
	const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 1_000);
	return detail.length === 0 ? "no output" : detail;
}

function truncate(value: string): string {
	return value.length <= MAX_OUTPUT_CHARS ? value : `${value.slice(0, MAX_OUTPUT_CHARS)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function isRegularFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}
