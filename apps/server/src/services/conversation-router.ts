import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PiDurableConversationHost } from "@tsukaima/core";
import type { MessageEnvelope, MessagePart } from "@tsukaima/contracts";
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
import type { Logger } from "../logging.ts";

export interface ConversationIngestResult {
	readonly activityId: string;
	readonly chatObjectId: string;
	readonly duplicated: boolean;
	readonly sessionId: string;
}

export interface ConversationRouterOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly logger: Logger;
}

export const messageText = (parts: readonly MessagePart[]): string =>
	parts
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join(" ")
		.trim();

/**
 * Channel-agnostic ingestion: identity resolution, chat-object/session resolution, durable
 * append, and domain message persistence. Any channel adapter can drive it with a
 * `MessageEnvelope`.
 */
export class ConversationRouter {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #logger: Logger;
	readonly #ingesting = new Set<string>();

	constructor(options: ConversationRouterOptions) {
		this.#database = options.database;
		this.#host = options.host;
		this.#logger = options.logger;
	}

	async ingest(envelope: MessageEnvelope): Promise<ConversationIngestResult> {
		const ingestionKey = `${envelope.channelId}:${envelope.source.messageId ?? envelope.id}`;
		if (this.#ingesting.has(ingestionKey)) {
			throw new Error("Message is already being ingested");
		}
		this.#ingesting.add(ingestionKey);
		const startedAt = performance.now();
		const messageLog = this.#logger.span("process_message", {
			channelId: envelope.channelId,
			messageId: envelope.source.messageId ?? envelope.id,
		});
		messageLog.debug("channel message accepted", {
			conversationKind: envelope.conversationKey.kind,
		});
		try {
			const host = this.#host();
			if (host === undefined) throw new Error("Conversation host is not ready");
			const database = this.#requireDatabase();
			const sender = await this.resolveIdentity(envelope);
			const target = await this.resolveSession(envelope, sender.displayName);
			const platformMessageId = envelope.source.messageId ?? envelope.id;
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
				envelope,
				submittedAtMs: Date.now(),
			});
			const occurredAt = new Date(
				envelope.source.timestampMs > 0 ? envelope.source.timestampMs : Date.now(),
			).toISOString();
			const now = new Date().toISOString();
			await database
				.insert(messages)
				.values({
					activityId: result.activityId,
					chatObjectId: target.chatObjectId,
					contentText: messageText(envelope.parts),
					conversationId: target.sessionId,
					direction: "inbound",
					id: randomUUID(),
					ingestedAt: now,
					kind: envelope.channelKind,
					occurredAt,
					partsJson: JSON.stringify(envelope.parts),
					platformMessageId,
					rawRefJson: JSON.stringify(envelope),
					...(envelope.target?.replyToEnvelopeId === undefined
						? {}
						: { replyToMessageId: envelope.target.replyToEnvelopeId }),
					senderDisplayName: sender.displayName,
					senderExternalId: envelope.sender.platformId,
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
			if (envelope.conversationKey.kind === "group") {
				await database
					.insert(conversationMembers)
					.values({
						conversationId: target.sessionId,
						lastSeenAt: occurredAt,
						role: envelope.sender.groupRole === "admin" ? "admin" : "member",
						userId: sender.userId,
						...(envelope.sender.groupRole === undefined
							? {}
							: { platformRole: envelope.sender.groupRole }),
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
		const [existing] = await database
			.select({
				displayName: users.displayName,
				userId: users.id,
			})
			.from(identities)
			.innerJoin(users, eq(users.id, identities.canonicalUserId))
			.where(
				and(
					eq(identities.platform, envelope.channelKind),
					eq(identities.platformAccountId, envelope.channelId),
					eq(identities.externalId, envelope.sender.platformId),
					eq(identities.kind, "user"),
				),
			)
			.limit(1);
		if (existing !== undefined) {
			if (existing.displayName !== displayName) {
				await database
					.update(users)
					.set({ displayName, updatedAt: new Date().toISOString() })
					.where(eq(users.id, existing.userId));
			}
			return { displayName, userId: existing.userId };
		}
		const userId = randomUUID();
		const now = new Date().toISOString();
		await database.insert(users).values({
			createdAt: now,
			displayName,
			id: userId,
			kind: envelope.sender.isBot === true ? "bot" : "human",
			updatedAt: now,
		});
		await database
			.insert(identities)
			.values({
				canonicalUserId: userId,
				createdAt: now,
				displayName,
				externalId: envelope.sender.platformId,
				id: randomUUID(),
				kind: "user",
				platform: envelope.channelKind,
				platformAccountId: envelope.channelId,
				updatedAt: now,
			})
			.onConflictDoNothing();
		await database
			.insert(userAliases)
			.values({
				alias: displayName,
				createdAt: now,
				id: randomUUID(),
				source: envelope.channelKind,
				userId,
			})
			.onConflictDoNothing();
		return { displayName, userId };
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
