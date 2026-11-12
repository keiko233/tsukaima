import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

export class JsonFileApprovalStore implements ApprovalGate {
	readonly #filePath: string;

	constructor(filePath: string) {
		this.#filePath = filePath;
	}

	async approve(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest> {
		return this.#resolve(id, "approved", resolvedBy, note);
	}

	async create(input: ApprovalRequestInput): Promise<ApprovalRequest> {
		const requests = await this.#read();
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
		requests.push(stored);
		await this.#write(requests);
		return stored;
	}

	async get(id: string): Promise<ApprovalRequest | null> {
		const requests = await this.#read();
		const changed = await this.#expirePending(requests);
		if (changed) {
			await this.#write(requests);
		}
		return requests.find((request) => request.id === id) ?? null;
	}

	async listPending(): Promise<readonly ApprovalRequest[]> {
		const requests = await this.#read();
		const changed = await this.#expirePending(requests);
		if (changed) {
			await this.#write(requests);
		}
		return requests.filter((request) => request.status === "pending");
	}

	async reject(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest> {
		return this.#resolve(id, "rejected", resolvedBy, note);
	}

	async #expirePending(requests: ApprovalRequest[]): Promise<boolean> {
		const now = Date.now();
		let changed = false;
		for (let index = 0; index < requests.length; index++) {
			const request = requests[index];
			if (request && request.status === "pending" && now > request.expiresAtMs) {
				requests[index] = {
					...request,
					resolvedAtMs: now,
					resolvedBy: "system",
					status: "expired",
				};
				changed = true;
			}
		}
		return changed;
	}

	async #read(): Promise<ApprovalRequest[]> {
		try {
			const content = await readFile(this.#filePath, "utf-8");
			const parsed: unknown = JSON.parse(content);
			if (parsed !== null && typeof parsed === "object" && "requests" in parsed) {
				const container = parsed as { requests: ApprovalRequest[] };
				return Array.isArray(container.requests) ? [...container.requests] : [];
			}
			return [];
		} catch {
			return [];
		}
	}

	async #resolve(
		id: string,
		status: "approved" | "rejected",
		resolvedBy: string,
		note?: string,
	): Promise<ApprovalRequest> {
		const requests = await this.#read();
		await this.#expirePending(requests);
		const index = requests.findIndex((request) => request.id === id);
		if (index === -1) {
			throw new ApprovalError(`Approval request "${id}" not found`);
		}
		const existing = requests[index];
		if (!existing || existing.status !== "pending") {
			throw new ApprovalError(
				`Approval request "${id}" is not pending (status: ${existing?.status ?? "unknown"})`,
			);
		}
		const resolved: ResolvedApprovalRequest = {
			...existing,
			...(note !== undefined ? { note } : {}),
			resolvedAtMs: Date.now(),
			resolvedBy,
			status,
		};
		requests[index] = resolved;
		await this.#write(requests);
		return resolved;
	}

	async #write(requests: readonly ApprovalRequest[]): Promise<void> {
		await mkdir(dirname(this.#filePath), { recursive: true });
		await writeFile(this.#filePath, JSON.stringify({ requests }, null, "\t"), "utf-8");
	}
}
