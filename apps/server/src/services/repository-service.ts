import { join } from "node:path";
import { assertSafeBaseRef, gitCredentialEnvironment, GitCli } from "@tsukaima/coding";
import type { RepositoryStatus } from "@tsukaima/contracts";
import type { Logger } from "../logging.ts";

/**
 * Read-only view of the checkout the server runs in.
 *
 * Everything here comes from `git` in one place, so the upgrade center, the admin API, and (later)
 * governed write flows agree on what "ahead", "dirty", or "pushed" means. The service never writes
 * to the repository and never takes model-supplied input.
 */

export interface RepositoryServiceOptions {
	/** Pushing is destructive on a shared remote; disabled unless the operator enables it. */
	readonly allowPush?: boolean;
	/** Override for tests; defaults to a `GitCli` rooted at {@link repositoryPath}. */
	readonly git?: GitCli;
	readonly logger?: Logger;
	readonly maxTags?: number;
	readonly maxWorktrees?: number;
	readonly repositoryPath: string;
	readonly versionFile?: string;
}

export interface RepositoryDirtyCounts {
	readonly conflicted: number;
	readonly modified: number;
	readonly staged: number;
	readonly untracked: number;
}

export interface RepositoryHeadInfo {
	readonly authoredAt: string;
	readonly commit: string;
	readonly subject: string;
}

export interface RepositoryRemoteInfo {
	readonly fetchUrl: string;
	readonly name: string;
	readonly pushUrl: string;
}

export interface RepositoryWorktreeInfo {
	readonly branch: string | null;
	readonly head: string;
	readonly locked: boolean;
	readonly path: string;
}

export interface RepositoryTagInfo {
	readonly commit: string;
	readonly name: string;
}

export interface RepositoryUpstreamInfo {
	readonly ahead: number;
	readonly behind: number;
	readonly ref: string;
	readonly remote: string;
}

export class RepositoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepositoryError";
	}
}

const DEFAULT_MAX_TAGS = 20;
const DEFAULT_MAX_WORKTREES = 20;
const DEFAULT_VERSION_FILE = "VERSION";
/** Network commands get more room than local reads, but still a bounded one. */
const NETWORK_TIMEOUT_MS = 120_000;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** Field separator for `--format` output: a subject cannot contain a newline, only the unit sep. */
const UNIT_SEPARATOR = "\u001f";

export interface ParsedStatus {
	readonly ahead: number;
	readonly behind: number;
	readonly branch: string | null;
	readonly commit: string;
	readonly dirty: RepositoryDirtyCounts;
	readonly upstreamRef: string | null;
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * Only the header and the change type of each entry are read, never the path: v2 quotes paths that
 * contain unusual characters (C-style escaping), and counting entries avoids having to unquote.
 * `X` is the index (staged) status and `Y` the worktree (unstaged) one; `.` means unchanged.
 */
export function parseStatusPorcelainV2(output: string): ParsedStatus {
	let ahead = 0;
	let behind = 0;
	let branch: string | null = null;
	let commit = "";
	let upstreamRef: string | null = null;
	let conflicted = 0;
	let modified = 0;
	let staged = 0;
	let untracked = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			const value = line.slice("# branch.head ".length).trim();
			branch = value === "(detached)" || value.length === 0 ? null : value;
			continue;
		}
		if (line.startsWith("# branch.oid ")) {
			const value = line.slice("# branch.oid ".length).trim();
			commit = value === "(initial)" ? "" : value;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			const value = line.slice("# branch.upstream ".length).trim();
			upstreamRef = value.length === 0 ? null : value;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(line.trim());
			if (match?.[1] !== undefined && match[2] !== undefined) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}
		if (line.startsWith("# ")) continue;
		if (line.startsWith("? ")) {
			untracked += 1;
			continue;
		}
		if (line.startsWith("! ")) continue;
		if (line.startsWith("u ")) {
			conflicted += 1;
			continue;
		}
		if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
		const fields = line.split(" ");
		const xy = fields[1] ?? "";
		if (xy.length < 2) continue;
		if (xy[0] !== ".") staged += 1;
		if (xy[1] !== ".") modified += 1;
	}
	return {
		ahead,
		behind,
		branch,
		commit,
		dirty: { conflicted, modified, staged, untracked },
		upstreamRef,
	};
}

