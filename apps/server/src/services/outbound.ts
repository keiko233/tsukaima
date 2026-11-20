import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { messagePartsText, type MessageEnvelope, type MessagePart } from "@tsukaima/contracts";
import {
	chatObjects,
	conversations,
	identities,
	messages,
	users,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import {
	hasPermission,
	type AuditEntry,
	type OutboundTarget,
	type PluginOutboundApi,
	type PluginOutboundInteractionInput,
	type PluginOutboundSendInput,
	type SendResult,
} from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { ConversationRouter } from "./conversation-router.ts";
import type { HookBus } from "./hook-bus.ts";

export interface OutboundServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void>;
	readonly channels: ChannelRegistry;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly hooks?: HookBus;
	readonly logger: Logger;
	/**
	 * Report a successful channel send to the reply dispatcher, so a final answer repeating the
	 * text a tool already posted is not delivered twice.
	 */
	readonly onDirectSend?: (durableConversationId: string, text: string) => void;
	readonly onToolSend?: (input: {
		readonly durableConversationId: string;
		readonly hasMedia: boolean;
		readonly parts: readonly MessagePart[];
		readonly pluginId: string;
		readonly sessionId: string;
		readonly text: string;
	}) => void;
	readonly router: () => ConversationRouter;
}

/**
 * Host-owned outbound path for plugin-initiated channel actions. A plugin that sends directly
 * through its adapter leaves no durable trace, so the WebUI transcript and later turns never see
 * the message. Everything here lands in the same `messages` rows the reply dispatcher writes.
 */
export class OutboundService {
	readonly #audit: ((entry: AuditEntry) => Promise<void>) | undefined;
	readonly #channels: ChannelRegistry;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #hooks: HookBus | undefined;
	readonly #logger: Logger;
	readonly #onDirectSend: OutboundServiceOptions["onDirectSend"];
	readonly #onToolSend: OutboundServiceOptions["onToolSend"];
	readonly #router: () => ConversationRouter;

	constructor(options: OutboundServiceOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#logger = options.logger;
		this.#onDirectSend = options.onDirectSend;
		this.#onToolSend = options.onToolSend;
		this.#router = options.router;
	}

	/** Absent without a channel permission, so plugins cannot reach the outbound path unauthorised. */
	forPlugin(pluginId: string, permissions: readonly string[]): PluginOutboundApi | undefined {
		const canSend = hasPermission(permissions, "channel.send");
		const canInteract = hasPermission(permissions, "channel.interact");
		if (!canSend && !canInteract) return undefined;
		return {
			send: async (input) => {
				if (!canSend) throw new Error(`Plugin ${pluginId} cannot send to channels`);
				return await this.send(pluginId, input);
			},
			recordInteraction: async (input) => {
				if (!canInteract) throw new Error(`Plugin ${pluginId} cannot interact with channels`);
				await this.recordInteraction(pluginId, input);
			},
		};
	}

