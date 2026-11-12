import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

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

	async validateBaseRef(baseRef: string): Promise<void> {
		const result = await this.#git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
		if (result.exitCode !== 0) {
			throw new WorktreeError(`Base ref "${baseRef}" does not resolve to a commit`);
		}
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
