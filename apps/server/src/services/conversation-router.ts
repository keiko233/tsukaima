import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PiDurableConversationHost } from "@elaina/core";
import { messageEnvelopeSchema, type MessageEnvelope, type MessagePart } from "@elaina/contracts";
import {
	chatObjects,
	conversations,
	conversationMembers,
	identities,
	messages,
	type ElainaDatabase,
	users,
	userAliases,
} from "@elaina/db";
import type { Logger } from "../logging.ts";

export interface ConversationIngestResult {
	readonly activityId: string;
	readonly chatObjectId: string;
	readonly duplicated: boolean;
	readonly sessionId: string;
}

export interface ConversationRouterOptions {
	readonly database: () => ElainaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly logger: Logger;
}

export const messageText = (parts: readonly MessagePart[]): string =>
	parts
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join(" ")
		.trim();

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
	readonly #database: () => ElainaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #logger: Logger;
	readonly #ingesting = new Set<string>();

	constructor(options: ConversationRouterOptions) {
		this.#database = options.database;
		this.#host = options.host;
		this.#logger = options.logger;
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
		});
		try {
			const host = this.#host();
			if (host === undefined) throw new Error("Conversation host is not ready");
			const database = this.#requireDatabase();
			const sender = await this.resolveIdentity(message);
			const target = await this.resolveSession(message, sender.displayName);
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
					activityId: "",
					chatObjectId: target.chatObjectId,
					duplicated: true,
					sessionId: target.sessionId,
				};
			}
			const result = await host.append({
				conversationId: target.durableConversationId,
				envelope: message,
				submittedAtMs: Date.now(),
			});
			const occurredAt = new Date(
				message.source.timestampMs > 0 ? message.source.timestampMs : Date.now(),
			).toISOString();
			const now = new Date().toISOString();
			await database
				.insert(messages)
				.values({
					activityId: result.activityId,
					chatObjectId: target.chatObjectId,
					contentText: messageText(message.parts),
					conversationId: target.sessionId,
					direction: "inbound",
					id: randomUUID(),
					ingestedAt: now,
					kind: message.channelKind,
					occurredAt,
					partsJson: JSON.stringify(message.parts),
					platformMessageId,
					rawRefJson: JSON.stringify(message),
					...(message.target?.replyToEnvelopeId === undefined
						? {}
						: { replyToMessageId: message.target.replyToEnvelopeId }),
					senderDisplayName: sender.displayName,
					senderExternalId: message.sender.platformId,
					senderUserId: sender.userId,
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
			if (message.conversationKey.kind === "group") {
				await database
					.insert(conversationMembers)
					.values({
						conversationId: target.sessionId,
						lastSeenAt: occurredAt,
						role: message.sender.groupRole === "admin" ? "admin" : "member",
						userId: sender.userId,
						...(message.sender.groupRole === undefined
							? {}
							: { platformRole: message.sender.groupRole }),
					})
					.onConflictDoUpdate({
						set: { lastSeenAt: occurredAt },
						target: [conversationMembers.conversationId, conversationMembers.userId],
					});
			}
			messageLog.info("channel message processed", {
				chatObjectId: target.chatObjectId,
				durationMs: Math.round(performance.now() - startedAt),
				duplicated: result.deduplicated,
				sessionId: target.sessionId,
			});
			return {
				activityId: result.activityId,
				chatObjectId: target.chatObjectId,
				duplicated: result.deduplicated,
				sessionId: target.sessionId,
			};
		} finally {
			this.#ingesting.delete(ingestionKey);
		}
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

	#requireDatabase(): ElainaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}
