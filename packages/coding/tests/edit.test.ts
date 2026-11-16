import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyStructuredEdit,
	EditValidationError,
	readAllowedTextFile,
	WorktreeError,
	WorktreeManager,
} from "../src/index.ts";

let rootPath: string;
let repoPath: string;
let worktreePath: string;
let outsidePath: string;

const gitSync = (cwd: string, args: readonly string[]): void => {
	execFileSync(
		"git",
		["-c", "user.name=tsukaima-test", "-c", "user.email=test@tsukaima.invalid", ...args],
		{ cwd },
	);
};

beforeAll(async () => {
	rootPath = await fs.mkdtemp(join(tmpdir(), "tsukaima-coding-edit-"));
	repoPath = join(rootPath, "repo");
	await fs.mkdir(join(repoPath, "src"), { recursive: true });
	await fs.writeFile(join(repoPath, "src", "app.ts"), "export const value = 'old';\n");
	gitSync(repoPath, ["init", "-b", "main"]);
	gitSync(repoPath, ["add", "."]);
	gitSync(repoPath, ["commit", "-m", "add app"]);
	const manager = new WorktreeManager({
		pathAllowlist: ["src", "docs"],
		repositoryPath: repoPath,
		worktreeRoot: join(rootPath, "worktrees"),
	});
	const info = await manager.create("edit-task", "HEAD");
	worktreePath = info.path;
	outsidePath = join(rootPath, "outside");
	await fs.mkdir(outsidePath, { recursive: true });
	await fs.writeFile(join(outsidePath, "secret.txt"), "secret\n");
	await fs.symlink(outsidePath, join(worktreePath, "src", "escape"));
});

afterAll(async () => {
	await fs.rm(rootPath, { force: true, recursive: true });
});

describe("structured edits", () => {
	test("applies validated find/replace and creates new files inside the worktree", async () => {
		const replaced = await applyStructuredEdit(worktreePath, ["src"], {
			find: "old",
			path: "src/app.ts",
			replace: "new",
		});
		expect(replaced.path).toBe("src/app.ts");
		expect(await fs.readFile(join(worktreePath, "src", "app.ts"), "utf-8")).toContain("'new'");
		const created = await applyStructuredEdit(worktreePath, ["src"], {
			content: "export const added = true;\n",
			create: true,
			path: "src/added.ts",
		});
		expect(created.created).toBe(true);
		expect(created.checksum).toHaveLength(64);
	});

	test("rejects traversal, absolute paths, and symlink escapes", async () => {
		await expect(
			applyStructuredEdit(worktreePath, ["src"], {
				find: "old",
				path: "../outside.txt",
				replace: "new",
			}),
		).rejects.toThrow(EditValidationError);
		await expect(
			applyStructuredEdit(worktreePath, ["src"], {
				find: "old",
				path: "/etc/passwd",
				replace: "new",
			}),
		).rejects.toThrow(EditValidationError);
		await expect(
			applyStructuredEdit(worktreePath, ["src"], {
				content: "escaped",
				create: true,
				path: "src/escape/secret.txt",
			}),
		).rejects.toThrow(WorktreeError);
		await expect(
			applyStructuredEdit(worktreePath, ["src"], {
				content: "denied",
				create: true,
				path: "secrets/key.txt",
			}),
		).rejects.toThrow(WorktreeError);
	});

	test("reads only allowlisted bounded files", async () => {
		const file = await readAllowedTextFile(worktreePath, ["src"], "src/app.ts", 8);
		expect(file.truncated).toBe(true);
		expect(file.content).toHaveLength(8);
		await expect(
			readAllowedTextFile(worktreePath, ["src"], "src/escape/secret.txt"),
		).rejects.toThrow(WorktreeError);
	});
});
