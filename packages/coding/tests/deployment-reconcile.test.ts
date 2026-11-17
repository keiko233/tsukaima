import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainCodingStore, reconcileRestartDeployment } from "../src/index.ts";

const directories: string[] = [];

const verifiedDeployment = async () => ({
	detail: "verified",
	identity: { diffChecksum: "c".repeat(64), revision: "abc" },
	verified: true,
});

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function fixture(
	options: {
		readonly appliedIdentity?: { readonly diffChecksum: string; readonly revision: string } | null;
		readonly previousIdentity?: { readonly diffChecksum: string; readonly revision: string } | null;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-reconcile-"));
	directories.push(directory);
	const store = new DomainCodingStore(join(directory, "domain.sqlite"));
	const task = await store.createTask({
		baseRef: "HEAD",
		constraints: {
			allowedCommands: ["bun"],
			maxOutputBytes: 1024,
			pathAllowlist: ["src"],
			timeoutMs: 1_000,
		},
		goal: "Reconcile",
		mode: "proposal",
		sourceConversationId: "test",
	});
	const proposal = await store.createProposal({
		artifactMetadata: null,
		changedFiles: ["src/a.ts"],
		diff: "diff --git a/src/a.ts b/src/a.ts",
		diffChecksum: "c".repeat(64),
		envChanges: [],
		motivation: "test",
		requiresRestart: true,
		riskAssessment: "low",
		rollbackNotes: "revert",
		sourceRevision: "abc",
		taskId: task.id,
		testResult: { exitCode: 0, failed: 0, passed: true, stderr: "", stdout: "", total: 1 },
		title: "Reconcile",
	});
	await store.transition(proposal.id, "pending_approval");
	await store.transition(proposal.id, "approved");
	const deployment = await store.createDeployment({
		appliedIdentity:
			options.appliedIdentity === undefined
				? { diffChecksum: "c".repeat(64), revision: "abc" }
				: options.appliedIdentity,
		artifactMetadata: null,
		createdBy: "admin",
		previousIdentity:
			options.previousIdentity === undefined
				? { diffChecksum: "b".repeat(64), revision: "base" }
				: options.previousIdentity,
		proposalId: proposal.id,
		rollbackPlan: "revert",
		sourceRevision: "abc",
		status: "scheduled",
		taskId: task.id,
	});
	return { deployment, proposal, store, task };
}

describe("reconcileRestartDeployment", () => {
	test("requires verified application before reporting deployed", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.updateTask(task.id, { status: "deploying" });

		// A restarted process is not evidence that the proposal is live.
		const unverified = await reconcileRestartDeployment(store, {
			atMs: 42,
			deploymentId: deployment.id,
			outcome: "completed",
		});
		expect(unverified?.updated).toBe(true);
		expect(unverified?.deployment.status).toBe("manual_apply_required");
		expect(unverified?.deployment.postCheck?.ok).toBe(false);
		// The proposal and task stay in flight so a later verified boot can settle them.
		expect(unverified?.proposal?.status).toBe("deploying");
		expect(unverified?.task?.status).toBe("deploying");
	});

	test("does not report deployed when the verifier says the revision is not live", async () => {
		const { deployment, store } = await fixture();
		const result = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({ detail: "running image is the previous revision", verified: false }),
		});
		expect(result?.deployment.status).toBe("manual_apply_required");
		expect(result?.deployment.postCheck?.message).toContain("previous revision");
	});

	test("does not report deployed when the verifier throws", async () => {
		const { deployment, store } = await fixture();
		const result = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => {
				throw new Error("probe unavailable");
			},
		});
		expect(result?.deployment.status).toBe("manual_apply_required");
		expect(result?.deployment.postCheck?.message).toContain("probe unavailable");
	});

	test("settles a verified deployment as deployed", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.updateTask(task.id, { status: "deploying" });
		const result = await reconcileRestartDeployment(store, {
			atMs: 42,
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({
				detail: "revision abc with the approved patch is live",
				identity: { diffChecksum: "c".repeat(64), revision: "abc" },
				verified: true,
			}),
		});
		expect(result?.updated).toBe(true);
		expect(result?.deployment.status).toBe("deployed");
		expect(result?.deployment.reloadedAtMs).toBe(42);
		expect(result?.deployment.postCheck).toMatchObject({ ok: true });
		expect(result?.proposal?.status).toBe("deployed");
		expect(result?.task?.status).toBe("completed");
	});

	test("does not accept a matching base revision while the approved diff is unapplied", async () => {
		// The proposal was generated from worktree HEAD `abc` while its diff stayed uncommitted, so
		// `sourceRevision` is the base commit. An image built from `abc` reports the same revision
		// but carries no patch; only the checksum distinguishes the two.
		const { deployment, store } = await fixture();
		const result = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({
				detail: "running revision matches the proposal base commit",
				identity: { diffChecksum: "", revision: "abc" },
				verified: true,
			}),
		});
		expect(result?.deployment.status).toBe("manual_apply_required");
		expect(result?.deployment.postCheck?.ok).toBe(false);
		expect(result?.deployment.postCheck?.message).toContain("checksum");
	});

	test("fails closed when the deployment has no recorded artifact identity", async () => {
		const { deployment, store } = await fixture({ appliedIdentity: null });
		const result = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({
				identity: { diffChecksum: "c".repeat(64), revision: "abc" },
				verified: true,
			}),
		});
		expect(result?.deployment.status).toBe("manual_apply_required");
		expect(result?.deployment.postCheck?.message).toContain(
			"no recorded applied artifact identity",
		);
	});

	test("rejects a verifier that reports success without an observed identity", async () => {
		const { deployment, store } = await fixture();
		const result = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({ detail: "looks fine", verified: true }),
		});
		expect(result?.deployment.status).toBe("manual_apply_required");
		expect(result?.deployment.postCheck?.message).toContain("did not report");
	});

	test("cancels a scheduled deployment and fails its proposal when the restart never ran", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.updateTask(task.id, { status: "deploying" });
		const result = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "cancelled",
		});
		expect(result?.deployment.status).toBe("cancelled");
		expect(result?.proposal?.status).toBe("failed");
		expect(result?.task?.status).toBe("cancelled");
	});

	test("settles a verified rollback as rolled_back and leaves the proposal deployed on cancel", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.transition(proposal.id, "deployed");
		const rollback = await store.createDeployment({
			// A rollback's applied identity is the exact artifact it restores.
			appliedIdentity: { diffChecksum: "b".repeat(64), revision: "base" },
			artifactMetadata: null,
			createdBy: "admin",
			proposalId: proposal.id,
			previousIdentity: { diffChecksum: "c".repeat(64), revision: "abc" },
			rollbackOfId: deployment.id,
			rollbackPlan: "revert",
			sourceRevision: "abc",
			status: "scheduled",
			taskId: task.id,
		});
		// An unverified rollback is not reported as rolled_back.
		const unverified = await reconcileRestartDeployment(store, {
			deploymentId: rollback.id,
			outcome: "completed",
		});
		expect(unverified?.deployment.status).toBe("manual_apply_required");

		const verified = await reconcileRestartDeployment(store, {
			deploymentId: rollback.id,
			outcome: "completed",
			verify: async () => ({
				detail: "previous artifact restored",
				identity: { diffChecksum: "b".repeat(64), revision: "base" },
				verified: true,
			}),
		});
		expect(verified?.deployment.status).toBe("rolled_back");
		expect(verified?.proposal?.status).toBe("rolled_back");

		// "Different from the deployed revision" is not proof: an unrelated third revision is not
		// the recorded restore target either.
		const wrongTarget = await store.createDeployment({
			appliedIdentity: { diffChecksum: "b".repeat(64), revision: "base" },
			artifactMetadata: null,
			createdBy: "admin",
			proposalId: proposal.id,
			previousIdentity: { diffChecksum: "c".repeat(64), revision: "abc" },
			rollbackOfId: deployment.id,
			rollbackPlan: "revert",
			sourceRevision: "abc",
			status: "scheduled",
			taskId: task.id,
		});
		const wrong = await reconcileRestartDeployment(store, {
			deploymentId: wrongTarget.id,
			outcome: "completed",
			verify: async () => ({
				detail: "some older image is running",
				identity: { diffChecksum: "e".repeat(64), revision: "older-unrelated" },
				verified: true,
			}),
		});
		expect(wrong?.deployment.status).toBe("manual_apply_required");
		expect(wrong?.deployment.postCheck?.message).toContain("does not match applied revision");

		const cancelled = await store.createDeployment({
			appliedIdentity: { diffChecksum: "b".repeat(64), revision: "base" },
			artifactMetadata: null,
			createdBy: "admin",
			proposalId: proposal.id,
			rollbackOfId: deployment.id,
			rollbackPlan: "revert",
			sourceRevision: "abc",
			status: "scheduled",
			taskId: task.id,
		});
		const cancelledResult = await reconcileRestartDeployment(store, {
			deploymentId: cancelled.id,
			outcome: "interrupted",
		});
		expect(cancelledResult?.deployment.status).toBe("cancelled");
		expect(cancelledResult?.proposal?.status).toBe("rolled_back");
	});

	test("returns null for an unknown deployment and no-ops on terminal rows", async () => {
		const { deployment, store } = await fixture();
		expect(
			await reconcileRestartDeployment(store, { deploymentId: "missing", outcome: "completed" }),
		).toBeNull();
		await store.updateDeployment(deployment.id, { status: "deployed" });
		const replay = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "cancelled",
		});
		expect(replay?.updated).toBe(false);
		expect(replay?.deployment.status).toBe("deployed");
	});

	test("a manual-apply row can be settled later by a real verification", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.updateTask(task.id, { status: "deploying" });
		await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
		});
		const settled = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({
				detail: "confirmed live",
				identity: { diffChecksum: "c".repeat(64), revision: "abc" },
				verified: true,
			}),
		});
		expect(settled?.updated).toBe(true);
		expect(settled?.deployment.status).toBe("deployed");
		expect(settled?.proposal?.status).toBe("deployed");
		expect(settled?.task?.status).toBe("completed");
	});

	test("a crash between proposal/task settlement and the deployment row replays cleanly", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.updateTask(task.id, { status: "deploying" });
		// First boot settles proposal and task but "crashes" before the deployment row update by
		// being interrupted right there: simulate it by settling those two first.
		await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: verifiedDeployment,
		});
		// Force the deployment row back to scheduled, which is the state a crash before the final
		// write leaves behind.
		await store.updateDeployment(deployment.id, { status: "scheduled" });
		const replay = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: verifiedDeployment,
		});
		expect(replay?.updated).toBe(true);
		expect(replay?.deployment.status).toBe("deployed");
		expect(replay?.proposal?.status).toBe("deployed");
		expect(replay?.task?.status).toBe("completed");
	});

	test("an interrupted settlement stays retryable instead of being reported as applied", async () => {
		const { deployment, proposal, store, task } = await fixture();
		await store.transition(proposal.id, "deploying");
		await store.updateTask(task.id, { status: "deploying" });
		// A verifier that never confirms leaves the row manual_apply_required and replayable.
		const unverified = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({ detail: "probe timed out", verified: false }),
		});
		expect(unverified?.deployment.status).toBe("manual_apply_required");
		expect(unverified?.proposal?.status).toBe("deploying");
		// A later boot with real evidence can still settle it.
		const settled = await reconcileRestartDeployment(store, {
			deploymentId: deployment.id,
			outcome: "completed",
			verify: async () => ({
				identity: { diffChecksum: "c".repeat(64), revision: "abc" },
				verified: true,
			}),
		});
		expect(settled?.deployment.status).toBe("deployed");
		expect(settled?.task?.status).toBe("completed");
	});
});
