import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import {
	DEFAULT_GIT_IDENTITY,
	gitIdentityArgs,
	gitIdentityEnv,
	readGitIdentity,
	writeGitIdentity,
} from "../src/services/git-identity.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function testDatabase(): Promise<ReturnType<typeof openDomainDatabase>> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-git-identity-"));
	directories.push(root);
	const database = await openDomainDatabase(join(root, "domain.sqlite"));
	migrateDomainDatabase(database);
	return database;
}

describe("git identity", () => {
	test("defaults when nothing is stored", async () => {
		const database = await testDatabase();
		expect(await readGitIdentity(database)).toEqual(DEFAULT_GIT_IDENTITY);
		expect(await readGitIdentity(undefined)).toEqual(DEFAULT_GIT_IDENTITY);
	});

	test("round-trips the configured identity", async () => {
		const database = await testDatabase();
		const stored = await writeGitIdentity(database, {
			email: "synthetic-bot@example.test",
			name: "Synthetic Bot",
		});
		expect(stored).toEqual({ email: "synthetic-bot@example.test", name: "Synthetic Bot" });
		expect(await readGitIdentity(database)).toEqual(stored);
	});

	test("rejects an identity git could not use", async () => {
		const database = await testDatabase();
		await expect(
			writeGitIdentity(database, { email: "not-an-email", name: "Bot" }),
		).rejects.toThrow();
		await expect(
			writeGitIdentity(database, { email: "bot@example.test", name: "" }),
		).rejects.toThrow();
	});

	test("renders the same identity as argv and as environment", () => {
		const identity = { email: "synthetic-bot@example.test", name: "Synthetic Bot" };
		expect(gitIdentityArgs(identity)).toEqual([
			"-c",
			"user.name=Synthetic Bot",
			"-c",
			"user.email=synthetic-bot@example.test",
		]);
		expect(gitIdentityEnv(identity)).toEqual({
			GIT_AUTHOR_EMAIL: "synthetic-bot@example.test",
			GIT_AUTHOR_NAME: "Synthetic Bot",
			GIT_COMMITTER_EMAIL: "synthetic-bot@example.test",
			GIT_COMMITTER_NAME: "Synthetic Bot",
		});
	});
});
