import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TestRunResult } from "./tools.ts";

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

export interface DeploymentProposal {
	readonly createdAtMs: number;
	readonly diff: string;
	readonly id: string;
	readonly riskAssessment: string;
	readonly rollbackNotes: string;
	readonly status: DeploymentProposalStatus;
	readonly taskId: string;
	readonly testResult: TestRunResult | null;
	readonly title: string;
	readonly updatedAtMs: number;
}

export interface DeploymentProposalInput {
	readonly diff: string;
	readonly riskAssessment: string;
	readonly rollbackNotes: string;
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
		const now = Date.now();
		const proposal: DeploymentProposal = {
			createdAtMs: now,
			diff: input.diff,
			id: randomUUID(),
			riskAssessment: input.riskAssessment,
			rollbackNotes: input.rollbackNotes,
			status: "draft",
			taskId: input.taskId,
			testResult: input.testResult ?? null,
			title: input.title,
			updatedAtMs: now,
		};
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
