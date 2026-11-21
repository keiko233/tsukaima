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

	test("persists proposal evidence, metadata, and deployment fields", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-coding-"));
		directories.push(directory);
		const store = new DomainCodingStore(join(directory, "domain.sqlite"));
		const proposal = await store.createProposal({
			artifactMetadata: { builtAtMs: 1, checksum: "artifact", command: "bun run build" },
			changedFiles: ["src/app.ts"],
			diff: "--- a/src/app.ts\n+++ b/src/app.ts\n",
			envChanges: ["TSUKAIMA_EXAMPLE=1"],
			evidence: {
				diffChecksum: "a".repeat(64),
				items: [{ kind: "test", name: "test", provenance: "snapshot" }],
				snapshotChecksum: "b".repeat(64),
			},
			motivation: "Keep the fixture honest",
			requiresRestart: true,
			riskAssessment: "low",
			rollbackNotes: "revert the commit",
			sourceRevision: "deadbeef",
			testResult: {
				exitCode: 0,
				failed: 0,
				passed: true,
				stderr: "",
				stdout: "ok",
				total: 1,
			},
			taskId: "task-1",
			title: "Fixture patch",
		});
		const loaded = await store.getProposal(proposal.id);
		expect(loaded).toEqual(
			expect.objectContaining({
				artifactMetadata: expect.objectContaining({ checksum: "artifact" }),
				changedFiles: ["src/app.ts"],
				envChanges: ["TSUKAIMA_EXAMPLE=1"],
				evidence: expect.objectContaining({
					items: [expect.objectContaining({ kind: "test", provenance: "snapshot" })],
				}),
				motivation: "Keep the fixture honest",
				requiresRestart: true,
				riskAssessment: "low",
				rollbackNotes: "revert the commit",
				sourceRevision: "deadbeef",
				status: "draft",
				taskId: "task-1",
				title: "Fixture patch",
			}),
		);
		expect(loaded?.testResult?.passed).toBe(true);
		await store.createProposal({
			diff: "other",
			riskAssessment: "low",
			rollbackNotes: "revert",
			taskId: "task-2",
			title: "Other task",
		});
		expect((await store.listProposals("task-1")).map((entry) => entry.id)).toEqual([proposal.id]);
		expect((await store.listProposals("task-2")).map((entry) => entry.title)).toEqual([
			"Other task",
		]);
		await expect(store.transition("missing", "deploying")).rejects.toThrow(ProposalError);
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
