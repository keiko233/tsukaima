import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodingRunner, CodingTools, parseDiffOutput } from "../src/index.ts";
import { cleanupTestRepo, createTestRepo, gitSync } from "./helpers.ts";

let repoPath: string;
let tools: CodingTools;

beforeAll(async () => {
	repoPath = await createTestRepo("tools");
	await writeFile(
		join(repoPath, "package.json"),
		JSON.stringify({ name: "tools-test", scripts: { build: "echo built" } }, null, "\t"),
	);
	await mkdir(join(repoPath, "src"), { recursive: true });
	await writeFile(
		join(repoPath, "src", "hello.ts"),
		"export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n",
	);
	await writeFile(
		join(repoPath, "src", "hello.test.ts"),
		'import { describe, expect, test } from "bun:test";\nimport { greet } from "./hello.ts";\n\ndescribe("greet", () => {\n\ttest("greets by name", () => {\n\t\texpect(greet("World")).toBe("Hello, World!");\n\t});\n});\n',
	);
	gitSync(repoPath, ["add", "."]);
	gitSync(repoPath, ["commit", "-m", "add source and test files"]);

	const runner = new CodingRunner({
		allowedCommands: ["bun", "git"],
		maxOutputBytes: 65536,
		timeoutMs: 30_000,
		worktreePath: repoPath,
	});
	tools = new CodingTools(runner);
});

afterAll(async () => {
	await cleanupTestRepo(repoPath);
});

describe("CodingTools", () => {
	test("runTests passes for valid test suite", async () => {
		const result = await tools.runTests();
		expect(result.passed).toBe(true);
		expect(result.total).toBeGreaterThanOrEqual(1);
		expect(result.failed).toBe(0);
	});

	test("build succeeds with simple script", async () => {
		const result = await tools.build();
		expect(result.success).toBe(true);
		expect(result.stdout).toContain("built");
	});

	test("diff detects modified tracked file", async () => {
		await writeFile(
			join(repoPath, "src", "hello.ts"),
			"export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n\nexport function farewell(name: string): string {\n\treturn `Goodbye, ${name}!`;\n}\n",
		);
		const result = await tools.diff();
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.path).toBe("src/hello.ts");
		expect(result.files[0]?.status).toBe("modified");
		expect(result.totalInsertions).toBeGreaterThan(0);
	});
});

describe("parseDiffOutput", () => {
	test("parses added, modified, and deleted files", () => {
		const numstat = "3\t0\tnew.ts\n1\t1\texisting.ts\n0\t5\tremoved.ts\n";
		const nameStatus = "A\tnew.ts\nM\texisting.ts\nD\tremoved.ts\n";
		const result = parseDiffOutput(numstat, nameStatus, "raw diff content");
		expect(result.files).toHaveLength(3);
		expect(result.files[0]).toEqual({
			deletions: 0,
			insertions: 3,
			path: "new.ts",
			status: "added",
		});
		expect(result.files[1]).toEqual({
			deletions: 1,
			insertions: 1,
			path: "existing.ts",
			status: "modified",
		});
		expect(result.files[2]).toEqual({
			deletions: 5,
			insertions: 0,
			path: "removed.ts",
			status: "deleted",
		});
		expect(result.totalInsertions).toBe(4);
		expect(result.totalDeletions).toBe(6);
		expect(result.raw).toBe("raw diff content");
	});

	test("handles binary files with -1 counts", () => {
		const result = parseDiffOutput("-\t-\tasset.bin\n", "M\tasset.bin\n", "");
		expect(result.files[0]?.insertions).toBe(-1);
		expect(result.files[0]?.deletions).toBe(-1);
		expect(result.files[0]?.status).toBe("modified");
	});

	test("returns empty result for empty input", () => {
		const result = parseDiffOutput("", "", "");
		expect(result.files).toHaveLength(0);
		expect(result.totalInsertions).toBe(0);
		expect(result.totalDeletions).toBe(0);
	});
});
