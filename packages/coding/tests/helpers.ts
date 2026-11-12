import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GIT_CONFIG_ARGS = ["-c", "user.name=tsukaima-test", "-c", "user.email=test@tsukaima.local"] as const;

export function gitSync(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...GIT_CONFIG_ARGS, ...args], {
		cwd,
		encoding: "utf-8",
	});
}

export async function createTestRepo(prefix: string): Promise<string> {
	const testDataRoot = join(import.meta.dir, "..", ".test-data", prefix);
	await mkdir(testDataRoot, { recursive: true });
	const repoPath = join(testDataRoot, randomUUID(), "repo");
	await mkdir(repoPath, { recursive: true });
	gitSync(repoPath, ["init", "-b", "main"]);
	await writeFile(join(repoPath, "README.md"), "# Test repository\n");
	gitSync(repoPath, ["add", "."]);
	gitSync(repoPath, ["commit", "-m", "initial commit"]);
	return repoPath;
}

export async function cleanupTestRepo(repoPath: string): Promise<void> {
	const parentDir = join(repoPath, "..");
	await rm(parentDir, { force: true, recursive: true });
}
