import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface WorktreeManagerConfig {
	readonly pathAllowlist: readonly string[];
	readonly repositoryPath: string;
	readonly worktreeRoot: string;
}

export interface WorktreeInfo {
	readonly baseRef: string;
	readonly branchName: string;
	readonly path: string;
	readonly taskId: string;
}

export interface GitExecResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export class WorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeError";
	}
}

export class WorktreeManager {
	readonly #config: WorktreeManagerConfig;
	readonly #active = new Map<string, WorktreeInfo>();

	constructor(config: WorktreeManagerConfig) {
		this.#config = config;
	}

	async create(taskId: string, baseRef: string): Promise<WorktreeInfo> {
		await this.validateBaseRef(baseRef);
		const branchName = `tsukaima-iteration/${taskId}`;
		const worktreePath = join(this.#config.worktreeRoot, taskId);
		await mkdir(this.#config.worktreeRoot, { recursive: true });
		const result = await this.#git(["worktree", "add", "-b", branchName, worktreePath, baseRef]);
		if (result.exitCode !== 0) {
			throw new WorktreeError(`Failed to create worktree: ${result.stderr.trim()}`);
		}
		await this.#linkNodeModules(worktreePath);
		const info: WorktreeInfo = { baseRef, branchName, path: worktreePath, taskId };
		this.#active.set(taskId, info);
		return info;
	}

	async cleanup(taskId: string): Promise<void> {
		const info = this.#active.get(taskId);
		if (!info) {
			throw new WorktreeError(`No active worktree for task "${taskId}"`);
		}
		const result = await this.#git(["worktree", "remove", "--force", info.path]);
		if (result.exitCode !== 0) {
			await rm(info.path, { force: true, recursive: true });
			await this.#git(["worktree", "prune"]);
		}
		this.#active.delete(taskId);
	}

	get(taskId: string): WorktreeInfo | undefined {
		return this.#active.get(taskId);
	}

	isPathAllowed(taskId: string, candidatePath: string): boolean {
		const info = this.#active.get(taskId);
		if (!info) {
			return false;
		}
		return isPathWithinAllowlist(info.path, this.#config.pathAllowlist, candidatePath);
	}

	/** Async variant that additionally rejects symlinks escaping the worktree. */
	async assertSafePath(taskId: string, candidatePath: string): Promise<string> {
		const info = this.#active.get(taskId);
		if (!info) {
			throw new WorktreeError(`No active worktree for task "${taskId}"`);
		}
		return assertSafeWorktreePath(info.path, this.#config.pathAllowlist, candidatePath);
	}

	async validateBaseRef(baseRef: string): Promise<void> {
		const result = await this.#git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
		if (result.exitCode !== 0) {
			throw new WorktreeError(`Base ref "${baseRef}" does not resolve to a commit`);
		}
	}

	/**
	 * Worktrees live outside the repository (normally on the persistent /data volume), so the
	 * checkout has no dependencies. Reuse the image/host install through a symlink; failed links
	 * are non-fatal because the project may genuinely have no node_modules yet.
	 */
	async #linkNodeModules(worktreePath: string): Promise<void> {
		const source = join(this.#config.repositoryPath, "node_modules");
		const target = join(worktreePath, "node_modules");
		if (!(await lstat(source).catch(() => undefined))) return;
		if (await lstat(target).catch(() => undefined)) return;
		await symlink(source, target, "dir").catch(() => undefined);
	}

	async #git(args: readonly string[]): Promise<GitExecResult> {
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn("git", [...args], {
				cwd: this.#config.repositoryPath,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf-8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});
			child.on("error", (error: Error) => {
				rejectPromise(error);
			});
			child.on("close", (code: number | null) => {
				resolvePromise({ exitCode: code, stderr, stdout });
			});
		});
	}
}

/** Reject traversal, symlink escapes, and paths outside the allowlist before any write. */
export async function assertSafeWorktreePath(
	worktreePath: string,
	allowlist: readonly string[],
	candidatePath: string,
): Promise<string> {
	if (candidatePath.includes("\0")) {
		throw new WorktreeError("Path contains a null byte");
	}
	if (!isPathWithinAllowlist(worktreePath, allowlist, candidatePath)) {
		throw new WorktreeError(`Path "${candidatePath}" is outside the worktree allowlist`);
	}
	const realWorktree = await realpath(worktreePath);
	const target = resolve(realWorktree, candidatePath);
	const rel = relative(realWorktree, target);
	if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
		throw new WorktreeError(`Path "${candidatePath}" escapes the worktree`);
	}
	let current = target;
	while (true) {
		try {
			const resolved = await realpath(current);
			const fromRoot = relative(realWorktree, resolved);
			if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
				throw new WorktreeError(`Path "${candidatePath}" resolves outside the worktree`);
			}
		} catch (error) {
			if (error instanceof WorktreeError) throw error;
			if (current === realWorktree) break;
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
			continue;
		}
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink()) {
				throw new WorktreeError(`Path "${candidatePath}" traverses a symlink`);
			}
		} catch (error) {
			if (error instanceof WorktreeError) throw error;
		}
		if (current === realWorktree) break;
		current = dirname(current);
	}
	return target;
}

export function isPathWithinAllowlist(
	worktreePath: string,
	allowlist: readonly string[],
	candidatePath: string,
): boolean {
	const resolvedWorktree = resolve(worktreePath);
	const absolutePath = isAbsolute(candidatePath)
		? resolve(candidatePath)
		: resolve(resolvedWorktree, candidatePath);
	const rel = relative(resolvedWorktree, absolutePath);
	if (rel.startsWith("..") || rel === "") {
		return false;
	}
	return allowlist.some((entry) => {
		const normalized = entry.replace(/\/+$/, "");
		return rel === normalized || rel.startsWith(`${normalized}/`);
	});
}
