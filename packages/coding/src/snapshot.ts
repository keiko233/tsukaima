import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxMount } from "./sandbox.ts";

/**
 * Disposable task snapshots for isolated execution.
 *
 * A snapshot is a private copy of one task worktree. The sandbox binds the copy writable at the
 * worktree's path, so commands see their normal working directory, but every write lands in a
 * directory that is deleted after the command. The live worktree, the repository's `.git`, and
 * the live `packages/*` sources are never mounted.
 *
 * Dependencies are reused without copying them. The live install's `node_modules` trees are
 * rebuilt as a view inside the snapshot: installed packages are symlinks into the read-only
 * install mount, and workspace packages are relative symlinks to the snapshot's own copies so
 * that a test imports the task's edited source, not the live checkout.
 */

export const SNAPSHOT_DEFAULT_MAX_FILES = 50_000;
export const SNAPSHOT_DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** Each file is read whole to hash it, so one file is bounded independently of the total. */
export const SNAPSHOT_MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface TaskSnapshotOptions {
	/** Task worktree to copy. Must not be, or be inside, the repository root. */
	readonly sourcePath: string;
	/** Repository root whose `node_modules` provides dependencies. Its source is never copied. */
	readonly repositoryPath: string;
	/** Existing empty private directory that receives the copy. */
	readonly targetPath: string;
	readonly maxBytes?: number;
	readonly maxFiles?: number;
	readonly signal?: AbortSignal;
}

/**
 * Provenance of one snapshot. `checksum` identifies the copied source content: it covers every
 * entry's path, type, mode, size, and content digest, and never a host path. Dependency links are
 * deliberately excluded because they point at the install, not at task content.
 */
export interface TaskSnapshotManifest {
	readonly bytes: number;
	readonly checksum: string;
	readonly dependencyLinks: number;
	readonly directories: number;
	readonly files: number;
	/** Sockets, devices, pipes, and symlinks that could leave the task tree; never copied. */
	readonly skippedEntries: number;
	readonly symlinks: number;
	/** Dependency entries that could not be mapped into the snapshot or the install mount. */
	readonly unresolvedDependencies: number;
}

export interface TaskSnapshot {
	readonly manifest: TaskSnapshotManifest;
	/** Read-only host paths the sandbox must bind so the dependency links resolve. */
	readonly readOnlyMounts: readonly SandboxMount[];
}

/** Directory names never copied: VCS metadata, and dependencies that are mapped separately. */
const EXCLUDED_NAMES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Result of measuring a worktree the way a snapshot run would see it. */
export interface TaskSnapshotMeasurement {
	readonly manifest: TaskSnapshotManifest;
	/** Given paths that the snapshot does not carry, so a check of the snapshot cannot cover them. */
	readonly uncoveredPaths: readonly string[];
}

/**
 * Copy a worktree into a private scratch directory and report the identity a snapshot run would
 * record. The copy is deleted before returning, so a measurement leaves no host state behind.
 * `paths` are repository-relative changed paths; any the copy does not reproduce are reported.
 */
export async function measureTaskSnapshot(options: {
	readonly paths: readonly string[];
	readonly repositoryPath: string;
	readonly signal?: AbortSignal;
	readonly sourcePath: string;
}): Promise<TaskSnapshotMeasurement> {
	const scratch = await mkdtemp(join(tmpdir(), "tsukaima-measure-"));
	try {
		const target = await realpath(scratch);
		const snapshot = await createTaskSnapshot({
			repositoryPath: options.repositoryPath,
			sourcePath: options.sourcePath,
			targetPath: target,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		const source = await realpath(options.sourcePath);
		const uncoveredPaths: string[] = [];
		for (const path of options.paths) {
			if (!(await coversPath(source, target, path))) uncoveredPaths.push(path);
		}
		return { manifest: snapshot.manifest, uncoveredPaths };
	} finally {
		await rm(scratch, { force: true, recursive: true });
	}
}

/**
 * A changed path is covered when the copy reproduces its presence in the live tree. Paths under an
 * excluded directory, and paths that resolve outside the tree, are never reproduced.
 */
async function coversPath(source: string, target: string, path: string): Promise<boolean> {
	const segments = path.split("/");
	if (
		isAbsolute(path) ||
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
	) {
		return false;
	}
	if (segments.some((segment) => EXCLUDED_NAMES.has(segment))) return false;
	const live = await lstat(join(source, path)).then(
		() => true,
		() => false,
	);
	const copied = await lstat(join(target, path)).then(
		() => true,
		() => false,
	);
	return live === copied;
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** One bounded git query against the snapshot source; a failure simply yields no git view. */
async function snapshotGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stderr: "pipe",
		stdout: "pipe",
	});
	const out = (await new Response(proc.stdout).text()).trim();
	return (await proc.exited) === 0 && out.length > 0 ? out : undefined;
}

