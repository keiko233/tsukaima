import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GitHubCliError,
	GitHubCliService,
	githubHostFromApiUrl,
	type GhCommandOptions,
	type GhCommandResult,
	type GhLoginProcess,
} from "../src/services/github-cli-service.ts";

const directories: string[] = [];
const realNow = Date.parse("2026-11-18T00:00:00.000Z");

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function result(stdout = "", stderr = "", exitCode = 0): GhCommandResult {
	return { exitCode, stderr, stdout };
}

function successStatus(login = "example-user"): GhCommandResult {
	return result(
		JSON.stringify({
			hosts: {
				"github.com": [
					{
						active: true,
						gitProtocol: "https",
						host: "github.com",
						login,
						scopes: ["repo", "read:org"],
						state: "success",
					},
				],
			},
		}),
	);
}

function emptyStatus(): GhCommandResult {
	return result(JSON.stringify({ hosts: {} }), "You are not logged into any GitHub hosts.");
}

class FakeLoginProcess implements GhLoginProcess {
	exitCode: number | null = null;
	killed = false;
	readonly #errors: ((error: Error) => void)[] = [];
	readonly #exits: ((exitCode: number | null) => void)[] = [];
	readonly #outputs: ((chunk: string) => void)[] = [];

	kill(): void {
		this.killed = true;
	}

	onError(listener: (error: Error) => void): void {
		this.#errors.push(listener);
	}

	onExit(listener: (exitCode: number | null) => void): void {
		this.#exits.push(listener);
	}

	onOutput(listener: (chunk: string) => void): void {
		this.#outputs.push(listener);
	}

