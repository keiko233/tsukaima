import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainCodingStore } from "../src/domain-store.ts";
import { ApprovalError, ProposalError } from "../src/index.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

describe("DomainCodingStore", () => {
	test("persists approvals with the ApprovalGate contract", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-coding-"));
		directories.push(directory);
		const store = new DomainCodingStore(join(directory, "domain.sqlite"));
		const request = await store.create({
			action: "deploy",
			expiresAtMs: Date.now() + 60_000,
			requestedBy: "agent",
			taskId: "task-1",
		});
		expect((await store.get(request.id))?.status).toBe("pending");
		await store.reject(request.id, "admin");
		expect((await store.get(request.id))?.status).toBe("rejected");
		await expect(store.approve(request.id, "admin")).rejects.toThrow(ApprovalError);
		await store.close();
	});

	test("persists proposals with valid transitions", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-coding-"));
		directories.push(directory);
		const store = new DomainCodingStore(join(directory, "domain.sqlite"));
		const proposal = await store.create({
			diff: "--- a/x.ts\n+++ b/x.ts\n",
			riskAssessment: "low",
			rollbackNotes: "revert",
			taskId: "task-1",
			title: "Update",
		});
		expect((await store.get(proposal.id))?.status).toBe("draft");
		await store.transition(proposal.id, "pending_approval");
		await store.transition(proposal.id, "approved");
		await expect(store.transition(proposal.id, "pending_approval")).rejects.toThrow(ProposalError);
		await store.close();
	});

	test("persists approvals and proposals across store instances", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-coding-"));
		directories.push(directory);
		const path = join(directory, "domain.sqlite");
		const first = new DomainCodingStore(path);
		const request = await first.create({
			action: "restart",
			expiresAtMs: Date.now() + 60_000,
			requestedBy: "agent",
			taskId: "task-2",
		});
		const proposal = await first.create({
			diff: "diff",
			riskAssessment: "low",
			rollbackNotes: "revert",
			taskId: "task-2",
			title: "Persistent proposal",
		});
		await first.close();

		const second = new DomainCodingStore(path);
		expect((await second.get(request.id))?.status).toBe("pending");
		expect((await second.getProposal(proposal.id))?.title).toBe("Persistent proposal");
		expect(await second.listPending()).toHaveLength(1);
		expect(await second.list("task-2")).toHaveLength(1);
		await second.close();
	});
});