/** Parse `git remote -v`; a remote with no separate push URL reuses its fetch URL. */
export function parseRemoteList(output: string): RepositoryRemoteInfo[] {
	const remotes = new Map<string, { fetchUrl: string; pushUrl?: string }>();
	for (const line of output.split("\n")) {
		const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim());
		if (match === null) continue;
		const [, name, url, kind] = match;
		if (name === undefined || url === undefined) continue;
		const entry = remotes.get(name) ?? { fetchUrl: "", pushUrl: "" };
		if (kind === "push") entry.pushUrl = url;
		else entry.fetchUrl = url;
		remotes.set(name, entry);
	}
	return [...remotes.entries()].map(([name, entry]) => ({
		fetchUrl: entry.fetchUrl,
		name,
		pushUrl: entry.pushUrl !== undefined && entry.pushUrl !== "" ? entry.pushUrl : entry.fetchUrl,
	}));
}

/** Parse `git worktree list --porcelain`; blocks are separated by a blank line. */
export function parseWorktreeList(output: string): RepositoryWorktreeInfo[] {
	const worktrees: RepositoryWorktreeInfo[] = [];
	let path: string | undefined;
	let head = "";
	let branch: string | null = null;
	let locked = false;
	const flush = (): void => {
		if (path === undefined) return;
		worktrees.push({ branch, head, locked, path });
		path = undefined;
		head = "";
		branch = null;
		locked = false;
	};
	for (const line of output.split("\n")) {
		if (line.trim().length === 0) {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) {
			flush();
			path = line.slice("worktree ".length).trim();
			continue;
		}
		if (line.startsWith("HEAD ")) {
			head = line.slice("HEAD ".length).trim();
			continue;
		}
		if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			continue;
		}
		if (line === "detached") {
			branch = null;
			continue;
		}
		if (line.startsWith("locked")) {
			locked = true;
		}
	}
	flush();
	return worktrees;
}

/** Parse the tab-separated `for-each-ref` format used for tags. */
export function parseTagList(output: string): RepositoryTagInfo[] {
	const tags: RepositoryTagInfo[] = [];
	for (const line of output.split("\n")) {
		const [name, commit] = line.trim().split("\t");
		if (name === undefined || name.length === 0) continue;
		tags.push({ commit: commit ?? "", name });
	}
	return tags;
}

export class RepositoryService {
	readonly #allowPush: boolean;
	readonly #git: GitCli;
	readonly #logger: Logger | undefined;
	readonly #maxTags: number;
	readonly #maxWorktrees: number;
	readonly #repositoryPath: string;
	readonly #versionFile: string;

	constructor(options: RepositoryServiceOptions) {
		this.#allowPush = options.allowPush === true;
		this.#git = options.git ?? new GitCli({ repositoryPath: options.repositoryPath });
		this.#logger = options.logger;
		this.#maxTags = options.maxTags ?? DEFAULT_MAX_TAGS;
		this.#maxWorktrees = options.maxWorktrees ?? DEFAULT_MAX_WORKTREES;
		this.#repositoryPath = options.repositoryPath;
		this.#versionFile = options.versionFile ?? DEFAULT_VERSION_FILE;
	}

	async fetch(
		input: { readonly remote?: string; readonly token?: string } = {},
	): Promise<RepositoryStatus> {
		const env = gitCredentialEnvironment(input.token);
		await this.#git.run(["fetch", "--prune", this.#remote(input.remote)], {
			...(env === undefined ? {} : { env }),
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return await this.status();
	}

	/** Fast-forward only: a diverged branch fails instead of creating a merge commit. */
	async pull(
		input: { readonly remote?: string; readonly token?: string } = {},
	): Promise<RepositoryStatus> {
		const env = gitCredentialEnvironment(input.token);
		await this.#git.run(["pull", "--ff-only", this.#remote(input.remote)], {
			...(env === undefined ? {} : { env }),
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return await this.status();
	}

	/**
	 * Push the current (or named) branch. Two independent gates: the operator enabled pushing, and
	 * the caller confirmed this specific push. A GitHub App token, when supplied, is injected
	 * through the child environment only.
	 */
	async push(input: {
		readonly branch?: string;
		readonly confirm: boolean;
		readonly remote?: string;
		readonly token?: string;
	}): Promise<RepositoryStatus> {
		if (!this.#allowPush) {
			throw new RepositoryError("push_disabled: TSUKAIMA_ALLOW_PUSH is not enabled");
		}
		if (input.confirm !== true) {
			throw new RepositoryError("push_not_confirmed");
		}
		const remote = this.#remote(input.remote);
		const branch =
			input.branch === undefined ? await this.#currentBranch() : assertSafeBaseRef(input.branch);
		const env = gitCredentialEnvironment(input.token);
		await this.#git.run(["push", remote, branch], {
			...(env === undefined ? {} : { env }),
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return await this.status();
	}