	emitError(error: Error): void {
		for (const listener of this.#errors) listener(error);
	}

	emitOutput(chunk: string): void {
		for (const listener of this.#outputs) listener(chunk);
	}

	finish(exitCode: number | null): void {
		this.exitCode = exitCode;
		for (const listener of this.#exits) listener(exitCode);
	}
}

async function harness(
	exec: (args: readonly string[], options: GhCommandOptions) => Promise<GhCommandResult>,
	options: {
		readonly now?: () => number;
		readonly spawnLogin?: (
			args: readonly string[],
			options: { readonly env: Readonly<Record<string, string>> },
		) => GhLoginProcess;
	} = {},
): Promise<{ root: string; service: GitHubCliService }> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-github-cli-"));
	directories.push(root);
	return {
		root,
		service: new GitHubCliService({
			dataDir: root,
			exec,
			now: options.now ?? (() => realNow),
			...(options.spawnLogin === undefined ? {} : { spawnLogin: options.spawnLogin }),
		}),
	};
}

async function waitForFakeLogin(
	fake: () => FakeLoginProcess | undefined,
): Promise<FakeLoginProcess> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const process = fake();
		if (process !== undefined) return process;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("the synthetic login process did not start");
}

describe("githubHostFromApiUrl", () => {
	test("maps the public API to github.com and keeps an Enterprise host", () => {
		expect(githubHostFromApiUrl("https://api.github.com")).toBe("github.com");
		expect(githubHostFromApiUrl("https://ghe.example.test/api/v3")).toBe("ghe.example.test");
	});
});

describe("GitHubCliService", () => {
	test("reads the active account from gh auth status", async () => {
		const calls: string[][] = [];
		const { service } = await harness(async (args, options) => {
			calls.push([...args]);
			expect(options.env.GH_CONFIG_DIR).toContain("gh");
			expect(options.env.GH_PROMPT_DISABLED).toBe("1");
			return successStatus();
		});

		expect(await service.status()).toEqual({
			available: true,
			configured: true,
			error: null,
			gitProtocol: "https",
			host: "github.com",
			login: "example-user",
			scopes: ["repo", "read:org"],
		});
		expect(calls[0]).toEqual(["auth", "status", "--json", "hosts", "--hostname", "github.com"]);
	});

	test("reports an unauthenticated host without treating gh's note as an error", async () => {
		const { service } = await harness(async () => emptyStatus());
		expect(await service.status()).toEqual({
			available: true,
			configured: false,
			error: null,
			gitProtocol: null,
			host: "github.com",
			login: null,
			scopes: [],
		});
	});

	test("reports a missing gh binary distinctly", async () => {
		const { service } = await harness(async () => {
			throw new GitHubCliError("github_cli_missing", "GitHub CLI (gh) is not installed");
		});
		const status = await service.status();
		expect(status.available).toBe(false);
		expect(status.configured).toBe(false);
		expect(status.error).toContain("not installed");
	});

	test("returns a trimmed token and strips ambient credential variables", async () => {
		let captured: GhCommandOptions | undefined;
		const { service } = await harness(async (args, options) => {
			expect(args).toEqual(["auth", "token", "--hostname", "github.com"]);
			captured = options;
			return result("synthetic-user-token\n");
		});

		expect(await service.token()).toBe("synthetic-user-token");
		expect(captured?.env.GH_TOKEN).toBeUndefined();
		expect(captured?.env.GITHUB_TOKEN).toBeUndefined();
		expect(captured?.env.GH_PROMPT_DISABLED).toBe("1");
	});

	test("maps a missing session to an actionable authentication error", async () => {
		const { service } = await harness(async () =>
			result("", "You are not logged into any GitHub hosts.", 1),
		);
		const error = await service.token().catch((value: unknown) => value);
		expect(error).toBeInstanceOf(GitHubCliError);
		expect((error as GitHubCliError).code).toBe("github_not_authenticated");
		expect((error as Error).message).toContain("not signed in");
	});

	test("starts a login, exposes only the device code, and polls to success", async () => {
		let fake: FakeLoginProcess | undefined;
		const { service } = await harness(
			async (args) => {
				expect(args[0]).toBe("auth");
				return successStatus();
			},
			{
				spawnLogin: (args, options) => {
					expect(args.slice(0, 7)).toEqual([
						"auth",
						"login",
						"--hostname",
						"github.com",
						"--git-protocol",
						"https",
						"--web",
					]);
					expect(options.env.GH_CONFIG_DIR).toContain("gh");
					fake = new FakeLoginProcess();
					return fake;
				},
			},
		);

		const login = service.startLogin();
		const process = await waitForFakeLogin(() => fake);
		process.emitOutput("! First copy your one-time code: ABCD-1234\n");
		process.emitOutput(
			"Open this URL to continue in your web browser: https://github.com/login/device\n",
		);
		expect(await login).toEqual({
			expiresAt: new Date(realNow + 10 * 60_000).toISOString(),
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
		});
		expect(await service.pollLogin()).toEqual({ status: "pending" });

		process.finish(0);
		expect(await service.pollLogin()).toEqual({
			login: "example-user",
			status: "authorized",
		});
	});

	test("rejects a login process that exits before printing a code", async () => {
		let fake: FakeLoginProcess | undefined;
		const { service } = await harness(async () => successStatus(), {
			spawnLogin: () => {
				fake = new FakeLoginProcess();
				return fake;
			},
		});
		const login = service.startLogin();
		const process = await waitForFakeLogin(() => fake);
		process.emitOutput("! Failed to authenticate\n");
		process.finish(1);
		await expect(login).rejects.toThrow(/Failed to authenticate|GitHub CLI/u);
	});

	test("expires a stale login and kills its process", async () => {
		let nowMs = realNow;
		let fake: FakeLoginProcess | undefined;
		const { service } = await harness(async () => successStatus(), {
			now: () => nowMs,
			spawnLogin: () => {
				fake = new FakeLoginProcess();
				return fake;
			},
		});
		const login = service.startLogin();
		const process = await waitForFakeLogin(() => fake);
		process.emitOutput("! First copy your one-time code: ABCD-1234\n");
		await login;

		nowMs += 10 * 60_000 + 1;
		expect(await service.pollLogin()).toEqual({ status: "expired" });
		expect(process.killed).toBe(true);
	});

	test("signs out only the active account", async () => {
		const calls: string[][] = [];
		let statusCalls = 0;
		const { service } = await harness(async (args) => {
			calls.push([...args]);
			if (args[1] === "status") {
				statusCalls += 1;
				return statusCalls === 1 ? successStatus() : emptyStatus();
			}
			if (args[1] === "logout") return result("✓ Logged out");
			throw new Error(`unexpected gh ${args.join(" ")}`);
		});

		const status = await service.logout();
		expect(status.configured).toBe(false);
		expect(calls.find((args) => args[1] === "logout")).toEqual([
			"auth",
			"logout",
			"--hostname",
			"github.com",
			"--user",
			"example-user",
		]);
	});
});
