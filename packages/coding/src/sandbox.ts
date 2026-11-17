import { access, constants, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runManagedProcess, type CommandResult } from "./runner.ts";

/**
 * Command execution for the governed coding surface.
 *
 * A fixed argv list and a scrubbed environment are not a security boundary: `bun -e`,
 * `rg --pre`, or any interpreter that reads a repository file turns "one allow-listed command"
 * into arbitrary code with the server's filesystem, environment, and network access. Code that
 * can be influenced by a model therefore runs inside an operating-system sandbox
 * (bubblewrap namespaces) or does not run at all. This module never falls back to a plain
 * `spawn`: when the sandbox cannot be verified, `exec()` fails closed with
 * `SandboxUnavailableError`.
 */

export class SandboxUnavailableError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`sandbox_unavailable: ${reason}`);
		this.name = "SandboxUnavailableError";
		this.reason = reason;
	}
}

export interface SandboxExecInput {
	readonly args: readonly string[];
	readonly command: string;
	/** Absolute path that becomes the sandbox working directory. */
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly maxOutputBytes: number;
	readonly timeoutMs: number;
	/** Optional committed-source export, mounted read-only at {@link ANALYSIS_MOUNT}. */
	readonly analysisPath?: string;
	/** Export the committed tree at HEAD and mount it at {@link ANALYSIS_MOUNT}. */
	readonly exportAnalysis?: boolean;
	/**
	 * Export a working tree (a task worktree, including its uncommitted edits) read-only at
	 * {@link ANALYSIS_MOUNT}. Unlike {@link exportAnalysis} this never reads the live repository.
	 */
	readonly analysisTree?: string;
	/** Writable working trees are the only host location the sandbox may modify. */
	readonly writable: boolean;
}

export interface SandboxExecutor {
	readonly id: string;
	exec(input: SandboxExecInput): Promise<CommandResult>;
}

export type SandboxProvider = () => Promise<SandboxExecutor>;

export interface BubblewrapSandboxOptions {
	/** Repository root, mounted read-only so worktree `node_modules` links resolve. */
	readonly repositoryPath: string;
	/**
	 * Directory that holds task worktrees. When set, only a cwd inside it may be bound writable;
	 * a cwd inside the repository is always refused, so a caller cannot re-expose local state by
	 * naming the repository root as its working directory.
	 */
	readonly worktreeRoot?: string;
	/** Host environment used to locate `bwrap`; defaults to the process environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Directories searched for sandboxed commands, in order; defaults to PATH dirs. */
	readonly pathDirs?: readonly string[];
}

/** Commands are resolved from fixed directories, never from a model-supplied path. */
export const SANDBOX_PATH_DIRS: readonly string[] = Object.freeze([
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
]);

/** Runtime location of the Bun executable, so policy commands resolve wherever Bun is installed. */
function runtimePathDirs(): readonly string[] {
	const dirs = new Set<string>(SANDBOX_PATH_DIRS);
	const execDir = dirname(process.execPath);
	if (isAbsolute(execDir)) dirs.add(execDir);
	return [...dirs];
}

const SYSTEM_READONLY_ROOTS: readonly string[] = Object.freeze([
	"/bin",
	"/lib",
	"/lib32",
	"/lib64",
	"/sbin",
	"/usr",
]);

/**
 * Individual `/etc` entries a command needs to start. `/etc` is not mounted wholesale: it can
 * carry host credentials (`/etc/shadow`, SSH host keys, service tokens) that a governed command
 * has no reason to read.
 */
const SYSTEM_READONLY_FILES: readonly string[] = Object.freeze([
	"/etc/ca-certificates",
	"/etc/fonts",
	"/etc/group",
	"/etc/hosts",
	"/etc/ld.so.cache",
	"/etc/localtime",
	"/etc/nsswitch.conf",
	"/etc/passwd",
	"/etc/resolv.conf",
	"/etc/ssl",
]);

const SANDBOX_ENV_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
	HOME: "/tmp/home",
	LANG: "C.UTF-8",
	TMPDIR: "/tmp",
	TZ: "UTC",
});

/** The probe proves `bwrap` can actually create namespaces on this host, not just that it exists. */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_COMMAND = "true";