function sha256(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Copy a task worktree into `targetPath` and build its dependency view. */
export async function createTaskSnapshot(options: TaskSnapshotOptions): Promise<TaskSnapshot> {
	const source = await realpath(options.sourcePath);
	const repository = await realpath(options.repositoryPath);
	const target = await realpath(options.targetPath);
	if (source === repository || isInside(repository, source)) {
		throw new Error("snapshot_source_is_repository");
	}
	if (isInside(source, target) || isInside(repository, target)) {
		throw new Error("snapshot_target_overlaps_source");
	}
	const maxBytes = options.maxBytes ?? SNAPSHOT_DEFAULT_MAX_BYTES;
	const maxFiles = options.maxFiles ?? SNAPSHOT_DEFAULT_MAX_FILES;
	const liveRootModules = await realpath(join(repository, "node_modules")).catch(() => undefined);

	const entries: string[] = [];
	const counters = {
		bytes: 0,
		dependencyLinks: 0,
		directories: 0,
		files: 0,
		skippedEntries: 0,
		symlinks: 0,
		unresolvedDependencies: 0,
	};
	const mounts = new Map<string, SandboxMount>();
	if (liveRootModules !== undefined) {
		mounts.set(liveRootModules, { directory: true, path: liveRootModules });
	}

	const addMount = (path: string): void => {
		mounts.set(path, { directory: true, path });
	};

	/**
	 * Build a minimal read-only `.git` inside the snapshot so `git status`, `git diff`, and
	 * `git log` work like they do in the task worktree. The snapshot previously had no git
	 * metadata at all, so every git invocation failed with "not a git repository".
	 *
	 * The view never contains the repository's `config` (credential helpers, remote URLs),
	 * hooks, or reflogs: `HEAD`, the resolved branch tip, a copy of `packed-refs`, and a
	 * minimal config are all it holds. The shared object store is referenced through an
	 * `objects/info/alternates` pointer to the host path the sandbox mounts read-only, so no
	 * object is ever copied or writable. Sources without git metadata simply skip the view.
	 */
	const buildGitView = async (): Promise<void> => {
		const gitDir = await snapshotGit(source, ["rev-parse", "--git-dir"]).then((value) =>
			value === undefined ? undefined : realpath(resolve(source, value)).catch(() => undefined),
		);
		const commonDir = await snapshotGit(source, ["rev-parse", "--git-common-dir"]).then((value) =>
			value === undefined ? undefined : realpath(resolve(source, value)).catch(() => undefined),
		);
		if (gitDir === undefined || commonDir === undefined) {
			counters.skippedEntries += 1;
			return;
		}
		const head = await Bun.file(join(gitDir, "HEAD"))
			.text()
			.catch(() => undefined);
		if (head === undefined || head.trim().length === 0) {
			counters.skippedEntries += 1;
			return;
		}
		const commit = await snapshotGit(source, ["rev-parse", "HEAD"]);
		const gitRoot = join(target, ".git");
		await mkdir(join(gitRoot, "refs", "heads"), { mode: 0o755, recursive: true });
		await Bun.write(join(gitRoot, "HEAD"), head);
		if (commit !== undefined && /^[0-9a-f]{40,64}$/u.test(commit)) {
			// Resolve the checked-out branch so status shows it even without a config file.
			const symbolic = /^ref:\s*(refs\/[^\s]+)\s*$/u.exec(head);
			if (symbolic?.[1] !== undefined) {
				await Bun.write(join(gitRoot, symbolic[1]), `${commit}\n`);
			}
		}
		await Bun.write(
			join(gitRoot, "packed-refs"),
			await Bun.file(join(commonDir, "packed-refs"))
				.text()
				.catch(() => ""),
		);
		// Shared object store: mounted read-only by the sandbox, referenced via alternates.
		const objectsDir = join(commonDir, "objects");
		await mkdir(join(gitRoot, "objects", "info"), { mode: 0o755, recursive: true });
		await Bun.write(join(gitRoot, "objects", "info", "alternates"), `${objectsDir}\n`);
		mounts.set(objectsDir, { directory: true, path: objectsDir });
		// No repository `config` on purpose: identity comes from the process environment, and a
		// missing remote list makes accidental push/fetch impossible inside the snapshot.
		await Bun.write(join(gitRoot, "config"), "[core]\n\tbare = false\n");
	};

	/** Map one live `node_modules` entry to a snapshot entry. Never copies dependency content. */
	const linkDependency = async (liveEntry: string, linkPath: string): Promise<void> => {
		const real = await realpath(liveEntry).catch(() => undefined);
		if (real === undefined) {
			counters.unresolvedDependencies += 1;
			return;
		}
		if (liveRootModules !== undefined && isInside(liveRootModules, real)) {
			await symlink(real, linkPath);
			counters.dependencyLinks += 1;
			return;
		}
		if (isInside(repository, real)) {
			const rel = relative(repository, real);
			if (rel.split(sep).includes("node_modules")) {
				// A per-workspace install directory (for example `.bin`): mount only that directory.
				addMount(real);
				await symlink(real, linkPath);
				counters.dependencyLinks += 1;
				return;
			}
			// A workspace package: point at the snapshot copy so the task's edits are what runs.
			const copy = join(target, rel);
			if ((await lstat(copy).catch(() => undefined)) === undefined) {
				counters.unresolvedDependencies += 1;
				return;
			}
			await symlink(relative(dirname(linkPath), copy), linkPath);
			counters.dependencyLinks += 1;
			return;
		}
		counters.unresolvedDependencies += 1;
	};

	const mapDependencies = async (
		liveDir: string,
		viewDir: string,
		allowScopes: boolean,
	): Promise<void> => {
		const names = (await readdir(liveDir).catch(() => [] as string[])).toSorted();
		for (const name of names) {
			// Dotfiles are the package manager's private store, except `.bin` which holds commands.
			if (name.startsWith(".") && name !== ".bin") continue;
			const liveEntry = join(liveDir, name);
			const linkPath = join(viewDir, name);
			if (allowScopes && name.startsWith("@")) {
				const info = await lstat(liveEntry).catch(() => undefined);
				if (info?.isDirectory() === true) {
					await mkdir(linkPath, { mode: 0o755 });
					await mapDependencies(liveEntry, linkPath, false);
					continue;
				}
			}
			await linkDependency(liveEntry, linkPath);
		}
	};

	const buildDependencyView = async (dirRel: string): Promise<void> => {
		const liveModules = join(repository, dirRel, "node_modules");
		if ((await lstat(liveModules).catch(() => undefined)) === undefined) return;
		const liveReal = await realpath(liveModules).catch(() => undefined);
		const viewRoot = join(target, dirRel, "node_modules");
		await mkdir(viewRoot, { mode: 0o755 });
		if (liveReal === undefined) {
			counters.unresolvedDependencies += 1;
			return;
		}
		await mapDependencies(liveReal, viewRoot, true);
	};

	const walk = async (dirRel: string): Promise<void> => {
		options.signal?.throwIfAborted();
		const sourceDir = join(source, dirRel);
		const targetDir = join(target, dirRel);
		const dirents = (await readdir(sourceDir, { withFileTypes: true })).toSorted((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
		for (const dirent of dirents) {
			if (EXCLUDED_NAMES.has(dirent.name)) continue;
			const rel = dirRel.length === 0 ? dirent.name : `${dirRel}/${dirent.name}`;
			const from = join(sourceDir, dirent.name);
			const to = join(targetDir, dirent.name);
			const info = await lstat(from);
			if (info.isDirectory()) {
				await mkdir(to, { mode: 0o755 });
				counters.directories += 1;
				entries.push(`d\0${rel}`);
				await walk(rel);
				continue;
			}
			if (info.isFile()) {
				if (info.size > SNAPSHOT_MAX_FILE_BYTES) {
					throw new Error(`snapshot_file_too_large:${rel}`);
				}
				counters.files += 1;
				counters.bytes += info.size;
				if (counters.files > maxFiles) throw new Error(`snapshot_too_many_files:>${maxFiles}`);
				if (counters.bytes > maxBytes) throw new Error(`snapshot_too_large:>${maxBytes}`);
				const data = await readFile(from);
				const mode = info.mode & 0o777;
				await writeFile(to, data, { flag: "wx", mode });
				entries.push(`f\0${rel}\0${mode}\0${data.length}\0${sha256(data)}`);
				continue;
			}
			if (info.isSymbolicLink()) {
				// Absolute links and links that resolve outside the task tree (the live
				// repository, host secrets, another task) are dropped. A relative in-tree link is
				// recreated so it keeps pointing at the same place inside the snapshot.
				const linkTarget = await readlink(from);
				const resolved = await realpath(from).catch(() => undefined);
				if (isAbsolute(linkTarget) || resolved === undefined || !isInside(source, resolved)) {
					counters.skippedEntries += 1;
					continue;
				}
				await symlink(linkTarget, to);
				counters.symlinks += 1;
				entries.push(`l\0${rel}\0${linkTarget}`);
				continue;
			}
			counters.skippedEntries += 1;
		}
		await buildDependencyView(dirRel);
	};

	await walk("");
	options.signal?.throwIfAborted();
	await buildGitView();
	options.signal?.throwIfAborted();
	const manifest: TaskSnapshotManifest = {
		bytes: counters.bytes,
		checksum: sha256(entries.toSorted().join("\n")),
		dependencyLinks: counters.dependencyLinks,
		directories: counters.directories,
		files: counters.files,
		skippedEntries: counters.skippedEntries,
		symlinks: counters.symlinks,
		unresolvedDependencies: counters.unresolvedDependencies,
	};
	return { manifest, readOnlyMounts: [...mounts.values()] };
}
