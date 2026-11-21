import { randomUUID } from "node:crypto";
import { sha256Hex } from "./hash.ts";
import type { TestRunResult } from "./types.ts";

export type DeploymentProposalStatus =
	| "approved"
	| "cancelled"
	| "deployed"
	| "deploying"
	| "draft"
	| "failed"
	| "pending_approval"
	| "rejected"
	| "rolled_back";

export interface ArtifactMetadata {
	readonly builtAtMs: number;
	readonly checksum: string;
	readonly command: string;
	readonly outputPath?: string;
	readonly sizeBytes?: number;
}

/** One fresh, passing validation artifact a proposal's evidence is bound to. */
export interface ProposalEvidenceItem {
	readonly kind: "build" | "test";
	readonly name: string;
	/** `snapshot` for an isolated check; `live` for a compatibility run proven unchanged. */
	readonly provenance: "live" | "snapshot";
}

/**
 * Server-derived proof of what a proposal contains and what was validated. Both checksums are
 * computed by the server from the task worktree; every item validated exactly `snapshotChecksum`.
 */
export interface ProposalEvidence {
	readonly diffChecksum: string;
	readonly items: readonly ProposalEvidenceItem[];
	readonly snapshotChecksum: string;
}

export interface DeploymentProposal {
	readonly artifactMetadata: ArtifactMetadata | null;
	readonly changedFiles: readonly string[];
	readonly createdAtMs: number;
	readonly diff: string;
	readonly diffChecksum: string;
	/** Null for proposals recorded before evidence was bound to a snapshot. */
	readonly evidence: ProposalEvidence | null;
	readonly envChanges: readonly string[];
	readonly id: string;
	readonly motivation: string;
	readonly requiresRestart: boolean;
	readonly riskAssessment: string;
	readonly rollbackNotes: string;
	readonly sourceRevision: string;
	readonly status: DeploymentProposalStatus;
	readonly taskId: string;
	readonly testResult: TestRunResult | null;
	readonly title: string;
	readonly updatedAtMs: number;
}

export interface DeploymentProposalInput {
	readonly artifactMetadata?: ArtifactMetadata | null;
	readonly changedFiles?: readonly string[];
	readonly diff: string;
	readonly diffChecksum?: string;
	readonly evidence?: ProposalEvidence | null;
	readonly envChanges?: readonly string[];
	readonly motivation?: string;
	readonly requiresRestart?: boolean;
	readonly riskAssessment: string;
	readonly rollbackNotes: string;
	readonly sourceRevision?: string;
	readonly taskId: string;
	readonly testResult?: TestRunResult;
	readonly title: string;
}

export class ProposalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposalError";
	}
}

/** Normalize store/tool input into the durable shape; hashes the diff when no checksum exists. */
export function normalizeDeploymentProposal(
	input: DeploymentProposalInput,
	now = Date.now(),
): DeploymentProposal {
	return {
		artifactMetadata: input.artifactMetadata ?? null,
		changedFiles: [...(input.changedFiles ?? [])],
		createdAtMs: now,
		diff: input.diff,
		diffChecksum: input.diffChecksum ?? sha256Hex(input.diff),
		evidence: input.evidence ?? null,
		envChanges: [...(input.envChanges ?? [])],
		id: randomUUID(),
		motivation: input.motivation ?? "",
		requiresRestart: input.requiresRestart ?? false,
		riskAssessment: input.riskAssessment,
		rollbackNotes: input.rollbackNotes,
		sourceRevision: input.sourceRevision ?? "",
		status: "draft",
		taskId: input.taskId,
		testResult: input.testResult ?? null,
		title: input.title,
		updatedAtMs: now,
	};
}

const PROPOSAL_FIELD_KEYS = [
	"title",
	"motivation",
	"riskAssessment",
	"rollbackNotes",
	"sourceRevision",
	"artifactMetadata",
	"testResult",
	"changedFiles",
	"diffChecksum",
	"envChanges",
	"requiresRestart",
] as const;

/**
 * Approval requires the seven proposal groups from the runtime spec. Undefined and empty
 * values are reported so the model gets an actionable list instead of a silent default.
 */
export function missingProposalFields(
	input: DeploymentProposalInput | DeploymentProposal,
): readonly string[] {
	const missing: string[] = [];
	for (const key of PROPOSAL_FIELD_KEYS) {
		const value = (input as unknown as Record<string, unknown>)[key];
		if (value === undefined || value === null) {
			missing.push(key);
			continue;
		}
		if (typeof value === "string" && value.trim().length === 0) missing.push(key);
	}
	if (input.changedFiles === undefined || input.changedFiles.length === 0) {
		if (!missing.includes("changedFiles")) missing.push("changedFiles");
	}
	if (input.diffChecksum !== undefined && input.diffChecksum.length !== 64) {
		missing.push("diffChecksum");
	}
	return [...new Set(missing)];
}

export function validateProposalFields(input: DeploymentProposalInput | DeploymentProposal): {
	readonly ok: boolean;
	readonly missing: readonly string[];
} {
	const missing = missingProposalFields(input);
	return { missing, ok: missing.length === 0 };
}

export interface DeploymentProposalStore {
	create(input: DeploymentProposalInput): Promise<DeploymentProposal>;
	get(id: string): Promise<DeploymentProposal | null>;
	list(taskId?: string): Promise<readonly DeploymentProposal[]>;
	transition(id: string, toStatus: DeploymentProposalStatus): Promise<DeploymentProposal>;
}