/** Resolve an executable from a PATH-style list without running a shell. */
export async function resolveExecutable(
	command: string,
	pathDirs: readonly string[],
): Promise<string | undefined> {
	if (command.length === 0 || command.includes("/") || command.includes("\\")) return undefined;
	for (const dir of pathDirs) {
		const candidate = resolve(dir, command);
		try {
			const stats = await stat(candidate);
			if (!stats.isFile()) continue;
			await access(candidate, constants.X_OK);
			// Return the real path so the sandbox mounts the directory that holds the binary, not
			// just a symlink's parent (Bun itself is often a symlink into a version store).
			return await realpath(candidate).catch(() => candidate);
		} catch {
			continue;
		}
	}
	return undefined;
}

function hostPathDirs(env: Readonly<Record<string, string | undefined>>): readonly string[] {
	const path = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	return path
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export interface BubblewrapArgvInput {
	readonly args: readonly string[];
	readonly commandPath: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	/** Read-only source tree exported for analysis; mounted at `/analysis` when present. */
	readonly analysisPath?: string;
	/** Additional read-only host paths the command needs (for example a worktree's git dir). */
	readonly readOnlyPaths?: readonly SandboxMount[];
	readonly repositoryPath: string;
	readonly writable: boolean;
}

/** One explicit host path bound into the sandbox. */
export interface SandboxMount {
	readonly directory: boolean;
	readonly path: string;
}

/**
 * Build the `bwrap` argv for one command. Exported for tests so the isolation flags can be
 * asserted without spawning anything.
 */
export function buildBubblewrapArgv(input: BubblewrapArgvInput): string[] {
	// The repository appears as an empty directory only; a caller must pass explicit mounts.
	// `cwd` is the worktree bind and is checked by the executor against the worktree root.
	const argv: string[] = [
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--hostname",
		"tsukaima-sandbox",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/tmp/home",
		"--clearenv",
	];
	for (const [key, value] of Object.entries(input.env)) {
		argv.push("--setenv", key, value);
	}
	for (const root of SYSTEM_READONLY_ROOTS) {
		argv.push("--ro-bind-try", root, root);
	}
	for (const file of SYSTEM_READONLY_FILES) {
		argv.push("--ro-bind-try", file, file);
	}
	const commandDir = dirname(input.commandPath);
	if (
		!SYSTEM_READONLY_ROOTS.some((root) => commandDir === root || commandDir.startsWith(`${root}/`))
	) {
		argv.push("--ro-bind-try", commandDir, commandDir);
	}
	// The repository root itself is never bound. Only the paths the runner resolved (the
	// worktree's `node_modules` link target and its git metadata) are mounted, each read-only.
	// An unlisted host path therefore does not exist inside the namespace.
	argv.push("--dir", input.repositoryPath);
	for (const mount of input.readOnlyPaths ?? []) {
		// `--ro-bind-try` keeps a missing optional path (an absent `packed-refs`) non-fatal; a
		// file and a directory bind identically.
		argv.push("--ro-bind-try", mount.path, mount.path);
	}
	if (input.analysisPath !== undefined) {
		argv.push("--ro-bind", input.analysisPath, ANALYSIS_MOUNT);
	}
	argv.push(input.writable ? "--bind" : "--ro-bind", input.cwd, input.cwd);
	argv.push("--chdir", input.cwd);
	argv.push("--", input.commandPath, ...input.args);
	return argv;
}

/** Fixed location of the exported analysis tree inside the sandbox. */
export const ANALYSIS_MOUNT = "/analysis";

/**
 * Read-only mounts a worktree command needs. A worktree normally symlinks `node_modules` to the
 * image install and stores its git metadata under the repository's `.git`; both are mounted
 * explicitly. Nothing else from the repository (dotenv files, `data/`, `secrets/`, the runtime
 * SQLite databases, `.git/config` credentials) is visible, so a nested secret cannot leak by
 * simply not being named in a mask list.
 */
async function sandboxMounts(
	repositoryPath: string,
	worktreePath: string,
): Promise<readonly SandboxMount[]> {
	const mounts = new Map<string, SandboxMount>();
	const add = async (path: string): Promise<void> => {
		const stats = await stat(path).catch(() => undefined);
		if (stats === undefined) return;
		mounts.set(path, { directory: stats.isDirectory(), path });
	};
	const addOptional = (path: string): void => {
		if (mounts.has(path)) return;
		mounts.set(path, { directory: false, path });
	};

	const nodeModules = join(repositoryPath, "node_modules");
	if (await lstat(nodeModules).catch(() => undefined)) {
		// Follow the symlink so the namespace binds the real install, not a dangling link.
		await add(await realpath(nodeModules).catch(() => nodeModules));
	}

	// A worktree's `.git` file points at `<common>/worktrees/<name>`. Mount exactly that
	// directory plus the object store and refs a read-only `git diff`/`rev-parse` needs. The
	// common `.git` directory itself is never mounted, so `config` and credentials stay hidden.
	const gitView = await resolveGitView(worktreePath);
	for (const path of gitView.required) await add(path);
	for (const path of gitView.optional) addOptional(path);
	return [...mounts.values()];
}

/**
 * Resolve the minimal git directories for a worktree, or nothing when the worktree has no git
 * metadata (for example a plain directory in a unit test). Commands that need git then simply
 * fail inside the sandbox instead of gaining access to the host repository.
 */
async function resolveGitView(
	worktreePath: string,
): Promise<{ readonly optional: readonly string[]; readonly required: readonly string[] }> {
	const empty = { optional: [], required: [] };
	const dotGit = join(worktreePath, ".git");
	const info = await lstat(dotGit).catch(() => undefined);
	if (info === undefined) return empty;
	if (info.isDirectory()) {
		// A plain (non-worktree) checkout: expose only objects and refs, never `config` or hooks.
		return {
			optional: ["refs", "packed-refs"].map((entry) => join(dotGit, entry)),
			required: [join(dotGit, "objects")],
		};
	}
	let pointer: string;
	try {
		pointer = (await Bun.file(dotGit).text()).trim();
	} catch {
		return empty;
	}
	const match = /^gitdir:\s*(.+)$/u.exec(pointer);
	if (match?.[1] === undefined) return empty;
	const gitDir = await realpath(resolve(worktreePath, match[1])).catch(() => undefined);
	if (gitDir === undefined) return empty;
	const commonDirFile = join(gitDir, "commondir");
	let commonDir = gitDir;
	const commonPointer = await Bun.file(commonDirFile)
		.text()
		.then((value) => value.trim())
		.catch(() => undefined);
	if (commonPointer !== undefined && commonPointer.length > 0) {
		commonDir = await realpath(resolve(gitDir, commonPointer)).catch(() => gitDir);
	}
	// The common `.git` directory itself is deliberately absent: mounting it would expose
	// `config` (credential helpers), hooks, and reflogs. Only the linked worktree's metadata and
	// the shared object/ref stores are bound. Missing optional paths use `--ro-bind-try`.
	return {
		optional: ["refs", "packed-refs"].map((entry) => join(commonDir, entry)),
		required: [gitDir, join(commonDir, "objects")],
	};
}

/**
 * A bubblewrap-backed sandbox. The provider probes once per instance and then either returns a
 * working executor or throws on every call; a failed probe is remembered, so a host without
 * usable user namespaces can never execute a governed command.
 */
export function createBubblewrapSandbox(options: BubblewrapSandboxOptions): SandboxProvider {
	let cached: Promise<SandboxExecutor> | undefined;
	return () => {
		cached ??= createExecutor(options).catch((error: unknown) => {
			// A failed probe must stay failed: clear the cache only on explicit re-creation.
			const reason = error instanceof Error ? error.message : String(error);
			throw error instanceof SandboxUnavailableError ? error : new SandboxUnavailableError(reason);
		});
		return cached;
	};
}

/** One-shot capability probe; tests use it to assert the fail-closed decision. */
export async function probeBubblewrapSandbox(
	options: BubblewrapSandboxOptions,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
	try {
		await createExecutor(options);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function createExecutor(options: BubblewrapSandboxOptions): Promise<SandboxExecutor> {
	const hostEnv = options.env ?? process.env;
	const pathDirs = options.pathDirs ?? runtimePathDirs();
	const bwrapPath = await resolveExecutable("bwrap", hostPathDirs(hostEnv));
	if (bwrapPath === undefined) {
		throw new SandboxUnavailableError("bubblewrap (bwrap) is not installed on the host");
	}
	const repositoryPath = await realpath(options.repositoryPath).catch(() => {
		throw new SandboxUnavailableError(`repository root does not exist: ${options.repositoryPath}`);
	});
	const worktreeRoot =
		options.worktreeRoot === undefined
			? undefined
			: await realpath(options.worktreeRoot).catch(() => undefined);
	const probeCommand = await resolveExecutable(PROBE_COMMAND, pathDirs);
	if (probeCommand === undefined) {
		throw new SandboxUnavailableError(`sandbox probe command "${PROBE_COMMAND}" is unavailable`);
	}
	const probeEnv = sandboxEnv(pathDirs, {});
	const probe = await runManagedProcess({
		args: buildBubblewrapArgv({
			args: [],
			commandPath: probeCommand,
			cwd: repositoryPath,
			env: probeEnv,
			readOnlyPaths: [],
			repositoryPath,
			writable: false,
		}),
		command: bwrapPath,
		cwd: repositoryPath,
		env: { PATH: hostPathDirs(hostEnv).join(delimiter) },
		maxOutputBytes: 4096,
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	if (probe.exitCode !== 0) {
		const detail = probe.stderr.trim() || probe.stdout.trim() || "unknown error";
		throw new SandboxUnavailableError(`bubblewrap probe failed: ${detail}`);
	}

	// Validate the sandbox paths up front so a misconfigured root fails the probe, not one run.
	await assertSandboxPathArg(repositoryPath);

	const executor: SandboxExecutor = {
		id: "bubblewrap",
		async exec(input) {
			if (!isAbsolute(input.cwd)) {
				throw new SandboxUnavailableError(
					`sandbox working directory must be absolute: ${input.cwd}`,
				);
			}
			const commandPath = await resolveExecutable(input.command, pathDirs);
			if (commandPath === undefined) {
				throw new Error(`command_not_found:${input.command}`);
			}
			for (const arg of input.args) {
				if (arg.includes("\0")) throw new Error("command arguments must not contain null bytes");
			}
			const cwd = await assertSandboxPathArg(input.cwd);
			// The repository (and anything above a configured worktree root) is never a valid
			// working directory: binding it would expose every local file the mount set omits.
			if (cwd === repositoryPath || isInside(repositoryPath, cwd)) {
				throw new SandboxUnavailableError(
					"sandbox working directory must be a worktree, not the repository",
				);
			}
			if (worktreeRoot !== undefined && !isInside(worktreeRoot, cwd)) {
				throw new SandboxUnavailableError("sandbox working directory is outside the worktree root");
			}
			const writable = input.writable;
			const env = sandboxEnv(pathDirs, input.env ?? {});
			const readOnlyPaths = await sandboxMounts(repositoryPath, cwd);
			const exportDir =
				input.exportAnalysis === true || input.analysisTree !== undefined
					? await mkdtemp(join(tmpdir(), "tsukaima-analysis-"))
					: undefined;
			try {
				let analysisPath =
					input.analysisPath === undefined
						? undefined
						: await assertSandboxPathArg(input.analysisPath);
				if (input.analysisTree !== undefined && exportDir !== undefined) {
					// A patch task reads its own worktree, including uncommitted edits, through a
					// private read-only copy. The live repository is never the analysis surface.
					await copyWorkingTree(input.analysisTree, exportDir);
					analysisPath = exportDir;
				} else if (exportDir !== undefined) {
					// The committed tree is the only analysis surface for a read-only task: working
					// tree edits, untracked files, and anything gitignored are absent.
					await exportCommittedTree(repositoryPath, exportDir);
					analysisPath = exportDir;
				}
				const argv = buildBubblewrapArgv({
					args: input.args,
					...(analysisPath === undefined ? {} : { analysisPath }),
					commandPath,
					cwd,
					env,
					readOnlyPaths,
					repositoryPath,
					writable,
				});
				return await runManagedProcess({
					args: argv,
					command: bwrapPath,
					cwd,
					env: { PATH: hostPathDirs(hostEnv).join(delimiter) },
					maxOutputBytes: input.maxOutputBytes,
					timeoutMs: input.timeoutMs,
				});
			} finally {
				if (exportDir !== undefined) await rm(exportDir, { force: true, recursive: true });
			}
		},
	};
	return executor;
}

/**
 * Export the committed HEAD tree into `target` without touching the working tree.
 *
 * `git archive` writes a tarball to a private host directory; it is extracted into `target`,
 * which is then mounted read-only. The archive never enters the sandbox, and uncommitted,
 * untracked, or gitignored files are absent because only one commit is archived.
 */
async function exportCommittedTree(repositoryPath: string, target: string): Promise<void> {
	const gitPath = await resolveExecutable("git", SANDBOX_PATH_DIRS);
	const tarPath = await resolveExecutable("tar", SANDBOX_PATH_DIRS);
	if (gitPath === undefined || tarPath === undefined) {
		throw new SandboxUnavailableError("git and tar are required for the analysis snapshot");
	}
	const staging = await mkdtemp(join(tmpdir(), "tsukaima-analysis-tar-"));
	const archivePath = join(staging, "tree.tar");
	try {
		const archive = Bun.spawn({
			cmd: [gitPath, "archive", "--format=tar", "--output", archivePath, "HEAD"],
			cwd: repositoryPath,
			env: { PATH: SANDBOX_PATH_DIRS.join(delimiter) },
			stderr: "pipe",
			stdout: "ignore",
		});
		const archiveCode = await archive.exited;
		if (archiveCode !== 0) {
			const detail = await new Response(archive.stderr).text();
			throw new SandboxUnavailableError(
				`analysis snapshot failed: ${detail.trim() || `git=${archiveCode}`}`,
			);
		}
		const extract = Bun.spawn({
			cmd: [
				tarPath,
				"-x",
				"-f",
				archivePath,
				"-C",
				target,
				"--no-same-owner",
				"--no-same-permissions",
			],
			cwd: repositoryPath,
			env: { PATH: SANDBOX_PATH_DIRS.join(delimiter) },
			stderr: "pipe",
			stdout: "ignore",
		});
		const extractCode = await extract.exited;
		if (extractCode !== 0) {
			const detail = await new Response(extract.stderr).text();
			throw new SandboxUnavailableError(
				`analysis snapshot failed: ${detail.trim() || `tar=${extractCode}`}`,
			);
		}
	} finally {
		await rm(staging, { force: true, recursive: true });
	}
}

/**
 * Copy a task worktree into a private directory for read-only analysis. `.git` is skipped (its
 * metadata is mounted separately and must not be writable through the copy), and the copy is
 * made before the command starts so the command cannot observe later host changes.
 */
async function copyWorkingTree(source: string, target: string): Promise<void> {
	const tarPath = await resolveExecutable("tar", SANDBOX_PATH_DIRS);
	if (tarPath === undefined) {
		throw new SandboxUnavailableError("tar is required for the analysis snapshot");
	}
	const root = await realpath(source).catch(() => {
		throw new SandboxUnavailableError(`analysis tree does not exist: ${source}`);
	});
	const copy = Bun.spawn({
		cmd: [tarPath, "-c", "-f", "-", "--exclude=./.git", "-C", root, "."],
		stderr: "pipe",
		stdout: "pipe",
	});
	const extract = Bun.spawn({
		cmd: [tarPath, "-x", "-f", "-", "-C", target, "--no-same-owner", "--no-same-permissions"],
		stdin: copy.stdout,
		stderr: "pipe",
		stdout: "ignore",
	});
	const [copyCode, extractCode] = await Promise.all([copy.exited, extract.exited]);
	if (copyCode !== 0 || extractCode !== 0) {
		const detail = await new Response(extract.stderr).text();
		throw new SandboxUnavailableError(
			`analysis snapshot failed: ${detail.trim() || `tar=${copyCode}/${extractCode}`}`,
		);
	}
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertSandboxPathArg(path: string): Promise<string> {
	try {
		const resolved = await realpath(path);
		const stats = await stat(resolved);
		if (!stats.isDirectory()) {
			throw new SandboxUnavailableError(`sandbox path is not a directory: ${path}`);
		}
		return resolved;
	} catch (error) {
		if (error instanceof SandboxUnavailableError) throw error;
		throw new SandboxUnavailableError(`sandbox path does not exist: ${path}`);
	}
}

function sandboxEnv(
	pathDirs: readonly string[],
	extra: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return { ...SANDBOX_ENV_DEFAULTS, ...extra, PATH: pathDirs.join(delimiter) };
}
