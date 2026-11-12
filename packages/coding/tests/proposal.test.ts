import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonFileProposalStore, NoopReloadController, ProposalError } from "../src/index.ts";

const proposalDir = join(import.meta.dir, "..", ".test-data", "proposal");

function createStore(): JsonFileProposalStore {
	return new JsonFileProposalStore(join(proposalDir, `${randomUUID()}.json`));
}

function makeInput(taskId: string) {
	return {
		diff: "--- a/config.ts\n+++ b/config.ts\n",
		riskAssessment: "low",
		rollbackNotes: "git revert <sha>",
		taskId,
		title: "Update configuration",
	};
}

afterAll(async () => {
	await rm(proposalDir, { force: true, recursive: true });
});

describe("JsonFileProposalStore", () => {
	test("creates proposal with draft status", async () => {
		const store = createStore();
		const proposal = await store.create(makeInput("task-1"));
		expect(proposal.status).toBe("draft");
		expect(proposal.taskId).toBe("task-1");
		expect(proposal.title).toBe("Update configuration");
		expect(proposal.testResult).toBeNull();
	});

	test("carries optional test result", async () => {
		const store = createStore();
		const proposal = await store.create({
			...makeInput("task-1"),
			testResult: { exitCode: 0, failed: 0, passed: true, stderr: "", stdout: "ok", total: 1 },
		});
		expect(proposal.testResult).not.toBeNull();
		expect(proposal.testResult?.passed).toBe(true);
	});

	test("transitions through full deployment lifecycle", async () => {
		const store = createStore();
		const proposal = await store.create(makeInput("task-1"));
		const p1 = await store.transition(proposal.id, "pending_approval");
		expect(p1.status).toBe("pending_approval");
		const p2 = await store.transition(p1.id, "approved");
		expect(p2.status).toBe("approved");
		const p3 = await store.transition(p2.id, "deploying");
		expect(p3.status).toBe("deploying");
		const p4 = await store.transition(p3.id, "deployed");
		expect(p4.status).toBe("deployed");
		const p5 = await store.transition(p4.id, "rolled_back");
		expect(p5.status).toBe("rolled_back");
	});

	test("rejects invalid status transition", async () => {
		const store = createStore();
		const proposal = await store.create(makeInput("task-1"));
		await expect(store.transition(proposal.id, "deployed")).rejects.toThrow(ProposalError);
	});

	test("throws for unknown proposal id", async () => {
		const store = createStore();
		await expect(store.transition("nonexistent", "deploying")).rejects.toThrow(ProposalError);
	});

	test("lists proposals filtered by taskId", async () => {
		const store = createStore();
		await store.create(makeInput("task-a"));
		await store.create(makeInput("task-a"));
		await store.create(makeInput("task-b"));
		const taskAProposals = await store.list("task-a");
		expect(taskAProposals).toHaveLength(2);
		const allProposals = await store.list();
		expect(allProposals).toHaveLength(3);
	});
});

describe("NoopReloadController", () => {
	test("returns success with component and reason in message", async () => {
		const controller = new NoopReloadController();
		const result = await controller.reload("plugin/greeter", { reason: "config update" });
		expect(result.success).toBe(true);
		expect(result.message).toContain("plugin/greeter");
		expect(result.message).toContain("config update");
		expect(result.reloadedAtMs).toBeGreaterThan(0);
	});
});
