import type { DomainCodingStore } from "./domain-store.ts";
import type { DeploymentProposal } from "./proposal.ts";
import type { DeploymentIdentity, DeploymentRecord, IterationTask } from "./types.ts";

/**
 * How a durable restart intent that owned a deployment ended:
 * - `completed`: the supervisor replaced the process and this boot is the resumed one;
 * - `interrupted`: the process died before the intent's deadline, so it never ran;
 * - `cancelled`: an administrator or a newer request cancelled it.
 */
export type RestartDeploymentOutcome = "cancelled" | "completed" | "interrupted";

/**
 * Independent evidence about the artifact this process is running.
 *
 * A revision alone is not enough. `proposal.sourceRevision` is the worktree HEAD the proposal was
 * generated from; when the approved diff is still uncommitted that is the *base* commit, so a
 * running image built from it has none of the approved change. Verification therefore compares
 * the full {@link DeploymentIdentity}: the built revision **and** the checksum of the patch it
 * contains.
 */
export interface DeploymentApplicationVerification {
	/** The artifact identity the verifier observed (for example image labels). */
	readonly identity?: DeploymentIdentity;
	/** Human-readable evidence, recorded in the deployment's post-check. */
	readonly detail?: string;
	readonly verified: boolean;
}

export type DeploymentVerifier = (input: {
	readonly deployment: DeploymentRecord;
	readonly proposal: DeploymentProposal | null;
	readonly rollback: boolean;
}) => DeploymentApplicationVerification | Promise<DeploymentApplicationVerification>;

export interface ReconcileRestartDeploymentInput {
	readonly atMs?: number;
	readonly deploymentId: string;
	readonly outcome: RestartDeploymentOutcome;
	/**
	 * Proof that the proposal is live. Without a verifier, or when it does not confirm the
	 * application, a completed restart is recorded as `manual_apply_required` rather than
	 * `deployed`/`rolled_back`.
	 */
	readonly verify?: DeploymentVerifier;
}

export interface ReconcileRestartDeploymentResult {
	readonly deployment: DeploymentRecord;
	readonly proposal: DeploymentProposal | null;
	readonly task: IterationTask | null;
	/**
	 * False when the deployment was already settled. `manual_apply_required` is intentionally
	 * replayable, so a later boot with real verification can still settle it truthfully.
	 */
	readonly updated: boolean;
}

/**
 * Settle a deployment whose restart/update intent the supervisor did (or did not) carry out.
 *
 * A `scheduled` deployment row means "intent persisted, process not replaced yet". Only this
 * reconciliation moves it to a terminal state, which keeps deployment history truthful across
 * restarts and cancellation. A completed restart is *not* treated as proof that the proposal is
 * live: that requires `verify`. Without it the row becomes `manual_apply_required`, which is the
 * honest state for a runtime that cannot inspect or apply the host revision.
 *
 * Replaying the same outcome is a no-op once the row is terminal. A `manual_apply_required` row
 * may be re-settled when a verifier later confirms the application.
 */
export async function reconcileRestartDeployment(
	store: DomainCodingStore,
	input: ReconcileRestartDeploymentInput,
): Promise<ReconcileRestartDeploymentResult | null> {
	const deployment = await store.getDeployment(input.deploymentId);
	if (deployment === null) return null;
	const proposal = await store.getProposal(deployment.proposalId);
	const task = await store.getTask(deployment.taskId);
	if (deployment.status !== "scheduled" && deployment.status !== "manual_apply_required") {
		return { deployment, proposal, task, updated: false };
	}

	const atMs = input.atMs ?? Date.now();
	const isRollback = deployment.rollbackOfId !== null;
	const completed = input.outcome === "completed";
	if (!completed) {
		// The intent never ran, so the previous process is still serving; a manual-apply row that
		// is later cancelled keeps the same truthful outcome.
		if (deployment.status === "manual_apply_required") {
			return { deployment, proposal, task, updated: false };
		}
		const updatedProposal = await reconcileProposal(store, deployment.proposalId, {
			completed: false,
			isRollback,
		});
		const updatedTask = await reconcileTask(store, deployment.taskId, input.outcome);
		// The deployment row is written last: a crash before it leaves `scheduled`, so the next
		// boot replays this settlement instead of losing it.
		const updatedDeployment = await store.updateDeployment(deployment.id, {
			status: "cancelled",
		});
		return {
			deployment: updatedDeployment,
			proposal: updatedProposal,
			task: updatedTask,
			updated: true,
		};
	}

	if (deployment.status === "manual_apply_required") {
		// A later boot may have real evidence. Re-run the verifier; only a full identity match
		// settles the row.
		const verification = await runVerifier(input.verify, {
			deployment,
			proposal,
			rollback: isRollback,
		});
		const matched = matchIdentity(deployment, verification);
		if (!matched.verified) {
			const updatedDeployment = await store.updateDeployment(deployment.id, {
				postCheck: { checkedAtMs: atMs, message: matched.detail, ok: false },
				status: "manual_apply_required",
			});
			return { deployment: updatedDeployment, proposal, task, updated: true };
		}
		return await settleApplied(store, {
			atMs,
			deployment,
			detail: matched.detail,
			input,
			isRollback,
		});
	}

	const verification = await runVerifier(input.verify, {
		deployment,
		proposal,
		rollback: isRollback,
	});
	const matched = matchIdentity(deployment, verification);
	if (!matched.verified) {
		const updatedDeployment = await store.updateDeployment(deployment.id, {
			postCheck: {
				checkedAtMs: atMs,
				message: matched.detail,
				ok: false,
			},
			reloadedAtMs: atMs,
			status: "manual_apply_required",
		});
		return { deployment: updatedDeployment, proposal, task, updated: true };
	}

	return await settleApplied(store, {
		atMs,
		deployment,
		detail: matched.detail,
		input,
		isRollback,
	});
}

