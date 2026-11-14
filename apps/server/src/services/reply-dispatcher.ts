import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import {
	messagePartSchema,
	type ConversationPolicy,
	defaultConversationPolicy,
	type MessagePart,
} from "@tsukaima/contracts";
import {
	boundedReplyDelayMs,
	type ConversationAnswer,
	type ConversationExecutionLock,
	extractLurkMarker,
	prepareOutboundText,
	withConversationLock,
} from "@tsukaima/core";
import { chatObjects, conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry, ChannelHistoryItem } from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { ConversationPacingTracker } from "./conversation-pacing.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
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
	readonly database: () => TsukaimaDatabase | undefined;
	readonly hooks: HookBus;
	readonly logger: Logger;
	/** Outbound text chunk size; Phase 2 may supply a pacing-aware value. */
	readonly splitMaxChars?: number;
	readonly pendingGraceMs?: number;
	readonly reconcileIntervalMs?: number;
	readonly reconcileLookbackMs?: number;
	readonly replyAsQuote?: boolean;
	readonly now?: () => number;
	readonly pacing?: ConversationPacingTracker;
	readonly policy?: ConversationPolicyService;
	/** Test seams for deterministic pacing. */
	readonly random?: () => number;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Shared conversation execution lock; defaults to the host-wide lock. */
	readonly lock?: ConversationExecutionLock;
}

interface DeliveryPlanItem {
	readonly parts: readonly MessagePart[];
}

export interface ReplyDeliveryOutcome {
	readonly deliveryStatus: "sent" | "failed" | "uncertain" | "skipped" | "suppressed";
	readonly reason?: string;
	readonly text?: string;
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
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #hooks: HookBus;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #pendingGraceMs: number;
	readonly #reconcileIntervalMs: number;
	readonly #reconcileLookbackMs: number;
	readonly #replyAsQuote: boolean;
	readonly #splitMaxChars: number;
	readonly #policy: ConversationPolicyService | undefined;
	readonly #pacing: ConversationPacingTracker | undefined;
	readonly #random: () => number;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly #lock: ConversationExecutionLock | undefined;
	readonly #pendingOutput = new Map<string, AbortController>();
	#reconcileTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: ReplyDispatcherOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("tsukaima::server::reply");
		this.#splitMaxChars = options.splitMaxChars ?? DEFAULT_SPLIT_MAX_CHARS;
		this.#pendingGraceMs = options.pendingGraceMs ?? DEFAULT_PENDING_GRACE_MS;
		this.#reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		this.#reconcileLookbackMs = options.reconcileLookbackMs ?? DEFAULT_RECONCILE_LOOKBACK_MS;
		this.#replyAsQuote = options.replyAsQuote ?? false;
		this.#now = options.now ?? Date.now;
		this.#policy = options.policy;
		this.#pacing = options.pacing;
		this.#random = options.random ?? Math.random;
		this.#lock = options.lock;
		this.#sleep =
			options.sleep ??
			((ms, signal) =>
				new Promise<void>((resolve, reject) => {
					if (signal.aborted) {
						reject(new OutputCancelledError());
						return;
					}
					const timer = setTimeout(resolve, ms);
					const onAbort = () => {
						clearTimeout(timer);
						reject(new OutputCancelledError());
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}));
	}

	/** Cancel queued output for one conversation without touching other chats. */
	cancelPendingOutput(conversationId: string): boolean {
		const controller = this.#pendingOutput.get(conversationId);
		if (controller === undefined) return false;
		controller.abort();
		this.#logger.info("pending output cancelled", { conversationId });
		return true;
	}

