import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
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
