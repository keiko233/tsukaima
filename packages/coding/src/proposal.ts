import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TestRunResult } from "./tools.ts";
import { sha256Hex } from "./hash.ts";

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

export interface DeploymentProposal {
	readonly artifactMetadata: ArtifactMetadata | null;
	readonly changedFiles: readonly string[];
	readonly createdAtMs: number;
	readonly diff: string;
	readonly diffChecksum: string;
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

const validTransitions: Readonly<
	Record<DeploymentProposalStatus, readonly DeploymentProposalStatus[]>
> = {
	approved: ["cancelled", "deploying"],
	cancelled: [],
	deployed: ["rolled_back"],
	deploying: ["deployed", "failed"],
	draft: ["cancelled", "pending_approval"],
	failed: ["cancelled", "pending_approval"],
	pending_approval: ["approved", "cancelled", "rejected"],
	rejected: [],
	rolled_back: [],
};

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

export class JsonFileProposalStore implements DeploymentProposalStore {
	readonly #filePath: string;

	constructor(filePath: string) {
		this.#filePath = filePath;
	}

	async create(input: DeploymentProposalInput): Promise<DeploymentProposal> {
		const proposals = await this.#read();
		const proposal = normalizeDeploymentProposal(input);
		proposals.push(proposal);
		await this.#write(proposals);
		return proposal;
	}

	async get(id: string): Promise<DeploymentProposal | null> {
		const proposals = await this.#read();
		return proposals.find((proposal) => proposal.id === id) ?? null;
	}

	async list(taskId?: string): Promise<readonly DeploymentProposal[]> {
		const proposals = await this.#read();
		if (taskId !== undefined) {
			return proposals.filter((proposal) => proposal.taskId === taskId);
		}
		return proposals;
	}

	async transition(id: string, toStatus: DeploymentProposalStatus): Promise<DeploymentProposal> {
		const proposals = await this.#read();
		const index = proposals.findIndex((proposal) => proposal.id === id);
		if (index === -1) {
			throw new ProposalError(`Proposal "${id}" not found`);
		}
		const existing = proposals[index];
		if (!existing) {
			throw new ProposalError(`Proposal "${id}" not found`);
		}
		const allowed = validTransitions[existing.status];
		if (!allowed.includes(toStatus)) {
			throw new ProposalError(
				`Invalid transition from "${existing.status}" to "${toStatus}". Allowed: [${allowed.join(", ")}]`,
			);
		}
		const updated: DeploymentProposal = {
			...existing,
			status: toStatus,
			updatedAtMs: Date.now(),
		};
		proposals[index] = updated;
		await this.#write(proposals);
		return updated;
	}

	async #read(): Promise<DeploymentProposal[]> {
		try {
			const content = await readFile(this.#filePath, "utf-8");
			const parsed: unknown = JSON.parse(content);
			if (parsed !== null && typeof parsed === "object" && "proposals" in parsed) {
				const container = parsed as { proposals: DeploymentProposal[] };
				return Array.isArray(container.proposals) ? [...container.proposals] : [];
			}
			return [];
		} catch {
			return [];
		}
	}

	async #write(proposals: readonly DeploymentProposal[]): Promise<void> {
		await mkdir(dirname(this.#filePath), { recursive: true });
		await writeFile(this.#filePath, JSON.stringify({ proposals }, null, "\t"), "utf-8");
	}
}