	async handleAnswer(answer: ConversationAnswer): Promise<ReplyDeliveryOutcome | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
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
			return { deliveryStatus: "skipped", reason: "no_domain_session" };
		}

		this.#logger.debug("handling assistant answer", {
			activityId: answer.activityId,
			chatKind: session.chatKind,
			conversationId: answer.conversationId,
			entryId: answer.entryId,
			sessionId: session.sessionId,
			textChars: answer.text.length,
		});
		this.#logger.trace("assistant answer preview", {
			conversationId: answer.conversationId,
			entryId: answer.entryId,
			preview: previewText(answer.text),
		});

		const lurk = extractLurkMarker(answer.text);
		if (lurk.lurk) {
			this.#pacing?.recordLurk(answer.conversationId);
			await this.#audit({
				action: "message.lurk",
				actorKind: "agent",
				payload: {
					activityId: answer.activityId,
					entryId: answer.entryId,
					remainingText: lurk.text,
				},
				result: "ok",
				targetId: session.sessionId,
				targetKind: "session",
			});
			this.#logger.info("assistant lurk marker suppressed", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
			return { deliveryStatus: "suppressed", reason: "lurk", text: lurk.text };
		}

		let policy: ConversationPolicy = defaultConversationPolicy;
		try {
			policy = (await this.#policy?.effectivePolicy(session.sessionId)) ?? policy;
		} catch (error) {
			this.#logger.warn("reply pacing policy unavailable", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const transformed = await this.#transformReply({
			channelId: session.channelId,
			chatKind: session.chatKind,
			chatObjectId: session.chatId,
			conversationId: answer.conversationId,
			entryId: answer.entryId,
			parts: [{ text: lurk.text, type: "text" }],
			sessionId: session.sessionId,
			text: lurk.text,
		});
		const hasMedia = transformed.parts.some((part) => part.type !== "text");
		const prepared = prepareOutboundText(transformed.text, policy.pacing);
		let text: string;
		let parts: MessagePart[];
		let plan: DeliveryPlanItem[];
		if (hasMedia) {
			// Media-bearing transforms keep their exact text/media order in one outbound message,
			// matching the single row the WebUI renders. Newline pacing only applies to text-only
			// replies; splitting here would turn one rendered bubble into several QQ messages.
			const normalizedParts: MessagePart[] = [];
			for (const part of transformed.parts) {
				if (part.type !== "text") {
					normalizedParts.push(part);
					continue;
				}
				const partOutput = prepareOutboundText(part.text, policy.pacing);
				if (partOutput.text.length > 0) {
					normalizedParts.push({ text: partOutput.text, type: "text" });
				}
			}
			if (normalizedParts.length === 0) {
				this.#logger.debug("assistant answer skipped as empty after transform", {
					entryId: answer.entryId,
					sessionId: session.sessionId,
				});
				return { deliveryStatus: "skipped", reason: "empty_output" };
			}
			parts = normalizedParts;
			plan = [{ parts: normalizedParts }];
			text = normalizedParts
				.filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
		} else {
			if (prepared.units.length === 0) {
				this.#logger.debug("assistant answer skipped as empty output", {
					entryId: answer.entryId,
					sessionId: session.sessionId,
				});
				return { deliveryStatus: "skipped", reason: "empty_output" };
			}
			text = prepared.text;
			parts = text.length > 0 ? [{ text, type: "text" }] : [];
			plan = prepared.units.map((unit) => ({ parts: [{ text: unit, type: "text" as const }] }));
		}
		if (prepared.overflowCount > 0) {
			await this.#audit({
				action: "message.output-overflow",
				actorKind: "agent",
				payload: {
					immediateCap: policy.pacing.maxImmediateOutputMessages,
					overflowCount: prepared.overflowCount,
				},
				result: "ok",
				targetId: session.sessionId,
				targetKind: "session",
			});
		}

		const chatKind: ChatKind = session.chatKind;
		const external = isExternalChat(chatKind);
		const channelId = session.channelId;
		const channelKind =
			external && channelId !== null ? this.#channels.get(channelId)?.kind : undefined;
		const kind = external ? (channelKind ?? "plugin") : chatKind;
		const now = new Date().toISOString();
		const id = randomUUID();
		const inserted = await database
			.insert(messages)
			.values({
				chatObjectId: session.chatId,
				contentText: text,
				conversationId: session.sessionId,
				deliveryStatus: external ? "pending" : "sent",
				direction: "outbound",
				durableEntryId: answer.entryId,
				id,
				ingestedAt: now,
				kind,
				occurredAt: now,
				partsJson: JSON.stringify(parts),
				senderDisplayName: "Tsukaima",
				senderExternalId: "tsukaima",
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: messages.id });
		if (inserted.length === 0) {
			this.#logger.debug("assistant answer already dispatched", {
				entryId: answer.entryId,
				sessionId: session.sessionId,
			});
			return { deliveryStatus: "skipped", reason: "duplicate" };
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
				text,
			});
		}
		const deliveryStatus = external
			? await this.#deliver(database, {
					channelId,
					chatKind,
					conversationId: answer.conversationId,
					id,
					parts,
					plan,
					platformConversationId: session.platformConversationId,
					policy,
					sessionId: session.sessionId,
					units: prepared.units,
				})
			: "sent";
		this.#pacing?.recordReply(answer.conversationId);
		this.#hooks.emitDetached("after.reply", {
			channelId,
			chatObjectId: session.chatId,
			deliveryStatus,
			entryId: answer.entryId,
			sessionId: session.sessionId,
			text,
		});
		return { deliveryStatus, text };
	}

	async #transformReply(input: {
		readonly channelId: string | null;
		readonly chatKind: ChatKind;
		readonly chatObjectId: string;
		readonly conversationId: string;
		readonly entryId: string;
		readonly parts: readonly MessagePart[];
		readonly sessionId: string;
		readonly text: string;
	}): Promise<{ readonly parts: readonly MessagePart[]; readonly text: string }> {
		let current = { parts: [...input.parts], text: input.text };
		let result: unknown;
		try {
			result = await this.#hooks.transform("reply.transform", {
				channelId: input.channelId,
				chatKind: input.chatKind,
				chatObjectId: input.chatObjectId,
				conversationId: input.conversationId,
				entryId: input.entryId,
				parts: current.parts,
				sessionId: input.sessionId,
				text: current.text,
			});
		} catch (error) {
			this.#logger.warn("reply transform failed; using original answer", {
				error: error instanceof Error ? error.message : String(error),
			});
			return current;
		}
		if (typeof result !== "object" || result === null) return current;
		const candidate = result as { readonly parts?: unknown; readonly text?: unknown };
		let text = typeof candidate.text === "string" ? candidate.text : current.text;
		let parts: MessagePart[] = current.parts;
		if (candidate.parts !== undefined) {
			const parsed = messagePartSchema.array().safeParse(candidate.parts);
			if (!parsed.success) {
				this.#logger.warn("reply transform returned invalid message parts", {
					error: parsed.error.message,
				});
				return current;
			}
			parts = [...parsed.data];
			if (typeof candidate.text !== "string") {
				const textParts = parts.filter((part) => part.type === "text");
				if (textParts.length > 0) {
					text = textParts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				}
			}
		}
		if (candidate.text !== undefined && typeof candidate.text !== "string") {
			this.#logger.warn("reply transform returned an invalid text value");
			return current;
		}
		if (typeof candidate.text === "string" && !parts.some((part) => part.type === "text")) {
			if (candidate.text.length > 0) parts = [{ text: candidate.text, type: "text" }, ...parts];
		}
		if (parts.length === 0 && text.length > 0) parts = [{ text, type: "text" }];
		return { parts, text };
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
		} else if (rows.length > 0) {
			this.#logger.debug("pending deliveries reconciled", {
				candidateCount: rows.length,
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
		database: TsukaimaDatabase,
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
		database: TsukaimaDatabase,
		target: {
			channelId: string | null;
			chatKind: "private" | "group";
			conversationId: string;
			id: string;
			parts: readonly MessagePart[];
			plan: readonly DeliveryPlanItem[];
			platformConversationId: string | null;
			policy: ConversationPolicy;
			sessionId: string;
			units: readonly string[];
		},
	): Promise<"failed" | "sent" | "uncertain"> {
		const { channelId, platformConversationId } = target;
		if (channelId === null || platformConversationId === null) {
			return this.#fail(database, target.id, target.sessionId, "External chat has no destination", {
				channelId,
				platformConversationId,
			});
		}
		return withConversationLock(
			target.conversationId,
			async () => {
				const startedAt = performance.now();
				const controller = new AbortController();
				this.#pendingOutput.set(target.conversationId, controller);
				const replyTo = this.#replyAsQuote
					? await this.#quoteTarget(database, target.sessionId, target.chatKind)
					: undefined;
				let firstPlatformMessageId: string | null = null;
				let sentCount = 0;
				const failures: string[] = [];
				try {
					if (target.policy.pacing.typingEnabled) {
						await this.#channels.sendTyping(
							channelId,
							target.chatKind,
							platformConversationId,
							true,
						);
					}
					const delayMs = boundedReplyDelayMs(target.policy.pacing, this.#random);
					this.#logger.trace("delivering reply to channel", {
						channelId,
						chatKind: target.chatKind,
						delayMs,
						planItems: target.plan.length,
						platformConversationId,
						sessionId: target.sessionId,
						unitCount: target.units.length,
					});
					if (delayMs > 0) await this.#sleep(delayMs, controller.signal);
					let replyTargetSent = false;
					const sendChunk = async (chunk: readonly MessagePart[]) => {
						if (controller.signal.aborted) throw new OutputCancelledError();
						const result = await this.#channels.send(
							channelId,
							target.chatKind,
							platformConversationId,
							chunk,
							replyTo !== undefined && !replyTargetSent
								? { replyToPlatformMessageId: replyTo }
								: undefined,
						);
						replyTargetSent = true;
						if (firstPlatformMessageId === null && result.platformMessageId !== undefined) {
							firstPlatformMessageId = result.platformMessageId;
						}
						sentCount += 1;
					};
					for (const [itemIndex, item] of target.plan.entries()) {
						const chunks = splitMessageParts(item.parts, this.#splitMaxChars).filter(
							(chunk) => chunk.length > 0,
						);
						for (const [chunkIndex, chunk] of chunks.entries()) {
							try {
								await sendChunk(chunk);
							} catch (error) {
								if (error instanceof OutputCancelledError) throw error;
								const reason = error instanceof Error ? error.message : String(error);
								failures.push(reason);
								this.#logger.warn("reply chunk delivery failed; continuing with remaining output", {
									channelId,
									chunkIndex,
									itemIndex,
									reason,
									sentCount,
									sessionId: target.sessionId,
								});
							}
							if (
								target.policy.pacing.sendIntervalMs > 0 &&
								(itemIndex < target.plan.length - 1 || chunkIndex < chunks.length - 1)
							) {
								await this.#sleep(target.policy.pacing.sendIntervalMs, controller.signal);
							}
						}
					}
					if (failures.length > 0) {
						// A failed chunk must not discard the rest of the reply. Keep sending the remaining
						// text and media, then report the logical message as partial.
						const firstFailure = failures[0] ?? "unknown send failure";
						const deliveryStatus =
							sentCount > 0 || failures.some((reason) => /timeout/i.test(reason))
								? "uncertain"
								: "failed";
						await database
							.update(messages)
							.set({
								deliveryStatus,
								platformMessageId: firstPlatformMessageId,
								updatedAt: new Date().toISOString(),
							})
							.where(eq(messages.id, target.id));
						await this.#audit({
							action: "message.send-reply",
							payload: {
								chatKind: target.chatKind,
								failedCount: failures.length,
								platformConversationId,
								sentCount,
								unitCount: target.units.length,
							},
							reason: firstFailure,
							result: "failed",
							targetId: target.sessionId,
							targetKind: "session",
						});
						this.#logger.warn("assistant reply partially delivered", {
							channelId,
							chatKind: target.chatKind,
							deliveryStatus,
							failedCount: failures.length,
							firstFailure,
							platformConversationId,
							sentCount,
							sessionId: target.sessionId,
						});
						return deliveryStatus;
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
							chatKind: target.chatKind,
							platformConversationId,
							sentCount,
							unitCount: target.units.length,
						},
						result: "ok",
						targetId: target.sessionId,
						targetKind: "session",
					});
					this.#logger.debug("reply delivered to channel", {
						channelId,
						chatKind: target.chatKind,
						durationMs: Math.round(performance.now() - startedAt),
						platformConversationId,
						sentCount,
						sessionId: target.sessionId,
					});
					return "sent";
				} catch (error) {
					if (error instanceof OutputCancelledError) {
						const deliveryStatus = sentCount === 0 ? "failed" : "uncertain";
						await database
							.update(messages)
							.set({
								deliveryStatus,
								platformMessageId: firstPlatformMessageId,
								updatedAt: new Date().toISOString(),
							})
							.where(eq(messages.id, target.id));
						await this.#audit({
							action: "message.cancel-output",
							payload: {
								chatKind: target.chatKind,
								platformConversationId,
								remainingUnits: target.units.length,
								sentCount,
							},
							reason: "superseded by new inbound activity",
							result: "ok",
							targetId: target.sessionId,
							targetKind: "session",
						});
						this.#logger.info("assistant reply delivery cancelled", {
							sentCount,
							sessionId: target.sessionId,
						});
						return deliveryStatus;
					}
					const message = error instanceof Error ? error.message : String(error);
					return this.#fail(database, target.id, target.sessionId, message, {
						chatKind: target.chatKind,
						platformConversationId,
					});
				} finally {
					if (target.policy.pacing.typingEnabled) {
						await this.#channels.sendTyping(
							channelId,
							target.chatKind,
							platformConversationId,
							false,
						);
					}
					if (this.#pendingOutput.get(target.conversationId) === controller) {
						this.#pendingOutput.delete(target.conversationId);
					}
				}
			},
			this.#lock,
		);
	}

	async #quoteTarget(
		database: TsukaimaDatabase,
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
		database: TsukaimaDatabase,
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

class OutputCancelledError extends Error {
	constructor() {
		super("Output cancelled");
		this.name = "OutputCancelledError";
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
