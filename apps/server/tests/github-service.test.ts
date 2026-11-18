import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubCliError } from "../src/services/github-cli-service.ts";
import {
	GitHubService,
	parseGitHubRemote,
	type GitHubCredentialSource,
} from "../src/services/github-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function syntheticAuth(): GitHubCredentialSource {
	return {
		gitCredential: async () => "synthetic-user-token",
		token: async () => "synthetic-user-token",
	};
}

describe("parseGitHubRemote", () => {
	test("reads HTTPS, ssh, and scp remotes", () => {
		expect(parseGitHubRemote("https://github.com/example-org/sample.git")).toEqual({
			owner: "example-org",
			repo: "sample",
		});
		expect(parseGitHubRemote("https://github.com/example-org/sample")).toEqual({
			owner: "example-org",
			repo: "sample",
		});
		expect(parseGitHubRemote("git@github.com:example-org/sample.git")).toEqual({
			owner: "example-org",
			repo: "sample",
		});
		expect(parseGitHubRemote("ssh://git@github.com/example-org/sample.git")).toEqual({
			owner: "example-org",
			repo: "sample",
		});
	});

	test("rejects paths that are not a remote", () => {
		expect(parseGitHubRemote("/synthetic/workspace/repo")).toBeUndefined();
		expect(parseGitHubRemote("file:///synthetic/workspace/repo")).toBeUndefined();
		expect(parseGitHubRemote("https://github.com/../sample.git")).toBeUndefined();
	});
});

describe("GitHubService", () => {
	test("reads open pull requests, issues, and runs for a commit", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-reads-"));
		directories.push(root);
		execFileSync("git", ["init", "-b", "main"], { cwd: root });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://example.test/example-org/sample.git"],
			{ cwd: root },
		);
		const requested: string[] = [];
		const service = new GitHubService({
			auth: syntheticAuth(),
			fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requested.push(url);
				expect(new Headers(init?.headers).get("authorization")).toBe(
					["Bearer", "synthetic-user-token"].join(" "),
				);
				if (url.includes("/pulls?")) {
					return jsonResponse([
						{
							base: { ref: "main" },
							draft: false,
							head: { ref: "feature" },
							html_url: "https://example.test/example-org/sample/pull/1",
							mergeable: null,
							merged_at: null,
							number: 1,
							state: "open",
							title: "Synthetic pull request",
						},
					]);
				}
				if (url.includes("/issues?")) {
					return jsonResponse([
						{
							html_url: "https://example.test/example-org/sample/issues/2",
							labels: [{ name: "bug" }],
							number: 2,
							title: "Synthetic issue",
						},
						{
							html_url: "https://example.test/example-org/sample/pull/3",
							labels: [],
							number: 3,
							pull_request: {},
							title: "Synthetic PR in the issue list",
						},
					]);
				}
				if (url.includes("/actions/runs?")) {
					return jsonResponse({
						workflow_runs: [
							{
								conclusion: "success",
								created_at: "2026-11-17T00:00:00.000Z",
								head_sha: "0123456789abcdef",
								html_url: "https://example.test/example-org/sample/actions/runs/1",
								id: 1,
								name: "checks",
								status: "completed",
							},
						],
					});
				}
				return jsonResponse({ message: "unexpected" }, 404);
			}) as typeof fetch,
			repositoryPath: root,
		});

		expect(await service.pulls()).toEqual([
			{
				base: "main",
				checks: "none",
				draft: false,
				head: "feature",
				mergeable: "unknown",
				number: 1,
				state: "open",
				title: "Synthetic pull request",
				url: "https://example.test/example-org/sample/pull/1",
			},
		]);
		expect(await service.issues()).toEqual([
			{
				labels: ["bug"],
				number: 2,
				title: "Synthetic issue",
				url: "https://example.test/example-org/sample/issues/2",
			},
		]);
		expect(await service.runs({ sha: "0123456789abcdef" })).toEqual([
			{
				conclusion: "success",
				createdAt: "2026-11-17T00:00:00.000Z",
				headSha: "0123456789abcdef",
				id: 1,
				name: "checks",
				status: "completed",
				url: "https://example.test/example-org/sample/actions/runs/1",
			},
		]);
		expect(
			requested.every((url) => url.startsWith("https://api.github.com/repos/example-org/sample")),
		).toBe(true);
	});

	test("rejects a ref-shaped commit id", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-reads-"));
		directories.push(root);
		const service = new GitHubService({
			auth: syntheticAuth(),
			fetcher: (async () => jsonResponse({})) as unknown as typeof fetch,
			repositoryPath: root,
		});
		await expect(service.runs({ sha: "main" })).rejects.toBeInstanceOf(GitHubCliError);
	});

	test("requires an origin remote before reading activity", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-reads-"));
		directories.push(root);
		const service = new GitHubService({
			auth: syntheticAuth(),
			fetcher: (async () => jsonResponse([])) as unknown as typeof fetch,
			repositoryPath: root,
		});
		await expect(service.pulls()).rejects.toThrow(/no GitHub remote/u);
	});

	test("delegates the git credential to the gh session", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-reads-"));
		directories.push(root);
		const service = new GitHubService({
			auth: syntheticAuth(),
			repositoryPath: root,
		});
		expect(await service.gitCredential()).toBe("synthetic-user-token");
	});
});