/**
 * Compare the artifact the process reports with the exact identity this deployment claims.
 *
 * Both a forward deployment and a rollback record store what they are meant to make live in
 * `appliedIdentity`, so the process must run exactly that revision **and** patch checksum.
 * Comparing "different from the deployed revision" is not enough: any third revision, including
 * an unrelated older image, would satisfy it.
 */
function matchIdentity(
	deployment: DeploymentRecord,
	verification: DeploymentApplicationVerification,
): { readonly detail: string; readonly verified: boolean } {
	if (!verification.verified) {
		return {
			detail: verification.detail ?? "restart completed but the applied artifact was not verified",
			verified: false,
		};
	}
	const expected = deployment.appliedIdentity;
	const observed = verification.identity;
	if (expected === null) {
		return {
			detail:
				"deployment has no recorded applied artifact identity; the approved patch cannot be proven live",
			verified: false,
		};
	}
	if (expected.revision.length === 0 || expected.diffChecksum.length === 0) {
		return {
			detail:
				"recorded artifact identity is incomplete; a revision without the approved patch checksum proves nothing",
			verified: false,
		};
	}
	if (observed === undefined) {
		return {
			detail: "verifier did not report the running artifact identity",
			verified: false,
		};
	}
	if (observed.revision !== expected.revision) {
		return {
			detail: `running revision ${observed.revision || "<none>"} does not match applied revision ${expected.revision}`,
			verified: false,
		};
	}
	if (observed.diffChecksum !== expected.diffChecksum) {
		return {
			detail: `running artifact checksum ${observed.diffChecksum || "<none>"} does not match approved patch ${expected.diffChecksum}`,
			verified: false,
		};
	}
	return {
		detail:
			verification.detail ??
			`running artifact ${expected.revision} contains approved patch ${expected.diffChecksum}`,
		verified: true,
	};
}

/**
 * Settle proposal and task before the deployment row. Replaying after a crash in the middle is
 * therefore harmless: the deployment is still `scheduled`/`manual_apply_required`, so the next
 * boot repeats the idempotent proposal/task transitions.
 */
async function settleApplied(
	store: DomainCodingStore,
	input: {
		readonly atMs: number;
		readonly deployment: DeploymentRecord;
		readonly detail: string;
		readonly input: ReconcileRestartDeploymentInput;
		readonly isRollback: boolean;
	},
): Promise<ReconcileRestartDeploymentResult> {
	const updatedProposal = await reconcileProposal(store, input.deployment.proposalId, {
		completed: true,
		isRollback: input.isRollback,
	});
	const updatedTask = await reconcileTask(store, input.deployment.taskId, input.input.outcome);
	const updatedDeployment = await store.updateDeployment(input.deployment.id, {
		postCheck: { checkedAtMs: input.atMs, message: input.detail, ok: true },
		reloadedAtMs: input.atMs,
		status: input.isRollback ? "rolled_back" : "deployed",
	});
	return {
		deployment: updatedDeployment,
		proposal: updatedProposal,
		task: updatedTask,
		updated: true,
	};
}

async function runVerifier(
	verify: DeploymentVerifier | undefined,
	input: {
		readonly deployment: DeploymentRecord;
		readonly proposal: DeploymentProposal | null;
		readonly rollback: boolean;
	},
): Promise<DeploymentApplicationVerification> {
	if (verify === undefined) {
		return {
			detail: "no deployment verifier is configured; the applied revision cannot be confirmed",
			verified: false,
		};
	}
	try {
		return await verify(input);
	} catch (error) {
		return {
			detail: `deployment verification failed: ${error instanceof Error ? error.message : String(error)}`,
			verified: false,
		};
	}
}

async function reconcileProposal(
	store: DomainCodingStore,
	proposalId: string,
	input: { readonly completed: boolean; readonly isRollback: boolean },
): Promise<DeploymentProposal | null> {
	const proposal = await store.getProposal(proposalId);
	if (proposal === null) return null;
	try {
		if (input.completed) {
			if (input.isRollback && proposal.status === "deployed") {
				return await store.transition(proposalId, "rolled_back");
			}
			if (!input.isRollback && proposal.status === "deploying") {
				return await store.transition(proposalId, "deployed");
			}
			return proposal;
		}
		// A cancelled rollback leaves the live deployment in place, so its proposal stays deployed.
		if (!input.isRollback && proposal.status === "deploying") {
			return await store.transition(proposalId, "failed");
		}
		return proposal;
	} catch {
		return proposal;
	}
}

async function reconcileTask(
	store: DomainCodingStore,
	taskId: string,
	outcome: RestartDeploymentOutcome,
): Promise<IterationTask | null> {
	const task = await store.getTask(taskId);
	if (task === null) return null;
	const status =
		outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed";
	if (task.status === status || task.status === "completed" || task.status === "cancelled") {
		return task;
	}
	try {
		return await store.updateTask(taskId, { status });
	} catch {
		return task;
	}
}
