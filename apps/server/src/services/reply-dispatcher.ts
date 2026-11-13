import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { MessagePart } from "@elaina/contracts";
import type { ConversationAnswer } from "@elaina/core";
import { chatObjects, conversations, messages, type ElainaDatabase } from "@elaina/db";
import type { AuditEntry, ChannelHistoryItem } from "@elaina/sdk";
import type { Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { HookBus } from "./hook-bus.ts";

type ChatKind = "private" | "group" | "webui" | "task" | "plugin";

const DEFAULT_SPLIT_MAX_CHARS = 2_000;
const DEFAULT_PENDING_GRACE_MS = 15_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_LOOKBACK_MS = 300_000;

const isExternalChat = (kind: ChatKind): kind is "private" | "group" =>
	kind === "private" || kind === "group";

/**
 * Split text parts without dropping media parts. A long text part is sliced into chunks that
 * fit `maxChars`; non-text parts stay in order and are never dropped.
 */
export function splitMessageParts(
	parts: readonly MessagePart[],
	maxChars = DEFAULT_SPLIT_MAX_CHARS,
): MessagePart[][] {
	const limit = Math.max(1, Math.floor(maxChars));
	const chunks: MessagePart[][] = [];
	let current: MessagePart[] = [];
	let used = 0;
	const flush = () => {
		if (current.length > 0) chunks.push(current);
		current = [];
		used = 0;
	};
	for (const part of parts) {
		if (part.type !== "text") {
			current.push(part);
			continue;
		}
		let remaining = part.text;
		if (remaining.length === 0) continue;
		while (remaining.length > 0) {
			const room = limit - used;
			if (room <= 0) {
				flush();
				continue;
			}
			const slice = remaining.slice(0, room);
			current.push({ text: slice, type: "text" });
			used += slice.length;
			remaining = remaining.slice(slice.length);
			if (remaining.length > 0) flush();
			else if (used >= limit) flush();
		}
	}
	flush();
	return chunks.length === 0 ? [[]] : chunks;
}

export interface ReplyDispatcherOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly channels: ChannelRegistry;
	readonly database: () => ElainaDatabase | undefined;
	readonly hooks: HookBus;
	readonly logger: Logger;
	/** Outbound text chunk size; Phase 2 may supply a pacing-aware value. */
	readonly splitMaxChars?: number;
	readonly pendingGraceMs?: number;
	readonly reconcileIntervalMs?: number;
	readonly reconcileLookbackMs?: number;
	readonly replyAsQuote?: boolean;
	readonly now?: () => number;
}

export interface ReconcilePendingResult {
	readonly confirmed: number;
	readonly skipped: number;
	readonly uncertain: number;
}

/**
 * Turns a settled assistant answer into durable outbound history and, for external chats, a
 * channel send. Delivery is at-most-once: the outbound row is claimed through the
 * `(conversationId, durableEntryId)` unique index before any send, so an answer is never
 * delivered twice after a restart.
 */
