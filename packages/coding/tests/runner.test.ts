import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CodingRunner, CommandRejectedError } from "../src/index.ts";
import { cleanupTestRepo, createTestRepo } from "./helpers.ts";

let repoPath: string;

beforeAll(async () => {
	repoPath = await createTestRepo("runner");
});

afterAll(async () => {
	await cleanupTestRepo(repoPath);
});

interface RunnerOverrides {
	allowedCommands?: string[];
	env?: Record<string, string>;
	maxOutputBytes?: number;
	timeoutMs?: number;
}

function createRunner(overrides?: RunnerOverrides): CodingRunner {
	const config: Parameters<typeof CodingRunner.prototype.exec>[0] extends never
		? never
		: {
				allowedCommands: readonly string[];
				env?: Readonly<Record<string, string>>;
				maxOutputBytes: number;
				timeoutMs: number;
				worktreePath: string;
			} = {
		allowedCommands: overrides?.allowedCommands ?? ["echo", "printenv", "seq", "sleep", "git"],
		maxOutputBytes: overrides?.maxOutputBytes ?? 65536,
		timeoutMs: overrides?.timeoutMs ?? 5000,
		worktreePath: repoPath,
	};
	if (overrides?.env !== undefined) {
		return new CodingRunner({ ...config, env: overrides.env });
	}
	return new CodingRunner(config);
}

describe("CodingRunner", () => {
	test("rejects command not in allowlist", async () => {
		const runner = createRunner();
		await expect(runner.exec("curl", ["http://localhost:3000"])).rejects.toThrow(
			CommandRejectedError,
		);
	});

	test("rejects command with path separator", async () => {
		const runner = createRunner();
		await expect(runner.exec("./evil.sh")).rejects.toThrow(CommandRejectedError);
		await expect(runner.exec("bin/tool")).rejects.toThrow(CommandRejectedError);
	});

	test("executes allowed command and captures stdout", async () => {
		const runner = createRunner();
		const result = await runner.exec("echo", ["hello", "world"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello world\n");
		expect(result.stderr).toBe("");
		expect(result.timedOut).toBe(false);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("captures stderr from failing command", async () => {
		const runner = createRunner();
		const result = await runner.exec("git", ["rev-parse", "--verify", "nonexistent-ref-xyz"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	test("times out and kills long-running process", async () => {
		const runner = createRunner({ timeoutMs: 100 });
		const result = await runner.exec("sleep", ["5"]);
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(result.signal).toBe("SIGKILL");
	});

	test("truncates stdout beyond limit", async () => {
		const runner = createRunner({ maxOutputBytes: 16 });
		const result = await runner.exec("seq", ["1", "1000"]);
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(16);
	});

	test("does not truncate within limit", async () => {
		const runner = createRunner();
		const result = await runner.exec("echo", ["short output"]);
		expect(result.stdoutTruncated).toBe(false);
		expect(result.stdout).toBe("short output\n");
	});

	test("passes custom environment to child process", async () => {
		const runner = createRunner({
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MY_TEST_VAR: "coding-runner-env" },
		});
		const result = await runner.exec("printenv", ["MY_TEST_VAR"]);
		expect(result.stdout.trim()).toBe("coding-runner-env");
	});
});
