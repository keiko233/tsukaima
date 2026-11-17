import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import {
	deviceBaseUrl,
	GitHubOAuthError,
	GitHubOAuthService,
} from "../src/services/github-oauth-service.ts";

const directories: string[] = [];
const realNow = Date.parse("2026-11-18T00:00:00.000Z");

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
	const root = await mkdtemp(join(tmpdir(), "tsukaima-github-oauth-"));
	directories.push(root);
	const database = await openDomainDatabase(join(root, "domain.sqlite"));
	migrateDomainDatabase(database);
	return database;
}

interface HarnessOptions {
	readonly device?: () => unknown;
	readonly poll?: () => unknown;
	readonly now?: () => number;
}

async function harness(options: HarnessOptions = {}) {
	const database = await testDatabase();
	const calls: string[] = [];
	const service = new GitHubOAuthService({
		database: () => database,
		fetcher: (async (input: string | URL | Request) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/login/device/code")) {
				return jsonResponse(
					options.device?.() ?? {
						device_code: "device-synthetic",
						expires_in: 900,
						interval: 5,
						user_code: "ABCD-1234",
						verification_uri: "https://github.com/login/device",
					},
				);
			}
			if (url.endsWith("/login/oauth/access_token")) {
				return jsonResponse(options.poll?.() ?? { error: "authorization_pending" });
			}
			if (url.endsWith("/user")) {
				return jsonResponse({ login: "example-user" });
			}
			return jsonResponse({ message: "unexpected" }, 404);
		}) as unknown as typeof fetch,
		now: options.now ?? (() => realNow),
	});
	return { calls, service };
}

describe("deviceBaseUrl", () => {
	test("uses github.com for the public API and the web host for GHES", () => {
		expect(deviceBaseUrl("https://api.github.com")).toBe("https://github.com");
		expect(deviceBaseUrl("https://ghe.example.test/api/v3")).toBe("https://ghe.example.test");
	});
});

describe("GitHubOAuthService", () => {
	test("rejects a client id that is not an OAuth App instead of returning an invalid code", async () => {
		const { service } = await harness({
			device: () => ({ error: "Not Found", error_description: "Not Found" }),
		});
		await expect(service.start("synthetic-client-id")).rejects.toThrow(
			/GitHub rejected the device-code request|OAuth App/u,
		);
		expect(await service.status()).toEqual({
			clientId: null,
			configured: false,
			login: null,
			scopes: [],
		});
	});

	test("shows a code, polls, and stores the authorized user", async () => {
		let polls = 0;
		const { service } = await harness({
			poll: () => {
				polls += 1;
				return polls === 1
					? { error: "authorization_pending" }
					: { access_token: "synthetic-user-token", scope: "repo, read:user" };
			},
		});

		const start = await service.start("synthetic-client-id");
		expect(start).toEqual({
			expiresAt: new Date(realNow + 900_000).toISOString(),
			intervalSeconds: 5,
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
		});

		expect(await service.poll()).toEqual({ status: "pending" });
		expect(await service.poll()).toEqual({ status: "authorized", login: "example-user" });
		expect(await service.status()).toEqual({
			clientId: "synthetic-client-id",
			configured: true,
			login: "example-user",
			scopes: ["repo", "read:user"],
		});
		expect(await service.token()).toBe("synthetic-user-token");
		expect(JSON.stringify(await service.status())).not.toContain("synthetic-user-token");
	});

	test("reports an expired code instead of polling GitHub forever", async () => {
		let nowMs = realNow;
		const { service } = await harness({ now: () => nowMs });
		await service.start("synthetic-client-id");
		nowMs += 901_000;
		expect(await service.poll()).toEqual({ status: "expired" });
		expect((await service.status()).configured).toBe(false);
	});

	test("reports denial and unknown failures distinctly", async () => {
		const denied = await harness({ poll: () => ({ error: "access_denied" }) });
		await denied.service.start("synthetic-client-id");
		expect(await denied.service.poll()).toEqual({ status: "denied" });

		const broken = await harness({ poll: () => ({ error: "boom", error_description: "boom" }) });
		await broken.service.start("synthetic-client-id");
		await expect(broken.service.poll()).rejects.toThrow(GitHubOAuthError);
	});

	test("honors slow_down by increasing the polling interval", async () => {
		const { service } = await harness({ poll: () => ({ error: "slow_down", interval: 10 }) });
		await service.start("synthetic-client-id");
		expect(await service.poll()).toEqual({ status: "slow_down", intervalSeconds: 10 });
	});

	test("clears the stored token on sign-out", async () => {
		let polls = 0;
		const { service } = await harness({
			poll: () => {
				polls += 1;
				return { access_token: "synthetic-user-token", scope: "repo" };
			},
		});
		await service.start("synthetic-client-id");
		await service.poll();
		expect(await service.token()).toBe("synthetic-user-token");
		expect((await service.clear()).configured).toBe(false);
		expect(await service.token()).toBeUndefined();
		expect(polls).toBe(1);
	});

	test("returns idle when no device flow is running", async () => {
		const { service } = await harness();
		expect(await service.poll()).toEqual({ status: "idle" });
	});
});
