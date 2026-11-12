import { and, eq } from "drizzle-orm";
import {
	codingApprovals,
	codingProposals,
	type ElainaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@elaina/db";
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
import type { TestRunResult } from "./tools.ts";

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

function approvalFromRow(row: typeof codingApprovals.$inferSelect): ApprovalRequest {
	const base = {
		action: row.action,
		createdAtMs: row.createdAtMs,
		expiresAtMs: row.expiresAtMs,
		id: row.id,
		...(row.proposalId === null ? {} : { proposalId: row.proposalId }),
		requestedBy: row.requestedBy,
		taskId: row.taskId,
	};
	if (row.status === "pending") {
		return { ...base, status: "pending" } satisfies PendingApprovalRequest;
	}
	return {
		...base,
		...(row.note === null ? {} : { note: row.note }),
		resolvedAtMs: row.resolvedAtMs ?? row.createdAtMs,
		resolvedBy: row.resolvedBy ?? "system",
		status: row.status,
	} satisfies ResolvedApprovalRequest;
}

function proposalFromRow(row: typeof codingProposals.$inferSelect): DeploymentProposal {
	return {
		createdAtMs: row.createdAtMs,
		diff: row.diff,
		id: row.id,
		riskAssessment: row.riskAssessment,
		rollbackNotes: row.rollbackNotes,
		status: row.status,
		taskId: row.taskId,
		testResult:
			row.testResultJson === null ? null : (JSON.parse(row.testResultJson) as TestRunResult),
		title: row.title,
		updatedAtMs: row.updatedAtMs,
	};
}

export class DomainCodingStore {
	readonly databasePath: string;
	readonly #database: Promise<ElainaDatabase>;

	constructor(databasePath: string) {
		this.databasePath = databasePath;
		this.#database = openDomainDatabase(databasePath).then((database) => {
			migrateDomainDatabase(database);
			return database;
		});
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
			const database = await this.#database;
			const request: PendingApprovalRequest = {
				action: input.action,
				createdAtMs: Date.now(),
				expiresAtMs: input.expiresAtMs,
				id: randomUUID(),
				...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
				requestedBy: input.requestedBy,
				status: "pending",
				taskId: input.taskId,
			};
			await database.insert(codingApprovals).values({
				action: request.action,
				createdAtMs: request.createdAtMs,
				expiresAtMs: request.expiresAtMs,
				id: request.id,
				note: null,
				proposalId: request.proposalId ?? null,
				requestedBy: request.requestedBy,
				resolvedAtMs: null,
				resolvedBy: null,
				status: request.status,
				taskId: request.taskId,
			});
			return request;
		}
		return this.createProposal(input);
	}

	async createProposal(input: DeploymentProposalInput): Promise<DeploymentProposal> {
		const database = await this.#database;
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
		await database.insert(codingProposals).values({
			createdAtMs: proposal.createdAtMs,
			diff: proposal.diff,
			id: proposal.id,
			riskAssessment: proposal.riskAssessment,
			rollbackNotes: proposal.rollbackNotes,
			status: proposal.status,
			taskId: proposal.taskId,
			testResultJson: proposal.testResult === null ? null : JSON.stringify(proposal.testResult),
			title: proposal.title,
			updatedAtMs: proposal.updatedAtMs,
		});
		return proposal;
	}

	async get(id: string): Promise<ApprovalRequest | DeploymentProposal | null> {
		return (await this.getApproval(id)) ?? (await this.getProposal(id));
	}

	async getApproval(id: string): Promise<ApprovalRequest | null> {
		const database = await this.#database;
		const [row] = await database
			.select()
			.from(codingApprovals)
			.where(eq(codingApprovals.id, id))
			.limit(1);
		if (row === undefined) {
			return null;
		}
		const request = approvalFromRow(row);
		if (request.status !== "pending" || Date.now() <= request.expiresAtMs) {
			return request;
		}
		return this.#expireApproval(request);
	}

	async listPending(): Promise<readonly ApprovalRequest[]> {
		const database = await this.#database;
		const rows = await database
			.select()
			.from(codingApprovals)
			.where(eq(codingApprovals.status, "pending"));
		const pending: ApprovalRequest[] = [];
		for (const row of rows) {
			const request = approvalFromRow(row);
			if (request.status === "pending" && Date.now() > request.expiresAtMs) {
				await this.#expireApproval(request);
			} else if (request.status === "pending") {
				pending.push(request);
			}
		}
		return pending;
	}

	async getProposal(id: string): Promise<DeploymentProposal | null> {
		const database = await this.#database;
		const [row] = await database
			.select()
			.from(codingProposals)
			.where(eq(codingProposals.id, id))
			.limit(1);
		return row === undefined ? null : proposalFromRow(row);
	}

	async list(taskId?: string): Promise<readonly DeploymentProposal[]> {
		const database = await this.#database;
		const rows =
			taskId === undefined
				? await database.select().from(codingProposals)
				: await database.select().from(codingProposals).where(eq(codingProposals.taskId, taskId));
		return rows.map(proposalFromRow);
	}

	async listProposals(taskId?: string): Promise<readonly DeploymentProposal[]> {
		return this.list(taskId);
	}

	async transition(id: string, toStatus: DeploymentProposalStatus): Promise<DeploymentProposal> {
		const database = await this.#database;
		const existing = await this.getProposal(id);
		if (existing === null) {
			throw new ProposalError(`Proposal "${id}" not found`);
		}
		if (!validTransitions[existing.status].includes(toStatus)) {
			throw new ProposalError(
				`Invalid transition from "${existing.status}" to "${toStatus}". Allowed: [${validTransitions[existing.status].join(", ")}]`,
			);
		}
		const updatedAtMs = Date.now();
		await database
			.update(codingProposals)
			.set({ status: toStatus, updatedAtMs })
			.where(eq(codingProposals.id, id));
		return { ...existing, status: toStatus, updatedAtMs };
	}

	async transitionProposal(
		id: string,
		toStatus: DeploymentProposalStatus,
	): Promise<DeploymentProposal> {
		return this.transition(id, toStatus);
	}

	async close(): Promise<void> {
		const database = await this.#database;
		database.$client.close();
	}

	async #resolveApproval(
		id: string,
		status: "approved" | "rejected",
		resolvedBy: string,
		note?: string,
	): Promise<ApprovalRequest> {
		const database = await this.#database;
		const existing = await this.getApproval(id);
		if (existing === null) {
			throw new ApprovalError(`Approval request "${id}" not found`);
		}
		if (existing.status !== "pending") {
			throw new ApprovalError(
				`Approval request "${id}" is not pending (status: ${existing.status})`,
			);
		}
		const resolved: ResolvedApprovalRequest = {
			...existing,
			...(note === undefined ? {} : { note }),
			resolvedAtMs: Date.now(),
			resolvedBy,
			status,
		};
		await database
			.update(codingApprovals)
			.set({
				note: resolved.note ?? null,
				resolvedAtMs: resolved.resolvedAtMs,
				resolvedBy: resolved.resolvedBy,
				status: resolved.status,
			})
			.where(and(eq(codingApprovals.id, id), eq(codingApprovals.status, "pending")));
		return resolved;
	}

	async #expireApproval(request: PendingApprovalRequest): Promise<ResolvedApprovalRequest> {
		const database = await this.#database;
		const expired: ResolvedApprovalRequest = {
			...request,
			resolvedAtMs: Date.now(),
			resolvedBy: "system",
			status: "expired",
		};
		await database
			.update(codingApprovals)
			.set({
				resolvedAtMs: expired.resolvedAtMs,
				resolvedBy: expired.resolvedBy,
				status: expired.status,
			})
			.where(and(eq(codingApprovals.id, request.id), eq(codingApprovals.status, "pending")));
		return expired;
	}
}