export class ReplyDispatcher {
	readonly #audit: ReplyDispatcherOptions["audit"];
	readonly #channels: ChannelRegistry;
	readonly #database: () => ElainaDatabase | undefined;
	readonly #hooks: HookBus;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #pendingGraceMs: number;
	readonly #reconcileIntervalMs: number;
	readonly #reconcileLookbackMs: number;
	readonly #replyAsQuote: boolean;
	readonly #splitMaxChars: number;
	#reconcileTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: ReplyDispatcherOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("elaina::server::reply");
		this.#splitMaxChars = options.splitMaxChars ?? DEFAULT_SPLIT_MAX_CHARS;
		this.#pendingGraceMs = options.pendingGraceMs ?? DEFAULT_PENDING_GRACE_MS;
		this.#reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		this.#reconcileLookbackMs = options.reconcileLookbackMs ?? DEFAULT_RECONCILE_LOOKBACK_MS;
		this.#replyAsQuote = options.replyAsQuote ?? false;
		this.#now = options.now ?? Date.now;
	}

	async handleAnswer(answer: ConversationAnswer): Promise<void> {
		const database = this.#database();
		if (database === undefined) return;
		const [session] = await database
			.select({
				chatId: chatObjects.id,
				chatKind: chatObjects.kind,
				channelId: chatObjects.channelId,
				platformConversationId: chatObjects.platformConversationId,
				sessionId: conversations.id,
			})
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, answer.conversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) {
			this.#logger.warn("answer has no domain session", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
			return;
		}
		const chatKind: ChatKind = session.chatKind;
		const external = isExternalChat(chatKind);
		const channelId = session.channelId;
		const channelKind =
			external && channelId !== null ? this.#channels.get(channelId)?.kind : undefined;
		const kind = external ? (channelKind ?? "plugin") : chatKind;
		const parts: MessagePart[] = [{ text: answer.text, type: "text" }];
		const now = new Date().toISOString();
		const id = randomUUID();
		const inserted = await database
			.insert(messages)
			.values({
				activityId: answer.activityId,
				chatObjectId: session.chatId,
				contentText: answer.text,
				conversationId: session.sessionId,
				deliveryStatus: external ? "pending" : "sent",
				direction: "outbound",
				durableEntryId: answer.entryId,
				id,
				ingestedAt: now,
				kind,
				occurredAt: now,
				partsJson: JSON.stringify(parts),
				senderDisplayName: "Elaina",
				senderExternalId: "elaina",
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: messages.id });
		if (inserted.length === 0) {
			this.#logger.debug("assistant answer already dispatched", {
				entryId: answer.entryId,
				sessionId: session.sessionId,
			});
			return;
		}
		await Promise.all([
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, session.sessionId)),
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, session.chatId)),
		]);
		if (external) {
			await this.#hooks.emit("before.reply", {
				channelId,
				chatKind,
				chatObjectId: session.chatId,
				entryId: answer.entryId,
				sessionId: session.sessionId,
				text: answer.text,
			});
		}
		const deliveryStatus = external
			? await this.#deliver(database, {
					channelId,
					chatKind,
					id,
					parts,
					platformConversationId: session.platformConversationId,
					sessionId: session.sessionId,
				})
			: "sent";
		this.#hooks.emitDetached("after.reply", {
			channelId,
			chatObjectId: session.chatId,
			deliveryStatus,
			entryId: answer.entryId,
			sessionId: session.sessionId,
			text: answer.text,
		});
	}

	/** Startup and periodic reconciliation; never resends an unconfirmed pending row. */
	async reconcilePendingDeliveries(
		options: {
			graceMs?: number;
			lookbackMs?: number;
			nowMs?: number;
		} = {},
	): Promise<ReconcilePendingResult> {
		const database = this.#database();
		if (database === undefined) return { confirmed: 0, skipped: 0, uncertain: 0 };
		const nowMs = options.nowMs ?? this.#now();
		const graceMs = options.graceMs ?? this.#pendingGraceMs;
		const lookbackMs = options.lookbackMs ?? this.#reconcileLookbackMs;
		const cutoff = new Date(nowMs - graceMs).toISOString();
		const rows = await database
			.select({
				channelId: chatObjects.channelId,
				chatKind: chatObjects.kind,
				contentText: messages.contentText,
				id: messages.id,
				occurredAt: messages.occurredAt,
				platformConversationId: chatObjects.platformConversationId,
				platformMessageId: messages.platformMessageId,
				partsJson: messages.partsJson,
				sessionId: messages.conversationId,
			})
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(
				and(
					eq(messages.direction, "outbound"),
					eq(messages.deliveryStatus, "pending"),
					lt(messages.occurredAt, cutoff),
				),
			)
			.orderBy(asc(messages.occurredAt));
		let confirmed = 0;
		let uncertain = 0;
		let skipped = 0;
		for (const row of rows) {
			const chatKind = row.chatKind;
			const channelId = row.channelId;
			const platformConversationId = row.platformConversationId;
			if (!isExternalChat(chatKind) || channelId === null || platformConversationId === null) {
				await this.#markUncertain(database, row.id, row.sessionId, "no destination to reconcile", {
					channelId,
					platformConversationId,
				});
				uncertain += 1;
				continue;
			}
			const adapter = this.#channels.get(channelId);
			if (adapter === undefined || adapter.readHistory === undefined) {
				await this.#markUncertain(
					database,
					row.id,
					row.sessionId,
					"adapter has no read-history capability",
					{ channelId, platformConversationId },
				);
				uncertain += 1;
				continue;
			}
			let history: readonly ChannelHistoryItem[] = [];
			try {
				history = await adapter.readHistory(
					{ channelId, kind: chatKind, platformConversationId },
					{ limit: 50, sinceMs: nowMs - lookbackMs },
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.#logger.warn("pending delivery reconciliation read failed", {
					error: reason,
					messageId: row.id,
				});
				await this.#markUncertain(database, row.id, row.sessionId, reason, {
					channelId,
					platformConversationId,
				});
				uncertain += 1;
				continue;
			}
			const match = findReconciled(history, row.platformMessageId, row.contentText);
			if (match === undefined) {
				await this.#markUncertain(
					database,
					row.id,
					row.sessionId,
					"pending delivery was not confirmed in bounded lookback",
					{ channelId, platformConversationId, lookbackMs },
				);
				uncertain += 1;
				continue;
			}
			await database
				.update(messages)
				.set({
					deliveryStatus: "sent",
					platformMessageId: match.platformMessageId,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messages.id, row.id));
			await this.#audit({
				action: "message.reconcile-sent",
				payload: {
					platformConversationId,
					platformMessageId: match.platformMessageId,
				},
				result: "ok",
				targetId: row.sessionId,
				targetKind: "session",
			});
			confirmed += 1;
		}
		if (uncertain > 0) {
			this.#logger.warn("pending deliveries reconciled as uncertain", {
				confirmed,
				skipped,
				uncertain,
			});
		}
		return { confirmed, skipped, uncertain };
	}

	startPendingReconciliation(): void {
		if (this.#reconcileTimer !== undefined) return;
		this.#reconcileTimer = setInterval(() => {
			void this.reconcilePendingDeliveries().catch((error) => {
				this.#logger.warn("pending delivery reconciliation failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, this.#reconcileIntervalMs);
		this.#reconcileTimer.unref?.();
	}

	stopPendingReconciliation(): void {
		if (this.#reconcileTimer === undefined) return;
		clearInterval(this.#reconcileTimer);
		this.#reconcileTimer = undefined;
	}

	async #markUncertain(
		database: ElainaDatabase,
		messageId: string,
		sessionId: string,
		reason: string,
		payload: unknown,
	): Promise<void> {
		await database
			.update(messages)
			.set({ deliveryStatus: "uncertain", updatedAt: new Date().toISOString() })
			.where(eq(messages.id, messageId));
		await this.#audit({
			action: "message.reconcile-uncertain",
			payload,
			reason,
			result: "failed",
			targetId: sessionId,
			targetKind: "session",
		});
		this.#logger.warn("pending delivery marked uncertain", { messageId, reason, sessionId });
	}

	async #deliver(
		database: ElainaDatabase,
		target: {
			channelId: string | null;
			chatKind: "private" | "group";
			id: string;
			parts: readonly MessagePart[];
			platformConversationId: string | null;
			sessionId: string;
		},
	): Promise<"sent" | "failed" | "uncertain"> {
		const { channelId, platformConversationId } = target;
		if (channelId === null || platformConversationId === null) {
			return this.#fail(database, target.id, target.sessionId, "External chat has no destination", {
				channelId,
				platformConversationId,
			});
		}
		const chunks = splitMessageParts(target.parts, this.#splitMaxChars);
		const replyTo = this.#replyAsQuote
			? await this.#quoteTarget(database, target.sessionId, target.chatKind)
			: undefined;
		let firstPlatformMessageId: string | null = null;
		try {
			for (const [index, chunk] of chunks.entries()) {
				const result = await this.#channels.send(
					channelId,
					target.chatKind,
					platformConversationId,
					chunk,
					replyTo === undefined || index > 0 ? undefined : { replyToPlatformMessageId: replyTo },
				);
				if (firstPlatformMessageId === null && result.platformMessageId !== undefined) {
					firstPlatformMessageId = result.platformMessageId;
				}
			}
			await database
				.update(messages)
				.set({
					deliveryStatus: "sent",
					platformMessageId: firstPlatformMessageId,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messages.id, target.id));
			await this.#audit({
				action: "message.send-reply",
				payload: {
					chunkCount: chunks.length,
					chatKind: target.chatKind,
					platformConversationId,
				},
				result: "ok",
				targetId: target.sessionId,
				targetKind: "session",
			});
			return "sent";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return this.#fail(database, target.id, target.sessionId, message, {
				chatKind: target.chatKind,
				platformConversationId,
			});
		}
	}

	async #quoteTarget(
		database: ElainaDatabase,
		sessionId: string,
		chatKind: "private" | "group",
	): Promise<string | undefined> {
		const [row] = await database
			.select({ platformMessageId: messages.platformMessageId })
			.from(messages)
			.where(and(eq(messages.conversationId, sessionId), eq(messages.direction, "inbound")))
			.orderBy(desc(messages.occurredAt))
			.limit(1);
		if (row?.platformMessageId === null || row === undefined) {
			this.#logger.debug("quote requested but no inbound platform id is available", { chatKind });
			return undefined;
		}
		return row.platformMessageId;
	}

	async #fail(
		database: ElainaDatabase,
		messageId: string,
		sessionId: string,
		reason: string,
		payload: unknown,
	): Promise<"failed" | "uncertain"> {
		const deliveryStatus = /timeout/i.test(reason) ? "uncertain" : "failed";
		await database
			.update(messages)
			.set({ deliveryStatus, updatedAt: new Date().toISOString() })
			.where(eq(messages.id, messageId));
		this.#logger.warn("assistant reply could not be delivered", { reason, sessionId });
		await this.#audit({
			action: "message.send-reply",
			payload,
			reason,
			result: "failed",
			targetId: sessionId,
			targetKind: "session",
		});
		return deliveryStatus;
	}
}

function findReconciled(
	history: readonly ChannelHistoryItem[],
	platformMessageId: string | null,
	contentText: string | null,
): ChannelHistoryItem | undefined {
	if (platformMessageId !== null && platformMessageId.length > 0) {
		const exact = history.find((item) => item.platformMessageId === platformMessageId);
		if (exact !== undefined) return exact;
	}
	const expected = contentText?.trim();
	if (expected === undefined || expected.length === 0) return undefined;
	return history.find((item) => {
		const actual = item.text?.trim();
		if (actual === undefined || actual.length === 0) return false;
		return actual === expected || actual.includes(expected) || expected.includes(actual);
	});
}
