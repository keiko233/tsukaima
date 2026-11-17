import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPathWithinAllowlist, WorktreeError, WorktreeManager } from "../src/index.ts";
import { cleanupTestRepo, createTestRepo } from "./helpers.ts";

let repoPath: string;
let manager: WorktreeManager;

beforeAll(async () => {
	repoPath = await createTestRepo("worktree");
	manager = new WorktreeManager({
		pathAllowlist: ["src", "docs"],
		repositoryPath: repoPath,
		worktreeRoot: join(repoPath, "..", "worktrees"),
	});
});

afterAll(async () => {
	await cleanupTestRepo(repoPath);
});

describe("WorktreeManager", () => {
	test("valid base ref passes validation", async () => {
		await manager.validateBaseRef("HEAD");
	});

	test("invalid base ref throws WorktreeError", async () => {
		await expect(manager.validateBaseRef("nonexistent-ref-xyz")).rejects.toThrow(WorktreeError);
	});

	test("rejects base refs that could be parsed as git options or syntax", async () => {
		await expect(manager.validateBaseRef("--help")).rejects.toThrow(WorktreeError);
		await expect(manager.validateBaseRef("-c core.pager=sh")).rejects.toThrow(WorktreeError);
		await expect(manager.validateBaseRef("HEAD^{commit}")).rejects.toThrow(WorktreeError);
		await expect(manager.create("test-injection", "--detach")).rejects.toThrow(WorktreeError);
	});

	test("creates worktree with expected branch and path", async () => {
		const info = await manager.create("test-create", "HEAD");
		expect(existsSync(info.path)).toBe(true);
		expect(info.branchName).toBe("tsukaima-iteration/test-create");
		expect(info.baseRef).toBe("HEAD");
		await manager.cleanup("test-create");
	});

	test("links the repository node_modules into the worktree", async () => {
		await mkdir(join(repoPath, "node_modules", "fixture"), { recursive: true });
		await writeFile(join(repoPath, "node_modules", "fixture", "index.js"), "export {};\n");
		const info = await manager.create("test-dependencies", "HEAD");
		const link = await lstat(join(info.path, "node_modules"));
		expect(link.isSymbolicLink()).toBe(true);
		expect(existsSync(join(info.path, "node_modules", "fixture", "index.js"))).toBe(true);
		await manager.cleanup("test-dependencies");
		await rm(join(repoPath, "node_modules"), { force: true, recursive: true });
	});

	test("cleanup removes worktree directory", async () => {
		const info = await manager.create("test-cleanup", "HEAD");
		expect(existsSync(info.path)).toBe(true);
		await manager.cleanup("test-cleanup");
		expect(existsSync(info.path)).toBe(false);
	});

	test("cleanup throws for unknown task", async () => {
		await expect(manager.cleanup("nonexistent-task-xyz")).rejects.toThrow(WorktreeError);
	});

	test("isPathAllowed enforces allowlist per worktree", async () => {
		await manager.create("test-path", "HEAD");
		expect(manager.isPathAllowed("test-path", "src/file.ts")).toBe(true);
		expect(manager.isPathAllowed("test-path", "src/nested/deep/file.ts")).toBe(true);
		expect(manager.isPathAllowed("test-path", "docs/readme.md")).toBe(true);
		expect(manager.isPathAllowed("test-path", "secrets/keys.txt")).toBe(false);
		expect(manager.isPathAllowed("test-path", "../outside.txt")).toBe(false);
		expect(manager.isPathAllowed("test-path", "/etc/passwd")).toBe(false);
		expect(manager.isPathAllowed("unknown-task", "src/file.ts")).toBe(false);
		await manager.cleanup("test-path");
	});
});

describe("isPathWithinAllowlist", () => {
	const worktree = "/tmp/fake-worktree";
	const allowlist = ["src", "docs/api"];

	test("allows paths matching allowlist entries", () => {
		expect(isPathWithinAllowlist(worktree, allowlist, "src/main.ts")).toBe(true);
		expect(isPathWithinAllowlist(worktree, allowlist, "docs/api/reference.md")).toBe(true);
		expect(isPathWithinAllowlist(worktree, allowlist, "docs/api")).toBe(true);
	});

	test("rejects paths outside allowlist entries", () => {
		expect(isPathWithinAllowlist(worktree, allowlist, "docs/other.md")).toBe(false);
		expect(isPathWithinAllowlist(worktree, allowlist, "lib/utils.ts")).toBe(false);
	});

	test("rejects path traversal outside worktree", () => {
		expect(isPathWithinAllowlist(worktree, allowlist, "../outside/file.ts")).toBe(false);
		expect(isPathWithinAllowlist(worktree, allowlist, "src/../../etc/passwd")).toBe(false);
	});

	test("rejects absolute paths outside worktree", () => {
		expect(isPathWithinAllowlist(worktree, allowlist, "/etc/passwd")).toBe(false);
	});

	test("rejects worktree root itself", () => {
		expect(isPathWithinAllowlist(worktree, allowlist, "")).toBe(false);
		expect(isPathWithinAllowlist(worktree, allowlist, ".")).toBe(false);
	});
});
