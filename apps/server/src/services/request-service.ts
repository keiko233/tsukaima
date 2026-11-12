import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ChannelRequest } from "@elaina/contracts";
import { type ElainaDatabase, requests } from "@elaina/db";
import type { AuditEntry } from "@elaina/sdk";
import type { Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";

export type RequestResolutionStatus = "approved" | "rejected" | "failed" | "uncertain";

export interface RequestServiceOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly channels: ChannelRegistry;
	readonly database: () => ElainaDatabase | undefined;
	readonly logger: Logger;
}

/**
 * The durable friend/group request inbox. Persistence is channel-agnostic; resolving a
 * request is delegated to whichever channel adapter owns it.
 */
export class RequestService {
	readonly #audit: (entry: AuditEntry) => Promise<void>;
	readonly #channels: ChannelRegistry;
	readonly #database: () => ElainaDatabase | undefined;
	readonly #logger: Logger;
	readonly #inFlight = new Set<string>();

	constructor(options: RequestServiceOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#logger = options.logger;
	}

	async persist(request: ChannelRequest): Promise<void> {
		const database = this.#requireDatabase();
		const requestLog = this.#logger.span("process_request", {
			channelId: request.channelId,
			kind: request.kind,
			requestFlag: request.flag,
		});
		const now = new Date().toISOString();
		await database
			.insert(requests)
			.values({
				accountId: request.accountId,
				channelId: request.channelId,
				...(request.comment === undefined ? {} : { comment: request.comment }),
				createdAt: new Date(request.receivedAtMs || Date.now()).toISOString(),
				flag: request.flag,
				...(request.groupId === undefined ? {} : { groupExternalId: request.groupId }),
				id: randomUUID(),
				kind: request.kind,
				...(request.raw === undefined ? {} : { rawJson: JSON.stringify(request.raw) }),
				requesterExternalId: request.requesterId,
				...(request.requesterDisplayName === undefined
					? {}
					: { requesterDisplayName: request.requesterDisplayName }),
				...(request.subType === undefined ? {} : { subType: request.subType }),
				updatedAt: now,
			})
			.onConflictDoUpdate({
				set: {
					...(request.comment === undefined ? {} : { comment: request.comment }),
					updatedAt: now,
				},
				target: [requests.channelId, requests.flag],
			});
		requestLog.info("channel request persisted", {
			requesterId: request.requesterId,
			...(request.groupId === undefined ? {} : { groupId: request.groupId }),
		});
	}

	async respond(
		requestId: string,
		action: "approve" | "reject",
		reason?: string,
	): Promise<{ status: RequestResolutionStatus }> {
		const database = this.#requireDatabase();
		const [request] = await database
			.select()
			.from(requests)
			.where(eq(requests.id, requestId))
			.limit(1);
		if (request === undefined) throw new Error("Request not found");
		if (request.status !== "pending") {
			throw new Error(`Request is already ${request.status}`);
		}
		const adapter = this.#channels.get(request.channelId);
		if (adapter === undefined) {
			throw new Error(`Channel ${request.channelId} is not registered`);
		}
		if (adapter.resolveRequest === undefined) {
			throw new Error(`Channel ${request.channelId} cannot resolve requests`);
		}
		if (adapter.diagnostics().connected !== true) {
			throw new Error(`Channel ${request.channelId} is not connected`);
		}
		if (this.#inFlight.has(requestId)) {
			throw new Error("Request action is already in progress");
		}
		this.#inFlight.add(requestId);
		const attemptedAt = new Date().toISOString();
		try {
			await database
				.update(requests)
				.set({
					errorMessage: null,
					resolutionAction: action,
					...(reason === undefined ? {} : { resolutionReason: reason }),
					status: "uncertain",
					updatedAt: attemptedAt,
				})
				.where(and(eq(requests.id, requestId), eq(requests.status, "pending")));
			await adapter.resolveRequest(toChannelRequest(request), {
				action,
				...(reason === undefined ? {} : { reason }),
			});
			const status: RequestResolutionStatus = action === "approve" ? "approved" : "rejected";
			const resolvedAt = new Date().toISOString();
			await database
				.update(requests)
				.set({ resolvedAt, status, updatedAt: resolvedAt })
				.where(eq(requests.id, requestId));
			await this.#audit({
				action: `request.${action}`,
				payload: { requestId },
				result: "ok",
				targetId: request.requesterExternalId,
				targetKind: "request",
			});
			this.#logger.info("channel request resolved", { action, requestId, status });
			return { status };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status: RequestResolutionStatus = /timeout/i.test(message) ? "uncertain" : "failed";
			const updatedAt = new Date().toISOString();
			await database
				.update(requests)
				.set({ errorMessage: message, status, updatedAt })
				.where(eq(requests.id, requestId));
			await this.#audit({
				action: `request.${action}`,
				payload: { requestId },
				reason: message,
				result: "failed",
				targetId: request.requesterExternalId,
				targetKind: "request",
			});
			this.#logger.warn("channel request resolution failed", {
				action,
				error: message,
				requestId,
				status,
			});
			return { status };
		} finally {
			this.#inFlight.delete(requestId);
		}
	}

	#requireDatabase(): ElainaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}

type StoredRequest = typeof requests.$inferSelect;

function toChannelRequest(request: StoredRequest): ChannelRequest {
	return {
		accountId: request.accountId,
		channelId: request.channelId,
		...(request.comment === null ? {} : { comment: request.comment }),
		flag: request.flag,
		...(request.groupExternalId === null ? {} : { groupId: request.groupExternalId }),
		kind: request.kind,
		receivedAtMs: Number.isNaN(Date.parse(request.createdAt))
			? Date.now()
			: Date.parse(request.createdAt),
		requesterId: request.requesterExternalId,
		...(request.requesterDisplayName === null
			? {}
			: { requesterDisplayName: request.requesterDisplayName }),
		...(request.subType === null ? {} : { subType: request.subType }),
	};
}
