import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
	buildTriggerContext,
	classifyConversationTrigger,
	type PiDurableConversationHost,
	type ResolvedReplyTarget,
} from "@tsukaima/core";
import type { ConversationPolicy, MessagePart } from "@tsukaima/contracts";
import {
	channelNoticeSchema,
	conversationPolicySchema,
	defaultConversationPolicy,
	messageEnvelopeSchema,
	messagePartsText,
	type ChannelNotice,
	type MessageEnvelope,
	type TriggerDecision,
} from "@tsukaima/contracts";
import {
	chatObjects,
	conversations,
	conversationMembers,
	identities,
	messages,
	type TsukaimaDatabase,
	users,
	userAliases,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import type { ConversationPacingTracker } from "./conversation-pacing.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";

export interface ConversationIngestResult {
	readonly chatObjectId: string;
	readonly classification: TriggerDecision;
	readonly duplicated: boolean;
	readonly envelope?: MessageEnvelope;
	readonly ignored: boolean;
	readonly sessionId: string;
}

export interface ConversationRouterOptions {
	/** Apply conversation-scoped model tool visibility before a turn is submitted. */
	readonly applyModelToolPolicy?: (
		durableConversationId: string,
		policy: ConversationPolicy,
	) => Promise<void> | void;
	readonly audit?: (entry: AuditEntry) => Promise<void>;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	/** Rate limit for ignored-trigger audit rows, per channel/conversation key. */
	readonly ignoredAuditIntervalMs?: number;
	readonly logger: Logger;
	/**
	 * Store an inbound media part's bytes and return the part rewritten to reference them.
	 * Without this an inbound image keeps only its remote URL, so nothing renders and the model
	 * sees a placeholder.
	 */
	readonly ingestMedia?: (part: MessagePart) => Promise<MessagePart>;
	readonly onInboundTrigger?: (durableConversationId: string) => void;
	readonly pacing?: ConversationPacingTracker;
	readonly policy?: ConversationPolicyService;
	/**
	 * Durable prompt-hook text inserted before the next turn. A hook failure is logged and
	 * skipped: injection must never block message ingestion.
	 */
	readonly promptContext?: (
		sessionId: string,
		durableConversationId: string,
	) => Promise<string | undefined>;
}

export const messageText = messagePartsText;

/**
 * Ordering key for the domain timeline. Every row that reaches the timeline must use the same
 * clock domain, so this is always local receipt time.
 *
 * Platform timestamps are NOT a safe ordering key: a remote OneBot host runs its own clock and
 * nothing guarantees it agrees with this process. NapCat hosts are commonly a few tens of
 * seconds off, and an inbound message stamped in the future sorts *after* the assistant reply it
 * caused, which reads as a scrambled transcript. Outbound rows are written from `Date.now()`,
 * so mixing platform time into the same column splits the timeline across two clock domains.
 *
 * The platform timestamp stays available as evidence on `raw_ref_json`.
 */
const timelineAt = (now: string): string => now;

const noticeSummary = (notice: ChannelNotice): string => {
	const actor = notice.actorDisplayName ?? notice.actorId ?? "unknown";
	const target = notice.targetUserId ?? notice.targetMessageId;
	const self = notice.isSelfTarget === true ? " (bot)" : "";
	return target === undefined
		? `[${notice.noticeType}] ${actor}${self}`
		: `[${notice.noticeType}] ${actor} -> ${target}${self}`;
};

const safeChannelId = (envelope: unknown): string => {
	if (typeof envelope === "object" && envelope !== null && "channelId" in envelope) {
		const value = (envelope as { channelId?: unknown }).channelId;
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "unknown";
};

/**
 * Channel-agnostic ingestion: identity resolution, chat-object/session resolution, durable
 * append, and domain message persistence. Any channel adapter can drive it with a
 * `MessageEnvelope`.
 */
export class ConversationRouter {
	readonly #applyModelToolPolicy: ConversationRouterOptions["applyModelToolPolicy"];
	readonly #audit: ConversationRouterOptions["audit"];
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #ignoredAuditIntervalMs: number;
	readonly #logger: Logger;
	readonly #onInboundTrigger: ConversationRouterOptions["onInboundTrigger"];
	readonly #pacing: ConversationPacingTracker | undefined;
	readonly #policy: ConversationPolicyService | undefined;
	readonly #promptContext: ConversationRouterOptions["promptContext"];
	readonly #ingesting = new Set<string>();
	readonly #ignoredAuditAt = new Map<string, number>();
	readonly #ingestMedia: ((part: MessagePart) => Promise<MessagePart>) | undefined;
	readonly #stats = {
		ambient: 0,
		direct: 0,
		ignored: 0,
		soft: 0,
	};

	constructor(options: ConversationRouterOptions) {
		this.#applyModelToolPolicy = options.applyModelToolPolicy;
		this.#audit = options.audit;
		this.#database = options.database;
		this.#host = options.host;
		this.#ignoredAuditIntervalMs = options.ignoredAuditIntervalMs ?? 60_000;
		this.#ingestMedia = options.ingestMedia;
		this.#logger = options.logger;
		this.#onInboundTrigger = options.onInboundTrigger;
		this.#pacing = options.pacing;
		this.#policy = options.policy;
		this.#promptContext = options.promptContext;
	}

	triggerStats(): {
		readonly ambient: number;
		readonly direct: number;
		readonly ignored: number;
		readonly soft: number;
	} {
		return { ...this.#stats };
	}

	async ingest(envelope: MessageEnvelope): Promise<ConversationIngestResult> {
		const parsed = messageEnvelopeSchema.safeParse(envelope);
		if (!parsed.success) {
			const channelId = safeChannelId(envelope);
			const reason = parsed.error.issues
				.slice(0, 4)
				.map((issue) => {
					const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
					return `${path}: ${issue.message}`;
				})
				.join("; ");
			this.#logger.warn("rejected invalid message envelope", { channelId, reason });
			throw new Error(`Invalid message envelope: ${reason}`);
		}
		const message = parsed.data;
		const ingestionKey = `${message.channelId}:${message.source.messageId ?? message.id}`;
		if (this.#ingesting.has(ingestionKey)) {
			throw new Error("Message is already being ingested");
		}
		this.#ingesting.add(ingestionKey);
		const startedAt = performance.now();
		const messageLog = this.#logger.span("process_message", {
			channelId: message.channelId,
			messageId: message.source.messageId ?? message.id,
		});
		messageLog.debug("channel message accepted", {
			conversationKind: message.conversationKey.kind,
			partCount: message.parts.length,
		});
		messageLog.trace("inbound message content preview", {
			preview: previewText(messageText(message.parts)),
			senderId: message.sender.platformId,
		});
		try {
			const host = this.#host();
			if (host === undefined) throw new Error("Conversation host is not ready");
			const database = this.#requireDatabase();
			const target = await this.resolveSession(message, message.sender.displayName);
			const platformMessageId = message.source.messageId ?? message.id;
			const existing = await database
				.select({ id: messages.id })
				.from(messages)
				.where(
					and(
						eq(messages.chatObjectId, target.chatObjectId),
						eq(messages.platformMessageId, platformMessageId),
					),
				)
				.limit(1);
			if (existing.length > 0) {
				messageLog.debug("duplicate channel message ignored", {
					chatObjectId: target.chatObjectId,
					sessionId: target.sessionId,
				});
				return {
					chatObjectId: target.chatObjectId,
					classification: "direct",
					duplicated: true,
					ignored: false,
					sessionId: target.sessionId,
				};
			}

			const policy =
				(await this.#policy?.effectivePolicy(target.sessionId)) ??
				conversationPolicySchema.parse(defaultConversationPolicy);
			const selfAliases =
				(await this.#policy?.selfAliases(target.sessionId, policy)) ?? policy.trigger.selfAliases;
			const replyTarget = await this.#resolveReplyTarget(
				database,
				target.chatObjectId,
				message.target?.replyToEnvelopeId,
			);
			const recentActivity =
				this.#pacing?.isRecentlyActive(
					target.durableConversationId,
					Math.max(300_000, policy.pacing.burstMaxWaitMs),
				) ?? false;
			const trigger = classifyConversationTrigger({
				chatKind: message.conversationKey.kind,
				envelope: message,
				policy,
				recentActivity,
				selfAliases,
				...(replyTarget === undefined ? {} : { replyTarget }),
			});
			this.#stats[trigger.classification] += 1;
			messageLog.debug("conversation trigger classified", {
				classification: trigger.classification,
				recentActivity,
				reason: trigger.reason,
				sessionId: target.sessionId,
			});

			if (trigger.classification === "ignored") {
				await this.#recordIgnored(message, target.sessionId, target.chatObjectId, trigger.reason);
				messageLog.warn("conversation trigger ignored", {
					chatObjectId: target.chatObjectId,
					reason: trigger.reason,
					sessionId: target.sessionId,
				});
				return {
					chatObjectId: target.chatObjectId,
					classification: "ignored",
					duplicated: false,
					ignored: true,
					sessionId: target.sessionId,
				};
			}

			const sender = await this.resolveIdentity(message);
			// Fetch media bytes before durable append and persistence so both the model turn input
			// (which resolves local blobs via `mediaId`/`sha256`) and the persisted transcript see
			// the local media reference. Best-effort: a failed fetch keeps the original part.
			const hydratedMessage = await this.#hydrateInboundMedia(message);
			if (trigger.classification !== "ambient") {
				this.#onInboundTrigger?.(target.durableConversationId);
				await this.#policy?.ensureHostPolicy(target.sessionId, target.durableConversationId);
				try {
					await this.#applyModelToolPolicy?.(target.durableConversationId, policy);
				} catch (error) {
					messageLog.warn("conversation model tool policy failed", {
						error: error instanceof Error ? error.message : String(error),
						sessionId: target.sessionId,
					});
				}
				const cooldownMs =
					this.#pacing?.remainingCooldownMs(target.durableConversationId, policy) ?? 0;
				messageLog.debug("appending turn to durable conversation", {
					classification: trigger.classification,
					collectOnly: cooldownMs > 0,
					cooldownMs,
					durableConversationId: target.durableConversationId,
				});
				const injected = await this.#injectedPrompt(target.sessionId, target.durableConversationId);
				await host.append({
					classification: trigger.classification,
					collectOnly: cooldownMs > 0,
					conversationId: target.durableConversationId,
					envelope: hydratedMessage,
					submittedAtMs: Date.now(),
					triggerContext: [
						buildTriggerContext({
							classification: trigger.classification,
							result: trigger,
							...(hydratedMessage.sender.isBot === undefined
								? {}
								: { senderIsBot: hydratedMessage.sender.isBot }),
						}),
						...(injected === undefined ? [] : [injected]),
					].join("\n\n"),
				});
				if (cooldownMs > 0) {
					host.scheduleActivityFlushAfter(target.durableConversationId, cooldownMs);
				}
			}
			await this.#persistInbound(database, {
				classification: trigger.classification,
				envelope: hydratedMessage,
				sender,
				target,
			});
			messageLog.info("channel message processed", {
				chatObjectId: target.chatObjectId,
				classification: trigger.classification,
				durationMs: Math.round(performance.now() - startedAt),
				sessionId: target.sessionId,
			});
			return {
				chatObjectId: target.chatObjectId,
				classification: trigger.classification,
				duplicated: false,
				envelope: hydratedMessage,
				ignored: false,
				sessionId: target.sessionId,
			};
		} finally {
			this.#ingesting.delete(ingestionKey);
		}
	}

	async #injectedPrompt(
		sessionId: string,
		durableConversationId: string,
	): Promise<string | undefined> {
		try {
			return await this.#promptContext?.(sessionId, durableConversationId);
		} catch (error) {
			this.#logger.warn("prompt hook injection failed", {
				durableConversationId,
				error: error instanceof Error ? error.message : String(error),
				sessionId,
			});
			return undefined;
		}
	}

	async #hydrateInboundMedia(envelope: MessageEnvelope): Promise<MessageEnvelope> {
		if (this.#ingestMedia === undefined) return envelope;
		const ingestMedia = this.#ingestMedia;
		const parts = await Promise.all(
			envelope.parts.map(async (part) => {
				try {
					return await ingestMedia(part);
				} catch (error) {
					this.#logger.warn("inbound media could not be stored", {
						error: error instanceof Error ? error.message : String(error),
						type: part.type,
					});
					return part;
				}
			}),
		);
		return { ...envelope, parts };
	}

	async #recordIgnored(
		envelope: MessageEnvelope,
		sessionId: string,
		chatObjectId: string,
		reason: string,
	): Promise<void> {
		const key = `${envelope.channelId}:${chatObjectId}`;
		const now = Date.now();
		if (now - (this.#ignoredAuditAt.get(key) ?? 0) < this.#ignoredAuditIntervalMs) return;
		this.#ignoredAuditAt.set(key, now);
		this.#logger.warn("ignored inbound activity", {
			channelId: envelope.channelId,
			chatObjectId,
			reason,
			// Counter is cumulative; the audit/log row is rate-limited per conversation.
			ignoredTotal: this.#stats.ignored,
		});
		try {
			await this.#audit?.({
				action: "conversation.trigger-ignored",
				actorId: envelope.sender.platformId,
				actorKind: "user",
				payload: {
					channelId: envelope.channelId,
					conversationKind: envelope.conversationKey.kind,
					reason,
				},
				result: "denied",
				targetId: sessionId,
				targetKind: "session",
			});
		} catch {
			// Audit failure must not make unauthorized traffic retryable.
		}
	}

	async #resolveReplyTarget(
		database: TsukaimaDatabase,
		chatObjectId: string,
		replyToEnvelopeId: string | undefined,
	): Promise<ResolvedReplyTarget | undefined> {
		if (replyToEnvelopeId === undefined) return undefined;
		const [row] = await database
			.select({
				direction: messages.direction,
				senderExternalId: messages.senderExternalId,
				senderKind: messages.senderExternalId,
			})
			.from(messages)
			.where(
				and(
					eq(messages.chatObjectId, chatObjectId),
					eq(messages.platformMessageId, replyToEnvelopeId),
				),
			)
			.limit(1);
		if (row === undefined) return undefined;
		return {
			direction: row.direction,
			senderExternalId: row.senderExternalId,
			senderKind:
				row.direction === "outbound"
					? "assistant"
					: row.senderExternalId === "tsukaima"
						? "assistant"
						: "human",
		};
	}

	async #persistInbound(
		database: TsukaimaDatabase,
		input: {
			classification: "ambient" | "direct" | "soft";
			envelope: MessageEnvelope;
			sender: { displayName: string; userId: string };
			target: { chatObjectId: string; sessionId: string };
		},
	): Promise<void> {
		const message = input.envelope;
		const parts = message.parts;
		const now = new Date().toISOString();
		// Local clock only: outbound rows are stamped from `Date.now()` and both share this
		// ordering key, so a remote platform timestamp here would reorder the transcript.
		const occurredAt = timelineAt(now);
		await database
			.insert(messages)
			.values({
				chatObjectId: input.target.chatObjectId,
				contentText: messageText(parts),
				conversationId: input.target.sessionId,
				direction: "inbound",
				id: randomUUID(),
				ingestedAt: now,
				kind: message.channelKind,
				occurredAt,
				partsJson: JSON.stringify(parts),
				platformMessageId: message.source.messageId ?? message.id,
				rawRefJson: JSON.stringify(message),
				...(message.target?.replyToEnvelopeId === undefined
					? {}
					: { replyToMessageId: message.target.replyToEnvelopeId }),
				senderDisplayName: input.sender.displayName,
				senderExternalId: message.sender.platformId,
				senderUserId: input.sender.userId,
				triggerClassification: input.classification,
				updatedAt: now,
			})
			.onConflictDoNothing();
		await Promise.all([
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, input.target.chatObjectId)),
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, input.target.sessionId)),
		]);
		if (message.conversationKey.kind === "group") {
			await database
				.insert(conversationMembers)
				.values({
					conversationId: input.target.sessionId,
					lastSeenAt: occurredAt,
					role: message.sender.groupRole === "admin" ? "admin" : "member",
					userId: input.sender.userId,
					...(message.sender.groupRole === undefined
						? {}
						: { platformRole: message.sender.groupRole }),
				})
				.onConflictDoUpdate({
					set: { lastSeenAt: occurredAt },
					target: [conversationMembers.conversationId, conversationMembers.userId],
				});
		}
	}

	/**
	 * Persist a platform notice as a system/notice row on the resolved session. Notices never
	 * call the conversation host and never trigger a model turn; Phase 2 supplies wake policy
	 * on top of the persisted `isSelfTarget` fact.
	 */
	async ingestNotice(notice: ChannelNotice): Promise<{
		readonly duplicated: boolean;
		readonly persisted: boolean;
		readonly sessionId?: string;
	}> {
		const parsed = channelNoticeSchema.safeParse(notice);
		if (!parsed.success) throw new Error("Invalid channel notice");
		const value = parsed.data;
		if (value.noticeType === "typing" && value.details?.persist !== true) {
			this.#logger.trace("channel typing notice skipped", {
				channelId: value.channelId,
				noticeId: value.id,
			});
			return { duplicated: false, persisted: false };
		}
		const database = this.#requireDatabase();
		const actorId = value.actorId;
		const displayName = value.actorDisplayName ?? actorId ?? "system";
		const envelope: MessageEnvelope = {
			channelId: value.channelId,
			channelKind: value.channelKind,
			conversationKey: value.conversationKey,
			id: value.id,
			mentions: [],
			parts: [
				{
					nativeType: `notice:${value.noticeType}`,
					type: "channel-native",
					summary: noticeSummary(value),
					...(value.isSelfTarget === undefined
						? {}
						: { safeFields: { isSelfTarget: value.isSelfTarget } }),
				},
			],
			sender: {
				displayName,
				id: actorId ?? "system",
				isBot: false,
				platformId: actorId ?? "system",
			},
			source: {
				messageId: value.id,
				receivedAtMs: Date.now(),
				timestampMs: value.occurredAtMs,
			},
		};
		const sender = actorId === undefined ? undefined : await this.resolveIdentity(envelope);
		const target = await this.resolveSession(envelope, sender?.displayName ?? displayName);
		const existing = await database
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.chatObjectId, target.chatObjectId),
					eq(messages.platformMessageId, value.id),
				),
			)
			.limit(1);
		if (existing.length > 0) {
			this.#logger.trace("duplicate channel notice ignored", {
				channelId: value.channelId,
				noticeId: value.id,
				noticeType: value.noticeType,
				sessionId: target.sessionId,
			});
			return { duplicated: true, persisted: true, sessionId: target.sessionId };
		}
		const now = new Date().toISOString();
		const occurredAt = timelineAt(now);
		await database
			.insert(messages)
			.values({
				chatObjectId: target.chatObjectId,
				contentText: noticeSummary(value),
				conversationId: target.sessionId,
				direction: "system",
				id: randomUUID(),
				ingestedAt: now,
				kind: "notice",
				occurredAt,
				partsJson: JSON.stringify(envelope.parts),
				platformMessageId: value.id,
				rawRefJson: JSON.stringify(value),
				senderDisplayName: sender?.displayName ?? displayName,
				senderExternalId: actorId ?? "system",
				...(sender === undefined ? {} : { senderUserId: sender.userId }),
				updatedAt: now,
			})
			.onConflictDoNothing();
		await Promise.all([
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, target.chatObjectId)),
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, target.sessionId)),
		]);
		this.#logger.debug("channel notice persisted", {
			channelId: value.channelId,
			isSelfTarget: value.isSelfTarget ?? false,
			noticeId: value.id,
			noticeType: value.noticeType,
			sessionId: target.sessionId,
		});
		return { duplicated: false, persisted: true, sessionId: target.sessionId };
	}

	async resolveIdentity(
		envelope: MessageEnvelope,
	): Promise<{ displayName: string; userId: string }> {
		const database = this.#requireDatabase();
		const displayName = envelope.sender.displayName;
		const platform = envelope.channelKind;
		const platformAccountId = envelope.channelId;
		const externalId = envelope.sender.platformId;
		const kind = envelope.sender.isBot === true ? "bot" : "human";
		const now = new Date().toISOString();

		// A single synchronous transaction over the serialized Bun SQLite connection: no
		// concurrent ingestion can observe or create a duplicate identity for this key, so we
		// never return (or leak) an orphan user that a losing insert would have produced.
		return database.transaction((tx) => {
			const findIdentity = () =>
				tx
					.select({
						displayName: users.displayName,
						userId: users.id,
					})
					.from(identities)
					.innerJoin(users, eq(users.id, identities.canonicalUserId))
					.where(
						and(
							eq(identities.platform, platform),
							eq(identities.platformAccountId, platformAccountId),
							eq(identities.externalId, externalId),
							eq(identities.kind, "user"),
						),
					)
					.limit(1)
					.get();
			const existing = findIdentity();
			if (existing !== undefined) {
				if (existing.displayName !== displayName) {
					tx.update(users)
						.set({ displayName, updatedAt: now })
						.where(eq(users.id, existing.userId))
						.run();
				}
				return { displayName, userId: existing.userId };
			}
			const userId = randomUUID();
			tx.insert(users)
				.values({
					createdAt: now,
					displayName,
					id: userId,
					kind,
					updatedAt: now,
				})
				.run();
			const inserted = tx
				.insert(identities)
				.values({
					canonicalUserId: userId,
					createdAt: now,
					displayName,
					externalId,
					id: randomUUID(),
					kind: "user",
					platform,
					platformAccountId,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: identities.id })
				.get();
			if (inserted !== undefined) {
				tx.insert(userAliases)
					.values({
						alias: displayName,
						createdAt: now,
						id: randomUUID(),
						source: platform,
						userId,
					})
					.onConflictDoNothing()
					.run();
				return { displayName, userId };
			}
			// Another connection already inserted this identity: discard our orphan user and adopt
			// the canonical one. No messages can reference the orphan yet, so the delete is safe.
			tx.delete(users).where(eq(users.id, userId)).run();
			const winner = findIdentity();
			if (winner === undefined) {
				throw new Error("Failed to resolve identity after insert conflict");
			}
			return { displayName: winner.displayName ?? displayName, userId: winner.userId };
		});
	}

	async resolveSession(
		envelope: MessageEnvelope,
		senderDisplayName: string,
	): Promise<{
		chatObjectId: string;
		durableConversationId: string;
		sessionId: string;
	}> {
		const host = this.#host();
		if (host === undefined) throw new Error("Conversation host is not ready");
		const database = this.#requireDatabase();
		const kind = envelope.conversationKey.kind;
		if (kind !== "private" && kind !== "group") {
			throw new Error(`External processing does not support ${kind} conversations`);
		}
		const platformConversationId =
			kind === "group" ? envelope.conversationKey.groupId : envelope.conversationKey.peerId;
		if (platformConversationId === undefined) {
			throw new Error("External conversation is missing its platform conversation id");
		}
		const findChatObject = async () => {
			const [row] = await database
				.select()
				.from(chatObjects)
				.where(
					and(
						eq(chatObjects.channelId, envelope.channelId),
						eq(chatObjects.kind, kind),
						eq(chatObjects.platformConversationId, platformConversationId),
					),
				)
				.limit(1);
			return row;
		};
		let chat = await findChatObject();
		if (chat === undefined) {
			const now = new Date().toISOString();
			await database
				.insert(chatObjects)
				.values({
					channelId: envelope.channelId,
					createdAt: now,
					id: randomUUID(),
					kind,
					platformConversationId,
					title: kind === "group" ? `Group ${platformConversationId}` : senderDisplayName,
					updatedAt: now,
				})
				.onConflictDoNothing();
			chat = await findChatObject();
		}
		if (chat === undefined) throw new Error("Failed to resolve chat object");
		const [receiving] = await database
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.chatObjectId, chat.id),
					eq(conversations.isReceiving, 1),
					eq(conversations.status, "active"),
				),
			)
			.limit(1);
		if (receiving !== undefined) {
			return {
				chatObjectId: chat.id,
				durableConversationId: receiving.durableConversationId,
				sessionId: receiving.id,
			};
		}
		const [latest] = await database
			.select()
			.from(conversations)
			.where(and(eq(conversations.chatObjectId, chat.id), eq(conversations.status, "active")))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (latest !== undefined) {
			await database
				.update(conversations)
				.set({ isReceiving: 1 })
				.where(eq(conversations.id, latest.id));
			return {
				chatObjectId: chat.id,
				durableConversationId: latest.durableConversationId,
				sessionId: latest.id,
			};
		}
		const durableConversationId = await host.createConversation();
		const sessionId = randomUUID();
		await database
			.insert(conversations)
			.values({
				channelId: envelope.channelId,
				chatObjectId: chat.id,
				durableConversationId,
				id: sessionId,
				isReceiving: 1,
				kind,
				platformConversationId,
				title: "Main",
			})
			.onConflictDoNothing();
		const [created] = await database
			.select()
			.from(conversations)
			.where(eq(conversations.id, sessionId))
			.limit(1);
		if (created !== undefined) {
			return { chatObjectId: chat.id, durableConversationId, sessionId };
		}
		const [winner] = await database
			.select()
			.from(conversations)
			.where(and(eq(conversations.chatObjectId, chat.id), eq(conversations.isReceiving, 1)))
			.limit(1);
		if (winner === undefined) throw new Error("Failed to resolve receiving session");
		return {
			chatObjectId: chat.id,
			durableConversationId: winner.durableConversationId,
			sessionId: winner.id,
		};
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}
