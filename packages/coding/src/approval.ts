export type ApprovalStatus = "approved" | "expired" | "pending" | "rejected";

export interface ApprovalRequestBase {
	readonly action: string;
	readonly createdAtMs: number;
	readonly expiresAtMs: number;
	readonly id: string;
	readonly proposalId?: string;
	readonly requestedBy: string;
	readonly taskId: string;
}

export interface PendingApprovalRequest extends ApprovalRequestBase {
	readonly status: "pending";
}

export interface ResolvedApprovalRequest extends ApprovalRequestBase {
	readonly note?: string;
	readonly resolvedAtMs: number;
	readonly resolvedBy: string;
	readonly status: "approved" | "expired" | "rejected";
}

export type ApprovalRequest = PendingApprovalRequest | ResolvedApprovalRequest;

export interface ApprovalRequestInput {
	readonly action: string;
	readonly expiresAtMs: number;
	readonly proposalId?: string;
	readonly requestedBy: string;
	readonly taskId: string;
}

export interface ApprovalGate {
	approve(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest>;
	create(input: ApprovalRequestInput): Promise<ApprovalRequest>;
	get(id: string): Promise<ApprovalRequest | null>;
	listPending(): Promise<readonly ApprovalRequest[]>;
	reject(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest>;
}

export class ApprovalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApprovalError";
	}
}
