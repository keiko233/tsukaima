import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCli, GitCommandResult } from "@tsukaima/coding";
import {
	parseRemoteList,
	parseStatusPorcelainV2,
	parseTagList,
	parseWorktreeList,
	RepositoryError,
	RepositoryService,
} from "../src/services/repository-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function git(cwd: string, args: readonly string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args],
		{ cwd },
	).toString();
}

/**
 * A local clone of a bare `<fixture>.git` remote, so branch, upstream, and `pushed` exercise the
 * real configuration a deployment checkout has.
 */
async function cloneWithUpstream(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-repository-"));
	directories.push(root);
	const remote = join(root, "origin.git");
	const seed = join(root, "seed");
	const local = join(root, "local");
	execFileSync("git", ["init", "--bare", remote]);
	execFileSync("git", ["clone", remote, seed]);
	git(seed, ["checkout", "-b", "main"]);
	await writeFile(join(seed, "VERSION"), "1.2.3\n");
	await writeFile(join(seed, "README.md"), "# Fixture\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "initial commit"]);
	git(seed, ["tag", "v1.2.3"]);
	git(seed, ["push", "--tags", "-u", "origin", "main"]);
	execFileSync("git", ["clone", "--branch", "main", remote, local]);
	return local;
}

describe("parseStatusPorcelainV2", () => {
	test("reads branch, upstream, and counts from a v2 status", () => {
		const parsed = parseStatusPorcelainV2(
			[
				"# branch.oid 1111111111111111111111111111111111111111",
				"# branch.head main",
				"# branch.upstream origin/main",
				"# branch.ab +2 -3",
				"1 .M N... 100644 100644 100644 aaa bbb README.md",
				"1 A. N... 000000 100644 100644 000 ccc added.ts",
				"2 R. N... 100644 100644 100644 ddd eee R100 renamed.ts\told.ts",
				"u UU N... 100644 100644 100644 100644 fff ggg hhh conflict.ts",
				"? untracked.ts",
				"! ignored.log",
			].join("\n"),
		);
		expect(parsed.branch).toBe("main");
		expect(parsed.upstreamRef).toBe("origin/main");
		expect(parsed.ahead).toBe(2);
		expect(parsed.behind).toBe(3);
		expect(parsed.commit).toBe("1111111111111111111111111111111111111111");
		expect(parsed.dirty).toEqual({ conflicted: 1, modified: 1, staged: 2, untracked: 1 });
	});

	test("reports a detached HEAD and an unborn branch", () => {
		const detached = parseStatusPorcelainV2(
			["# branch.oid aaaa", "# branch.head (detached)"].join("\n"),
		);
		expect(detached.branch).toBeNull();
		expect(detached.upstreamRef).toBeNull();
		expect(detached.commit).toBe("aaaa");

		const unborn = parseStatusPorcelainV2(
			["# branch.oid (initial)", "# branch.head main"].join("\n"),
		);
		expect(unborn.commit).toBe("");
		expect(unborn.branch).toBe("main");
	});
});

describe("parseRemoteList", () => {
	test("pairs fetch and push URLs, defaulting push to fetch", () => {
		expect(
			parseRemoteList(
				[
					"origin\thttps://example.test/owner/repo.git (fetch)",
					"origin\thttps://example.test/owner/repo.git (push)",
					"mirror\thttps://example.test/mirror/repo.git (fetch)",
				].join("\n"),
			),
		).toEqual([
			{
				fetchUrl: "https://example.test/owner/repo.git",
				name: "origin",
				pushUrl: "https://example.test/owner/repo.git",
			},
			{
				fetchUrl: "https://example.test/mirror/repo.git",
				name: "mirror",
				pushUrl: "https://example.test/mirror/repo.git",
			},
		]);
	});
});

describe("parseWorktreeList", () => {
	test("reads each block, including detached and locked entries", () => {
		const parsed = parseWorktreeList(
			[
				"worktree /synthetic/workspace/repo",
				"HEAD 1111111111111111111111111111111111111111",
				"branch refs/heads/main",
				"",
				"worktree /synthetic/workspace/task-1",
				"HEAD 2222222222222222222222222222222222222222",
				"detached",
				"locked maintenance",
				"",
			].join("\n"),
		);
		expect(parsed).toEqual([
			{
				branch: "main",
				head: "1111111111111111111111111111111111111111",
				locked: false,
				path: "/synthetic/workspace/repo",
			},
			{
				branch: null,
				head: "2222222222222222222222222222222222222222",
				locked: true,
				path: "/synthetic/workspace/task-1",
			},
		]);
	});
});

describe("parseTagList", () => {
	test("reads tab-separated name and commit", () => {
		expect(parseTagList("v1.2.3\tabc1234\n\n")).toEqual([{ commit: "abc1234", name: "v1.2.3" }]);
	});
});

describe("RepositoryService", () => {
	test("reports a clean checkout that is pushed", async () => {
		const repositoryPath = await cloneWithUpstream();
		const status = await new RepositoryService({ repositoryPath }).status();

		expect(status.branch).toBe("main");
		expect(status.upstream).toEqual({
			ahead: 0,
			behind: 0,
			ref: "origin/main",
			remote: "origin",
		});
		expect(status.pushed).toBe(true);
		expect(status.dirty).toEqual({ conflicted: 0, modified: 0, staged: 0, untracked: 0 });
		expect(status.head.subject).toBe("initial commit");
		expect(status.version).toBe("1.2.3");
		expect(status.remotes).toHaveLength(1);
		expect(status.tags).toEqual([{ commit: status.tags[0]?.commit ?? "", name: "v1.2.3" }]);
		expect(status.worktrees.map((worktree) => worktree.branch)).toEqual(["main"]);
	});

	test("counts unstaged, staged, and untracked work separately", async () => {
		const repositoryPath = await cloneWithUpstream();
		await writeFile(join(repositoryPath, "README.md"), "# Changed\n");
		await writeFile(join(repositoryPath, "staged.ts"), "export const value = 1;\n");
		git(repositoryPath, ["add", "staged.ts"]);
		await writeFile(join(repositoryPath, "untracked.ts"), "export const other = 2;\n");

		const status = await new RepositoryService({ repositoryPath }).status();
		expect(status.dirty).toEqual({ conflicted: 0, modified: 1, staged: 1, untracked: 1 });
	});

	test("prefers the committed version over a dirty working copy", async () => {
		const repositoryPath = await cloneWithUpstream();
		await writeFile(join(repositoryPath, "VERSION"), "9.9.9\n");

		const status = await new RepositoryService({ repositoryPath }).status();
		expect(status.version).toBe("1.2.3");
		expect(status.dirty.modified).toBe(1);
	});

	test("reports a detached HEAD without an upstream", async () => {
		const repositoryPath = await cloneWithUpstream();
		git(repositoryPath, ["checkout", "--detach", "HEAD"]);

		const status = await new RepositoryService({ repositoryPath }).status();
		expect(status.branch).toBeNull();
		expect(status.pushed).toBe(false);
		expect(status.head.commit).toMatch(/^[0-9a-f]{40}$/u);
	});

	test("reports a checkout with no remote", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-repository-solo-"));
		directories.push(root);
		git(root, ["init", "-b", "main"]);
		await writeFile(join(root, "README.md"), "# Solo\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "solo commit"]);

		const status = await new RepositoryService({ repositoryPath: root }).status();
		expect(status.remotes).toEqual([]);
		expect(status.upstream).toBeNull();
		expect(status.pushed).toBe(false);
		expect(status.version).toBe("");
	});

	test("throws a typed error when the path is not a repository", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-repository-empty-"));
		directories.push(root);

		const service = new RepositoryService({ repositoryPath: root });
		await expect(service.status()).rejects.toThrow(RepositoryError);
	});
});

