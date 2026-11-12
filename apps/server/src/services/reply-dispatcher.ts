import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { MessagePart } from "@tsukaima/contracts";
import type { ConversationAnswer } from "@tsukaima/core";
import { chatObjects, conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { HookBus } from "./hook-bus.ts";

type ChatKind = "private" | "group" | "webui" | "task" | "plugin";

const isExternalChat = (kind: ChatKind): kind is "private" | "group" =>
	kind === "private" || kind === "group";

export interface ReplyDispatcherOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly channels: ChannelRegistry;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly hooks: HookBus;
	readonly logger: Logger;
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

	constructor(options: ReplyDispatcherOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("tsukaima::server::reply");
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

	async #deliver(
		database: TsukaimaDatabase,
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
		try {
			const result = await this.#channels.send(
				channelId,
				target.chatKind,
				platformConversationId,
				target.parts,
			);
			const platformMessageId = result.platformMessageId ?? null;
			await database
				.update(messages)
				.set({ deliveryStatus: "sent", platformMessageId, updatedAt: new Date().toISOString() })
				.where(eq(messages.id, target.id));
			await this.#audit({
				action: "message.send-reply",
				payload: { chatKind: target.chatKind, platformConversationId },
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