	async send(pluginId: string, input: PluginOutboundSendInput): Promise<SendResult> {
		const database = this.#requireDatabase();
		const { target } = input;
		const adapter = this.#channels.get(target.channelId);
		if (adapter === undefined) {
			throw new Error(`Channel ${target.channelId} is not registered`);
		}
		const resolved = await this.#resolve(target);
		// A tool send from another conversation (cross-chat `onebot-napcat.send`) is recorded in
		// the target transcript, but it must never mark the target's active turn as already
		// shown: the reply to that turn is unrelated to this message.
		const originMatches =
			input.originConversationId === undefined ||
			input.originConversationId === resolved.durableConversationId;
		const now = new Date().toISOString();
		const id = randomUUID();
		await database.insert(messages).values({
			chatObjectId: resolved.chatObjectId,
			contentText: messagePartsText(input.parts) || null,
			conversationId: resolved.sessionId,
			direction: "outbound",
			deliveryStatus: "pending",
			id,
			ingestedAt: now,
			kind: adapter.kind,
			occurredAt: now,
			partsJson: JSON.stringify(input.parts),
			senderDisplayName: "Tsukaima",
			senderExternalId: "tsukaima",
			updatedAt: now,
		});
		this.#logger.debug("plugin outbound send recorded", {
			conversationId: resolved.sessionId,
			messageId: id,
			pluginId,
			preview: previewText(messagePartsText(input.parts)),
			targetKind: target.kind,
		});
		try {
			const result = await this.#channels.send(
				target.channelId,
				target.kind,
				target.platformConversationId,
				input.parts,
				input.options,
			);
			await database
				.update(messages)
				.set({
					deliveryStatus: "sent",
					...(result.platformMessageId === undefined
						? {}
						: { platformMessageId: result.platformMessageId }),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messages.id, id));
			const text = messagePartsText(input.parts);
			if (originMatches && text.trim().length > 0) {
				this.#onDirectSend?.(resolved.durableConversationId, text);
			}
			await this.#touch(resolved.chatObjectId, resolved.sessionId);
			this.#notify({ channelId: target.channelId, ...resolved, messageId: id });
			if (originMatches) {
				this.#onToolSend?.({
					durableConversationId: resolved.durableConversationId,
					hasMedia: input.parts.some((part) => part.type !== "text"),
					parts: input.parts,
					pluginId,
					sessionId: resolved.sessionId,
					text,
				});
			}
			return result;
		} catch (error) {
			await database
				.update(messages)
				.set({ deliveryStatus: "failed", updatedAt: new Date().toISOString() })
				.where(eq(messages.id, id));
			await this.#touch(resolved.chatObjectId, resolved.sessionId);
			this.#logger.warn("plugin outbound send failed", {
				conversationId: resolved.sessionId,
				messageId: id,
				pluginId,
				reason: error instanceof Error ? error.message : String(error),
			});
			await this.#audit?.({
				action: "channel.outbound-send",
				actorId: pluginId,
				actorKind: "plugin",
				payload: { conversationId: resolved.sessionId, messageId: id },
				reason: error instanceof Error ? error.message : String(error),
				result: "failed",
				targetId: resolved.sessionId,
				targetKind: "session",
			});
			throw error;
		}
	}

	/**
	 * Persist an interaction the plugin already performed on the platform (a poke, a forward
	 * bundle) so it appears in the transcript next to inbound notices.
	 */
	async recordInteraction(pluginId: string, input: PluginOutboundInteractionInput): Promise<void> {
		const database = this.#requireDatabase();
		const adapter = this.#channels.get(input.target.channelId);
		const resolved = await this.#resolve(input.target);
		const now = new Date().toISOString();
		const id = randomUUID();
		const nativeType = input.nativeType ?? "notice:interaction";
		const parts: MessagePart[] = [{ nativeType, summary: input.summary, type: "channel-native" }];
		await database.insert(messages).values({
			chatObjectId: resolved.chatObjectId,
			contentText: input.summary,
			conversationId: resolved.sessionId,
			direction: "system",
			deliveryStatus: "sent",
			id,
			ingestedAt: now,
			kind: "notice",
			occurredAt: now,
			partsJson: JSON.stringify(parts),
			senderDisplayName: "Tsukaima",
			senderExternalId: "tsukaima",
			updatedAt: now,
		});
		await this.#touch(resolved.chatObjectId, resolved.sessionId);
		this.#notify({ channelId: input.target.channelId, ...resolved, messageId: id });
		this.#logger.debug("plugin channel interaction recorded", {
			conversationId: resolved.sessionId,
			kind: adapter?.kind ?? "plugin",
			messageId: id,
			nativeType,
			pluginId,
		});
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async #touch(chatObjectId: string, sessionId: string): Promise<void> {
		const database = this.#requireDatabase();
		const now = new Date().toISOString();
		await Promise.all([
			database.update(chatObjects).set({ updatedAt: now }).where(eq(chatObjects.id, chatObjectId)),
			database.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, sessionId)),
		]);
	}

	async #resolve(target: OutboundTarget): Promise<{
		chatObjectId: string;
		durableConversationId: string;
		sessionId: string;
	}> {
		if (target.kind !== "private" && target.kind !== "group") {
			throw new Error(`Outbound recording does not support ${target.kind} targets`);
		}
		const conversationKey: MessageEnvelope["conversationKey"] =
			target.kind === "group"
				? { groupId: target.platformConversationId, kind: "group" }
				: { kind: "private", peerId: target.platformConversationId };
		const displayName = await this.#displayName(target);
		const recipient = await this.#router().resolveSession(
			{ channelId: target.channelId, conversationKey },
			displayName,
		);
		return {
			chatObjectId: recipient.chatObjectId,
			durableConversationId: recipient.durableConversationId,
			sessionId: recipient.sessionId,
		};
	}

	/** Prefer the identity display name; the platform id keeps an unknown peer readable. */
	async #displayName(target: OutboundTarget): Promise<string> {
		if (target.kind === "group") return `Group ${target.platformConversationId}`;
		const database = this.#database();
		const adapter = this.#channels.get(target.channelId);
		if (database === undefined || adapter === undefined) {
			return `Private ${target.platformConversationId}`;
		}
		const [row] = await database
			.select({ displayName: users.displayName })
			.from(identities)
			.innerJoin(users, eq(users.id, identities.canonicalUserId))
			.where(
				and(
					eq(identities.platform, adapter.kind),
					eq(identities.platformAccountId, target.channelId),
					eq(identities.externalId, target.platformConversationId),
					eq(identities.kind, "user"),
				),
			)
			.limit(1);
		return row?.displayName ?? `Private ${target.platformConversationId}`;
	}

	#notify(event: {
		channelId: string;
		chatObjectId: string;
		messageId: string;
		sessionId: string;
	}): void {
		this.#hooks?.emitDetached("message.received", {
			channelId: event.channelId,
			chatObjectId: event.chatObjectId,
			envelope: { id: event.messageId },
			sessionId: event.sessionId,
		});
	}
}