function gitResult(args: readonly string[], stdout = ""): GitCommandResult {
	return {
		args,
		cwd: "/synthetic/workspace/repo",
		durationMs: 1,
		exitCode: 0,
		signal: null,
		stderr: "",
		stderrTruncated: false,
		stdout,
		stdoutTruncated: false,
		timedOut: false,
	};
}

/** Records argv and env without touching a repository or a remote. */
function stubGit(): {
	readonly calls: {
		readonly args: readonly string[];
		readonly env?: Readonly<Record<string, string>>;
	}[];
	readonly git: GitCli;
} {
	const calls: {
		readonly args: readonly string[];
		readonly env?: Readonly<Record<string, string>>;
	}[] = [];
	const porcelain = [
		"# branch.oid 0123456789abcdef",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +0 -0",
	].join("\n");
	const client = {
		exec: async (args: readonly string[]) => {
			calls.push({ args });
			return gitResult(args, args[0] === "status" ? porcelain : "");
		},
		run: async (
			args: readonly string[],
			options?: { readonly env?: Readonly<Record<string, string>> },
		) => {
			calls.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
			return "";
		},
		tryRun: async (args: readonly string[]) => {
			calls.push({ args });
			if (args[0] === "symbolic-ref") return "main\n";
			if (args[0] === "show") return "1.0.0\n";
			return "";
		},
	} as unknown as GitCli;
	return { calls, git: client };
}

