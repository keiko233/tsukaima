import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging.ts";
import { DependencyInstaller } from "../src/services/dependency-installer.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("DependencyInstaller", () => {
	test("skips installation when package.json does not exist in repository root", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-deps-"));
		directories.push(directory);
		let execCalled = false;
		const installer = new DependencyInstaller({
			exec: async () => {
				execCalled = true;
				return { exitCode: 0, stderr: "", stdout: "" };
			},
			repositoryRoot: directory,
		});

		await installer.install();
		expect(execCalled).toBe(false);
	});

	test("installs dependencies successfully with frozen lockfile", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-deps-"));
		directories.push(directory);
		await writeFile(join(directory, "package.json"), JSON.stringify({ name: "test-pkg" }));

		const calls: Array<{ args: readonly string[]; command: string; cwd: string }> = [];
		const installer = new DependencyInstaller({
			exec: async (command, args, options) => {
				calls.push({ args, command, cwd: options.cwd });
				return { exitCode: 0, stderr: "", stdout: "installed 10 packages" };
			},
			logger: createLogger({ capacity: 10, level: "error", target: "test" }),
			repositoryRoot: directory,
		});

		await installer.install();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(["install", "--frozen-lockfile"]);
		expect(calls[0]?.cwd).toBe(directory);
	});

	test("falls back to bun install when frozen-lockfile fails and succeeds", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-deps-"));
		directories.push(directory);
		await writeFile(join(directory, "package.json"), JSON.stringify({ name: "test-pkg" }));

		const calls: Array<{ args: readonly string[]; command: string }> = [];
		const installer = new DependencyInstaller({
			exec: async (command, args) => {
				calls.push({ args, command });
				if (args.includes("--frozen-lockfile")) {
					return { exitCode: 1, stderr: "lockfile had changes", stdout: "" };
				}
				return { exitCode: 0, stderr: "", stdout: "fallback success" };
			},
			logger: createLogger({ capacity: 10, level: "error", target: "test" }),
			repositoryRoot: directory,
		});

		await installer.install();
		expect(calls).toHaveLength(2);
		expect(calls[0]?.args).toEqual(["install", "--frozen-lockfile"]);
		expect(calls[1]?.args).toEqual(["install"]);
	});

	test("throws a descriptive error when both frozen-lockfile and fallback fail", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-deps-"));
		directories.push(directory);
		await writeFile(join(directory, "package.json"), JSON.stringify({ name: "test-pkg" }));

		const installer = new DependencyInstaller({
			exec: async (_command, args) => {
				if (args.includes("--frozen-lockfile")) {
					return { exitCode: 1, stderr: "error: lockfile mismatch", stdout: "" };
				}
				return { exitCode: 1, stderr: "error: Cannot find package foo@1.0.0", stdout: "" };
			},
			logger: createLogger({ capacity: 10, level: "error", target: "test" }),
			repositoryRoot: directory,
		});

		let thrown: Error | undefined;
		try {
			await installer.install();
		} catch (error) {
			thrown = error instanceof Error ? error : new Error(String(error));
		}

		expect(thrown).toBeDefined();
		expect(thrown?.message).toContain("Dependency installation failed");
		expect(thrown?.message).toContain("Cannot find package foo@1.0.0");
	});
});
