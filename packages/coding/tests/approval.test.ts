import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalError, JsonFileApprovalStore } from "../src/index.ts";

const approvalDir = join(import.meta.dir, "..", ".test-data", "approval");

function createStore(): JsonFileApprovalStore {
	return new JsonFileApprovalStore(join(approvalDir, `${randomUUID()}.json`));
}

interface ApprovalInputOverrides {
	expiresAtMs?: number;
	proposalId?: string;
}

function makeInput(overrides?: ApprovalInputOverrides) {
	return {
		action: "deploy",
		expiresAtMs: overrides?.expiresAtMs ?? Date.now() + 60_000,
		requestedBy: "coding-agent",
		taskId: "task-1",
		...(overrides?.proposalId !== undefined ? { proposalId: overrides.proposalId } : {}),
	};
}

afterAll(async () => {
	await rm(approvalDir, { force: true, recursive: true });
});

describe("JsonFileApprovalStore", () => {
	test("creates pending approval request", async () => {
		const store = createStore();
		const request = await store.create(makeInput());
		expect(request.status).toBe("pending");
		expect(request.action).toBe("deploy");
		expect(request.taskId).toBe("task-1");
		expect(request.requestedBy).toBe("coding-agent");
	});

	test("carries optional proposalId", async () => {
		const store = createStore();
		const request = await store.create(makeInput({ proposalId: "proposal-42" }));
		expect(request.proposalId).toBe("proposal-42");
	});

	test("approve transitions to approved with resolver info", async () => {
		const store = createStore();
		const request = await store.create(makeInput());
		const approved = await store.approve(request.id, "admin", "looks good");
		expect(approved.status).toBe("approved");
		if (approved.status === "approved") {
			expect(approved.resolvedBy).toBe("admin");
			expect(approved.note).toBe("looks good");
			expect(approved.resolvedAtMs).toBeGreaterThan(0);
		}
	});

	test("reject transitions to rejected", async () => {
		const store = createStore();
		const request = await store.create(makeInput());
		const rejected = await store.reject(request.id, "admin");
		expect(rejected.status).toBe("rejected");
	});

	test("expires past-due pending request on read", async () => {
		const store = createStore();
		const request = await store.create(makeInput({ expiresAtMs: Date.now() - 1000 }));
		const found = await store.get(request.id);
		expect(found?.status).toBe("expired");
	});

	test("throws ApprovalError on double resolution", async () => {
		const store = createStore();
		const request = await store.create(makeInput());
		await store.approve(request.id, "admin");
		await expect(store.approve(request.id, "admin")).rejects.toThrow(ApprovalError);
	});

	test("returns null for unknown id", async () => {
		const store = createStore();
		expect(await store.get("nonexistent-id")).toBeNull();
	});

	test("persists across instances via JSON file", async () => {
		const filePath = join(approvalDir, `persist-${randomUUID()}.json`);
		const first = new JsonFileApprovalStore(filePath);
		const request = await first.create(makeInput());
		const second = new JsonFileApprovalStore(filePath);
		const found = await second.get(request.id);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(request.id);
	});

	test("listPending returns only pending requests", async () => {
		const store = createStore();
		const pending1 = await store.create(makeInput());
		const pending2 = await store.create(makeInput());
		const resolved = await store.create(makeInput());
		await store.approve(resolved.id, "admin");
		const pendingList = await store.listPending();
		expect(pendingList).toHaveLength(2);
		const pendingIds = pendingList.map((request) => request.id);
		expect(pendingIds).toContain(pending1.id);
		expect(pendingIds).toContain(pending2.id);
		expect(pendingIds).not.toContain(resolved.id);
	});
});