describe("RepositoryService writes", () => {
	test("fetch and pull address the allow-listed remote", async () => {
		const { calls, git: stub } = stubGit();
		const service = new RepositoryService({
			git: stub,
			repositoryPath: "/synthetic/workspace/repo",
		});

		await service.fetch();
		await service.fetch({ remote: "upstream" });
		await service.pull();
		expect(
			calls
				.filter((call) => call.args[0] === "fetch" || call.args[0] === "pull")
				.map((call) => call.args.join(" ")),
		).toEqual(["fetch --prune origin", "fetch --prune upstream", "pull --ff-only origin"]);
	});

	test("rejects a remote that could be parsed as an option", async () => {
		const { git: stub } = stubGit();
		const service = new RepositoryService({
			git: stub,
			repositoryPath: "/synthetic/workspace/repo",
		});
		await expect(service.fetch({ remote: "--upload-pack=evil" })).rejects.toThrow(RepositoryError);
	});

	test("refuses to push unless the operator enabled it", async () => {
		const { calls, git: stub } = stubGit();
		const service = new RepositoryService({
			git: stub,
			repositoryPath: "/synthetic/workspace/repo",
		});
		await expect(service.push({ confirm: true })).rejects.toThrow(/push_disabled/u);
		expect(calls.some((call) => call.args[0] === "push")).toBe(false);
	});

	test("requires an explicit confirmation even when pushing is enabled", async () => {
		const { git: stub } = stubGit();
		const service = new RepositoryService({
			allowPush: true,
			git: stub,
			repositoryPath: "/synthetic/workspace/repo",
		});
		await expect(service.push({ confirm: false })).rejects.toThrow(/push_not_confirmed/u);
	});

	test("pushes the current branch with the token only in the environment", async () => {
		const { calls, git: stub } = stubGit();
		const service = new RepositoryService({
			allowPush: true,
			git: stub,
			repositoryPath: "/synthetic/workspace/repo",
		});
		await service.push({ confirm: true, token: "synthetic-installation-token" });

		const push = calls.find((call) => call.args[0] === "push");
		expect(push?.args).toEqual(["push", "origin", "main"]);
		expect(push?.args.join(" ")).not.toContain("synthetic-installation-token");
		expect(push?.env?.GH_TOKEN).toBe("synthetic-installation-token");
		expect(push?.env?.GIT_CONFIG_VALUE_1).toContain("$GH_TOKEN");
		expect(calls.some((call) => call.args[0] === "symbolic-ref")).toBe(true);
	});

	test("refuses to push from a detached HEAD", async () => {
		const client = {
			exec: async (args: readonly string[]) => gitResult(args),
			run: async (args: readonly string[]) => {
				throw new Error(`unexpected ${args.join(" ")}`);
			},
			tryRun: async (args: readonly string[]) => (args[0] === "symbolic-ref" ? "" : ""),
		} as unknown as GitCli;
		const service = new RepositoryService({
			allowPush: true,
			git: client,
			repositoryPath: "/synthetic/workspace/repo",
		});
		await expect(service.push({ confirm: true })).rejects.toThrow(/detached_head/u);
	});
});
