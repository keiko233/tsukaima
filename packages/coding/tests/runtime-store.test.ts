import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDomainDatabase, openDomainDatabase } from "@elaina/db";
import { DomainCodingStore } from "../src/domain-store.ts";
import type { IterationTaskConstraints } from "../src/types.ts";

const directories: string[] = [];
const constraints: IterationTaskConstraints = {
	allowedCommands: ["bun", "git"],
	maxOutputBytes: 8_192,
	pathAllowlist: ["src", "docs"],
	timeoutMs: 5_000,
};

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function storePath(): Promise<{ directory: string; path: string }> {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-coding-runtime-"));
	directories.push(directory);
	return { directory, path: join(directory, "domain.sqlite") };
}

describe("DomainCodingStore runtime records", () => {
	test("persists durable task CRUD with logs, artifacts, and timeline", async () => {
		const { path } = await storePath();
		const first = new DomainCodingStore(path);
		const task = await first.createTask({
			baseRef: "HEAD",
			constraints,
			goal: "Add a runtime test",
			mode: "patch",
			sourceConversationId: "conversation-1",
		});
		expect(task.logs).toEqual([]);
		expect(task.mode).toBe("patch");
		const updated = await first.updateTask(task.id, {
			artifacts: [{ kind: "diff", name: "diff", checksum: "abc" }],
			logs: [{ atMs: 1, level: "info", message: "started" }],
			status: "in_progress",
			timeline: [{ atMs: 1, outcome: "success", tool: "self-iteration.worktree" }],
			worktreePath: "/tmp/worktree",
		});
		expect(updated.status).toBe("in_progress");
		expect(updated.worktreePath).toBe("/tmp/worktree");
		await first.close();

		const second = new DomainCodingStore(path);
		const loaded = await second.getTask(task.id);
		expect(loaded).toEqual(
			expect.objectContaining({
				artifacts: [expect.objectContaining({ checksum: "abc", kind: "diff" })],
				goal: "Add a runtime test",
				logs: [expect.objectContaining({ message: "started" })],
				mode: "patch",
				status: "in_progress",
				timeline: [expect.objectContaining({ tool: "self-iteration.worktree" })],
				worktreePath: "/tmp/worktree",
			}),
		);
		expect((await second.listTasks({ mode: "patch" })).map((entry) => entry.id)).toEqual([task.id]);
		expect(await second.listTasks({ mode: "analysis" })).toEqual([]);
		await second.close();
	});

	test("reuses an existing database provider and keeps deployment identity immutable", async () => {
		const { directory } = await storePath();
		const database = await openDomainDatabase(join(directory, "shared.sqlite"));
		migrateDomainDatabase(database);
		const store = new DomainCodingStore(() => database);
		const task = await store.createTask({
			baseRef: "HEAD",
			constraints,
			goal: "Deploy safely",
			mode: "proposal",
			sourceConversationId: "conversation-2",
		});
		const deployment = await store.createDeployment({
			artifactMetadata: { checksum: "artifact" },
			createdBy: "admin",
			proposalId: "proposal-1",
			rollbackPlan: "revert commit",
			sourceRevision: "deadbeef",
			status: "pending",
			taskId: task.id,
		});
		const updated = await store.updateDeployment(deployment.id, {
			postCheck: { checkedAtMs: 2, ok: true },
			preCheck: { checkedAtMs: 1, ok: true },
			reloadedAtMs: 3,
			status: "deployed",
		});
		expect(updated).toEqual(
			expect.objectContaining({
				createdBy: "admin",
				proposalId: "proposal-1",
				rollbackPlan: "revert commit",
				sourceRevision: "deadbeef",
				status: "deployed",
				taskId: task.id,
			}),
		);
		await expect(store.updateDeployment("missing", { status: "failed" })).rejects.toThrow();
		expect(await store.listDeployments({ taskId: task.id })).toHaveLength(1);
		await store.close();
		// Provider mode must not close the host-owned handle.
		expect(database.$client.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
		database.$client.close();
	});
});
