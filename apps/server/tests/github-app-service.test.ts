import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import {
	appKeyFingerprint,
	GitHubAppError,
	GitHubAppService,
	signAppJwt,
} from "../src/services/github-app-service.ts";
import { GitHubService, parseGitHubRemote } from "../src/services/github-service.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { format: "pem", type: "pkcs8" },
	publicKeyEncoding: { format: "pem", type: "spki" },
});

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

async function testDatabase(): Promise<ReturnType<typeof openDomainDatabase>> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-github-"));
	directories.push(root);
	const database = await openDomainDatabase(join(root, "domain.sqlite"));
	migrateDomainDatabase(database);
	return database;
}

function installationBody(appId = 7): unknown {
	return {
		account: { login: "example-org" },
		app_id: appId,
		permissions: { contents: "write", metadata: "read", pull_requests: "write" },
		repository_selection: "selected",
	};
}

function tokenBody(nowMs: number): unknown {
	return {
		expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
		token: "synthetic-installation-token",
	};
}

function repositoriesBody(): unknown {
	return {
		repositories: [
			{
				full_name: "example-org/sample",
				name: "sample",
				owner: { login: "example-org" },
				private: true,
			},
		],
	};
}

describe("signAppJwt", () => {
	test("signs a nine-minute RS256 token that verifies against the public key", () => {
		const nowMs = Date.parse("2026-11-17T00:00:00.000Z");
		const jwt = signAppJwt({ appId: 7, nowMs, privateKey });
		const [header, payload, signature] = jwt.split(".");
		expect(header).toBeDefined();
		expect(payload).toBeDefined();
		expect(signature).toBeDefined();

		const decodedHeader = JSON.parse(Buffer.from(header ?? "", "base64url").toString()) as {
			alg: string;
			typ: string;
		};
		const decodedPayload = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
			exp: number;
			iat: number;
			iss: number;
		};
		expect(decodedHeader).toEqual({ alg: "RS256", typ: "JWT" });
		expect(decodedPayload.iss).toBe(7);
		expect(decodedPayload.iat).toBe(Math.floor(nowMs / 1000) - 60);
		expect(decodedPayload.exp - decodedPayload.iat).toBe(600);
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(`${header}.${payload}`),
				publicKey,
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
	});
});

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

describe("GitHubAppService", () => {
	test("validates, stores, and reports an installation without exposing secrets", async () => {
		const database = await testDatabase();
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-app-"));
		directories.push(root);
		const nowMs = Date.parse("2026-11-17T00:00:00.000Z");
		const calls: string[] = [];
		const service = new GitHubAppService({
			dataDir: root,
			database: () => database,
			fetcher: (async (input: string | URL | Request) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith("/app/installations/42")) return jsonResponse(installationBody());
				if (url.endsWith("/app/installations/42/access_tokens")) {
					return jsonResponse(tokenBody(nowMs));
				}
				if (url.includes("/installation/repositories")) return jsonResponse(repositoriesBody());
				return jsonResponse({ message: "unexpected" }, 404);
			}) as typeof fetch,
			now: () => nowMs,
		});

		const status = await service.configure({
			appId: 7,
			installationId: 42,
			privateKey,
		});
		expect(status).toEqual({
			account: "example-org",
			appId: 7,
			configured: true,
			installationId: 42,
			keyFingerprint: appKeyFingerprint(privateKey),
			permissions: { contents: "write", metadata: "read", pull_requests: "write" },
			repositorySelection: "selected",
			tokenExpiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
		});
		expect(calls.some((url) => url.endsWith("/app/installations/42/access_tokens"))).toBe(true);
		expect(JSON.stringify(status)).not.toContain("synthetic-installation-token");
		expect(JSON.stringify(await service.status())).not.toContain("PRIVATE KEY");

		const secretPath = join(root, "secrets", "github-app.pem");
		expect(await readFile(secretPath, "utf8")).toBe(privateKey);
		expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
		expect((await stat(join(root, "secrets"))).mode & 0o777).toBe(0o700);
	});

	test("maps a missing installation and an App mismatch to distinct errors", async () => {
		const database = await testDatabase();
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-app-"));
		directories.push(root);
		const missing = new GitHubAppService({
			dataDir: root,
			database: () => database,
			fetcher: (async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch,
		});
		const missingError = await missing
			.configure({ appId: 7, installationId: 42, privateKey })
			.catch((error: unknown) => error);
		expect(missingError).toBeInstanceOf(GitHubAppError);
		expect((missingError as GitHubAppError).code).toBe("github_app_installation_not_found");

		const mismatch = new GitHubAppService({
			dataDir: root,
			database: () => database,
			fetcher: (async () => jsonResponse(installationBody(999))) as unknown as typeof fetch,
		});
		const mismatchError = await mismatch
			.configure({ appId: 7, installationId: 42, privateKey })
			.catch((error: unknown) => error);
		expect((mismatchError as GitHubAppError).code).toBe("github_app_installation_mismatch");
	});

	test("rejects a malformed private key before writing anything", async () => {
		const database = await testDatabase();
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-app-"));
		directories.push(root);
		const service = new GitHubAppService({
			dataDir: root,
			database: () => database,
			fetcher: (async () => jsonResponse({})) as unknown as typeof fetch,
		});
		const error = await service
			.configure({ appId: 7, installationId: 42, privateKey: "not a pem" })
			.catch((value: unknown) => value);
		expect((error as GitHubAppError).code).toBe("github_app_invalid_private_key");
		expect((await service.status()).configured).toBe(false);
	});

	test("reuses a cached token and refreshes it near expiry", async () => {
		const database = await testDatabase();
		const root = await mkdtemp(join(tmpdir(), "tsukaima-github-app-"));
		directories.push(root);
		let nowMs = Date.parse("2026-11-17T00:00:00.000Z");
		let minted = 0;
		const service = new GitHubAppService({
			dataDir: root,
			database: () => database,
			fetcher: (async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/app/installations/42")) return jsonResponse(installationBody());
				if (url.endsWith("/app/installations/42/access_tokens")) {
					minted += 1;
					return jsonResponse({
						...(tokenBody(nowMs) as object),
						token: `synthetic-token-${minted}`,
					});
				}
				return jsonResponse(repositoriesBody());
			}) as typeof fetch,
			now: () => nowMs,
		});
		await service.configure({ appId: 7, installationId: 42, privateKey });
		expect(minted).toBe(1);

		expect(await service.installationToken()).toBe("synthetic-token-1");
		expect(minted).toBe(1);

		nowMs += 55 * 60_000;
		expect(await service.installationToken()).toBe("synthetic-token-2");
		expect(minted).toBe(2);
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
			app: {
				installationToken: async () => "synthetic-installation-token",
				repositories: async () => [
					{
						fullName: "example-org/sample",
						name: "sample",
						owner: "example-org",
						private: true,
					},
				],
			} as unknown as GitHubAppService,
			fetcher: (async (input: string | URL | Request) => {
				const url = String(input);
				requested.push(url);
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
			app: {} as unknown as GitHubAppService,
			fetcher: (async () => jsonResponse({})) as unknown as typeof fetch,
			repositoryPath: root,
		});
		await expect(service.runs({ sha: "main" })).rejects.toThrow(GitHubAppError);
	});
});
