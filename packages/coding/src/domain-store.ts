import { randomUUID } from "node:crypto";
import { ApprovalError } from "./approval.ts";
import type {
	ApprovalRequest,
	ApprovalRequestInput,
	PendingApprovalRequest,
	ResolvedApprovalRequest,
} from "./approval.ts";
import {
	ProposalError,
	type DeploymentProposal,
	type DeploymentProposalInput,
	type DeploymentProposalStatus,
} from "./proposal.ts";

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

export class DomainCodingStore {
	readonly databasePath: string;
	#approvals = new Map<string, ApprovalRequest>();
	#proposals = new Map<string, DeploymentProposal>();

	constructor(databasePath: string) {
		this.databasePath = databasePath;
	}

	async approve(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest> {
		return this.#resolveApproval(id, "approved", resolvedBy, note);
	}

	async reject(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest> {
		return this.#resolveApproval(id, "rejected", resolvedBy, note);
	}

	async create(input: ApprovalRequestInput): Promise<ApprovalRequest>;
	async create(input: DeploymentProposalInput): Promise<DeploymentProposal>;
	async create(
		input: ApprovalRequestInput | DeploymentProposalInput,
	): Promise<ApprovalRequest | DeploymentProposal> {
		if ("action" in input) {
			const request: PendingApprovalRequest = {
				action: input.action,
				createdAtMs: Date.now(),
				expiresAtMs: input.expiresAtMs,
				id: randomUUID(),
				requestedBy: input.requestedBy,
				status: "pending",
				taskId: input.taskId,
			};
			const stored =
				input.proposalId !== undefined ? { ...request, proposalId: input.proposalId } : request;
			this.#approvals.set(stored.id, stored);
			return stored;
		}
		return this.createProposal(input);
	}

	async createProposal(input: DeploymentProposalInput): Promise<DeploymentProposal> {
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
		this.#proposals.set(proposal.id, proposal);
		return proposal;
	}

	async get(id: string): Promise<ApprovalRequest | DeploymentProposal | null> {
		const request = this.#approvals.get(id);
		if (!request) return this.#proposals.get(id) ?? null;
		if (request.status !== "pending" || Date.now() <= request.expiresAtMs) return request;
		const expired: ResolvedApprovalRequest = {
			...request,
			resolvedAtMs: Date.now(),
			resolvedBy: "system",
			status: "expired",
		};
		this.#approvals.set(id, expired);
		return expired;
	}

	async listPending(): Promise<readonly ApprovalRequest[]> {
		const rows = [...this.#approvals.values()];
		const now = Date.now();
		const expired: ResolvedApprovalRequest[] = [];
		for (const row of rows) {
			if (row.status === "pending" && now > row.expiresAtMs) {
				expired.push({
					...row,
					resolvedAtMs: now,
					resolvedBy: "system",
					status: "expired",
				});
			}
		}
		for (const request of expired) {
			this.#approvals.set(request.id, request);
		}
		return [...this.#approvals.values()].filter((request) => request.status === "pending");
	}

	async getProposal(id: string): Promise<DeploymentProposal | null> {
		return this.#proposals.get(id) ?? null;
	}

	async list(taskId?: string): Promise<readonly DeploymentProposal[]> {
		const proposals = [...this.#proposals.values()];
		return taskId === undefined
			? proposals
			: proposals.filter((proposal) => proposal.taskId === taskId);
	}

	async listProposals(taskId?: string): Promise<readonly DeploymentProposal[]> {
		return this.list(taskId);
	}

	async transition(id: string, toStatus: DeploymentProposalStatus): Promise<DeploymentProposal> {
		const existing = await this.#find<DeploymentProposal>(`proposal:${id}`);
		if (!existing) throw new ProposalError(`Proposal "${id}" not found`);
		if (!validTransitions[existing.status].includes(toStatus)) {
			throw new ProposalError(`Invalid transition from "${existing.status}" to "${toStatus}"`);
		}
		const updated: DeploymentProposal = { ...existing, status: toStatus, updatedAtMs: Date.now() };
		await this.#update(`proposal:${id}`, updated);
		return updated;
	}

	async transitionProposal(
		id: string,
		toStatus: DeploymentProposalStatus,
	): Promise<DeploymentProposal> {
		return this.transition(id, toStatus);
	}

	async #resolveApproval(
		id: string,
		status: "approved" | "rejected",
		resolvedBy: string,
		note?: string,
	): Promise<ApprovalRequest> {
		const existing = this.#approvals.get(id);
		if (!existing) throw new ApprovalError(`Approval request "${id}" not found`);
		if (existing.status !== "pending") {
			throw new ApprovalError(
				`Approval request "${id}" is not pending (status: ${existing.status})`,
			);
		}
		const resolved: ResolvedApprovalRequest = {
			...existing,
			...(note !== undefined ? { note } : {}),
			resolvedAtMs: Date.now(),
			resolvedBy,
			status,
		};
		this.#approvals.set(id, resolved);
		return resolved;
	}

	async #update(id: string, value: unknown): Promise<void> {
		const kind = id.split(":", 1)[0] ?? "";
		const recordId = id.slice(kind.length + 1);
		if (kind === "approval") {
			this.#approvals.set(recordId, value as ApprovalRequest);
			return;
		}
		this.#proposals.set(recordId, value as DeploymentProposal);
	}

	async #find<T>(id: string): Promise<T | null> {
		const kind = id.split(":", 1)[0] ?? "";
		const recordId = id.slice(kind.length + 1);
		if (kind === "approval") return (this.#approvals.get(recordId) as T | undefined) ?? null;
		return (this.#proposals.get(recordId) as T | undefined) ?? null;
	}
}