	#remote(name: string | undefined): string {
		const remote = name ?? "origin";
		if (!REMOTE_NAME.test(remote)) throw new RepositoryError(`invalid_remote: ${remote}`);
		return remote;
	}

	async #currentBranch(): Promise<string> {
		const branch = (await this.#git.tryRun(["symbolic-ref", "--short", "-q", "HEAD"]))?.trim();
		if (branch === undefined || branch.length === 0) {
			throw new RepositoryError("detached_head: check out a branch before pushing");
		}
		return assertSafeBaseRef(branch);
	}

	async status(): Promise<RepositoryStatus> {
		const statusResult = await this.#git.exec([
			"status",
			"--porcelain=v2",
			"--branch",
			"--untracked-files=normal",
		]);
		if (statusResult.exitCode !== 0) {
			const detail = statusResult.stderr.trim() || statusResult.stdout.trim();
			this.#logger?.warn("repository status failed", { error: detail });
			throw new RepositoryError(
				detail.length > 0 ? `git status failed: ${detail}` : "git status failed",
			);
		}
		const parsed = parseStatusPorcelainV2(statusResult.stdout);
		const [head, remotes, worktrees, tags, version] = await Promise.all([
			this.#headInfo(parsed.commit),
			this.#remotes(),
			this.#worktrees(),
			this.#tags(),
			this.#version(),
		]);
		return {
			branch: parsed.branch,
			dirty: parsed.dirty,
			head,
			pushed: parsed.upstreamRef !== null && parsed.ahead === 0,
			remotes,
			tags,
			upstream:
				parsed.upstreamRef === null
					? null
					: {
							ahead: parsed.ahead,
							behind: parsed.behind,
							ref: parsed.upstreamRef,
							remote: parsed.upstreamRef.split("/")[0] ?? parsed.upstreamRef,
						},
			version,
			worktrees,
		};
	}

	async #headInfo(commit: string): Promise<RepositoryHeadInfo> {
		if (commit.length === 0) return { authoredAt: "", commit: "", subject: "" };
		const output = await this.#git.tryRun([
			"log",
			"-1",
			`--format=%H${UNIT_SEPARATOR}%aI${UNIT_SEPARATOR}%s`,
		]);
		if (output === undefined) return { authoredAt: "", commit, subject: "" };
		const [hash, authoredAt, ...subjectParts] = output.trim().split(UNIT_SEPARATOR);
		return {
			authoredAt: authoredAt ?? "",
			commit: hash === undefined || hash.length === 0 ? commit : hash,
			subject: subjectParts.join(UNIT_SEPARATOR),
		};
	}

	async #remotes(): Promise<RepositoryRemoteInfo[]> {
		const output = await this.#git.tryRun(["remote", "-v"]);
		return output === undefined ? [] : parseRemoteList(output);
	}

	async #worktrees(): Promise<RepositoryWorktreeInfo[]> {
		const output = await this.#git.tryRun(["worktree", "list", "--porcelain"]);
		return output === undefined ? [] : parseWorktreeList(output).slice(0, this.#maxWorktrees);
	}

	async #tags(): Promise<RepositoryTagInfo[]> {
		const output = await this.#git.tryRun([
			"for-each-ref",
			`--count=${this.#maxTags}`,
			"--sort=-creatordate",
			`--format=%(refname:short)%09%(objectname:short)`,
			"refs/tags",
		]);
		return output === undefined ? [] : parseTagList(output);
	}

	/**
	 * The version the checkout claims, preferring the committed file so a dirty working tree cannot
	 * misreport the revision that is actually running. Falls back to the working copy when HEAD has
	 * no version file (an unborn branch, or a repository that is not Tsukaima).
	 */
	async #version(): Promise<string> {
		const committed = await this.#git.tryRun(["show", `HEAD:${this.#versionFile}`]);
		if (committed !== undefined) return committed.trim();
		const file = Bun.file(join(this.#repositoryPath, this.#versionFile));
		const text = await file.text().catch(() => undefined);
		return text?.trim() ?? "";
	}
}
