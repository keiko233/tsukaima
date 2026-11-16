import { desc, eq } from "drizzle-orm";
import { consumeProactiveMarkers, type ConversationPolicy } from "@tsukaima/contracts";
import {
	withConversationLock,
	type ConversationExecutionLock,
	type PiDurableConversationHost,
} from "@tsukaima/core";
import { chatObjects, conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";
import {
	hasPermission,
	type AuditEntry,
	type PluginBackgroundTurnInput,
	type PluginBackgroundTurnResult,
	type PluginConversationMessage,
	type PluginConversationsApi,
	type PluginConversationSummary,
	type PluginPermission,
} from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { ReplyDispatcher } from "./reply-dispatcher.ts";

const MAX_RECENT_MESSAGES = 50;
const MAX_PREVIEW_CHARS = 240;

type ConversationRow = typeof conversations.$inferSelect;
type ChatRow = typeof chatObjects.$inferSelect;

interface ResolvedConversation extends PluginConversationSummary {
	readonly platformConversationId: string | null;
}

export interface PluginConversationServiceOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly channels: ChannelRegistry;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly lock?: ConversationExecutionLock;
	readonly logger: Logger;
	readonly policy: ConversationPolicyService;
	readonly replyDispatcher: ReplyDispatcher;
	readonly now?: () => number;
}

function summaryFrom(row: ConversationRow, chat: ChatRow | undefined): ResolvedConversation {
	return {
		chatObjectId: row.chatObjectId ?? null,
		channelId: row.channelId ?? chat?.channelId ?? null,
		durableConversationId: row.durableConversationId,
		id: row.id,
		kind: row.kind,
		muted: chat?.muted === 1,
		platformConversationId: row.platformConversationId ?? chat?.platformConversationId ?? null,
		status: row.status,
		title: chat?.title ?? row.title ?? "",
		updatedAt: row.updatedAt,
	};
}

function insideQuietHours(policy: ConversationPolicy, nowMs: number): boolean {
	const quiet = policy.pacing.quietHours;
	if (quiet?.enabled !== true) return false;
	const hour = new Date(nowMs).getHours();
	if (quiet.startHour === quiet.endHour) return true;
	if (quiet.startHour < quiet.endHour) {
		return hour >= quiet.startHour && hour < quiet.endHour;
	}
	return hour >= quiet.startHour || hour < quiet.endHour;
}

/**
 * Host implementation of the permission-checked `context.conversations` surface. Conversation
 * text is only returned through bounded previews and is never logged here.
 */
export class PluginConversationService {
	readonly #audit: PluginConversationServiceOptions["audit"];
	readonly #channels: ChannelRegistry;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #lock: ConversationExecutionLock | undefined;
	readonly #logger: Logger;
	readonly #policy: ConversationPolicyService;
	readonly #replyDispatcher: ReplyDispatcher;
	readonly #now: () => number;

	constructor(options: PluginConversationServiceOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#host = options.host;
		this.#lock = options.lock;
		this.#logger = options.logger.child("tsukaima::server::plugin-conversations");
		this.#policy = options.policy;
		this.#replyDispatcher = options.replyDispatcher;
		this.#now = options.now ?? Date.now;
	}

	forPlugin(
		pluginId: string,
		grantedPermissions: readonly PluginPermission[],
	): PluginConversationsApi {
		return {
			get: async (conversationId) => {
				this.#assert(grantedPermissions, "conversation.read", pluginId);
				return await this.#get(conversationId);
			},
			getPolicy: async (conversationId) => {
				this.#assert(grantedPermissions, "conversation.read", pluginId);
				const conversation = await this.#get(conversationId);
				if (conversation === undefined) {
					throw new Error(`Unknown conversation ${conversationId}`);
				}
				return await this.#policy.effectivePolicy(conversationId);
			},
			list: async () => {
				this.#assert(grantedPermissions, "conversation.read", pluginId);
				return await this.#list();
			},
			recentMessages: async (conversationId, limit) => {
				this.#assert(grantedPermissions, "conversation.read", pluginId);
				return await this.#recentMessages(conversationId, limit);
			},
			submitBackgroundTurn: async (input) => {
				this.#assert(grantedPermissions, "conversation.read", pluginId);
				this.#assert(grantedPermissions, "channel.send", pluginId);
				return await this.#submitBackgroundTurn(pluginId, input);
			},
		};
	}

	#assert(
		granted: readonly PluginPermission[],
		required: PluginPermission,
		pluginId: string,
	): void {
		if (!hasPermission(granted, required)) {
			throw new Error(`Plugin ${pluginId} is not granted permission ${required}`);
		}
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async #list(): Promise<readonly PluginConversationSummary[]> {
		const database = this.#requireDatabase();
		const rows = await database
			.select({ chat: chatObjects, conversation: conversations })
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.orderBy(desc(conversations.updatedAt));
		return rows.map((row) => summaryFrom(row.conversation, row.chat ?? undefined));
	}

	async #get(conversationId: string): Promise<ResolvedConversation | undefined> {
		const database = this.#requireDatabase();
		const [row] = await database
			.select({ chat: chatObjects, conversation: conversations })
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.id, conversationId))
			.limit(1);
		return row === undefined ? undefined : summaryFrom(row.conversation, row.chat ?? undefined);
	}

	async #recentMessages(
		conversationId: string,
		limit = 10,
	): Promise<readonly PluginConversationMessage[]> {
		const database = this.#requireDatabase();
		const bounded = Math.min(MAX_RECENT_MESSAGES, Math.max(1, Math.floor(limit)));
		const rows = await database
			.select({
				contentText: messages.contentText,
				direction: messages.direction,
				deliveryStatus: messages.deliveryStatus,
				id: messages.id,
				kind: messages.kind,
				occurredAt: messages.occurredAt,
				partsJson: messages.partsJson,
				senderDisplayName: messages.senderDisplayName,
			})
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.orderBy(desc(messages.occurredAt))
			.limit(bounded);
		return rows.toReversed().map((row) => ({
			direction: row.direction,
			deliveryStatus: row.deliveryStatus ?? null,
			id: row.id,
			kind: row.kind,
			occurredAt: row.occurredAt,
			senderDisplayName: row.senderDisplayName ?? null,
			textPreview: previewOf(row.contentText, row.partsJson),
		}));
	}

	async #submitBackgroundTurn(
		pluginId: string,
		input: PluginBackgroundTurnInput,
	): Promise<PluginBackgroundTurnResult> {
		const conversation = await this.#get(input.conversationId);
		if (conversation === undefined) {
			this.#logger.debug("plugin background turn skipped", {
				conversationId: input.conversationId,
				kind: input.kind,
				pluginId,
				reason: "unknown_conversation",
			});
			return { delivered: false, deliveryStatus: "skipped", skippedReason: "unknown_conversation" };
		}
		const host = this.#host();
		if (host === undefined) {
			this.#logger.debug("plugin background turn skipped", {
				conversationId: conversation.id,
				kind: input.kind,
				pluginId,
				reason: "host_unavailable",
			});
			return { delivered: false, deliveryStatus: "skipped", skippedReason: "host_unavailable" };
		}
		this.#logger.debug("plugin background turn started", {
			conversationId: conversation.id,
			kind: input.kind,
			pluginId,
		});
		this.#logger.trace("plugin background turn prompt preview", {
			conversationId: conversation.id,
			kind: input.kind,
			pluginId,
			promptPreview: previewText(input.prompt),
		});
		const result = await withConversationLock(
			conversation.id,
			async (): Promise<PluginBackgroundTurnResult> => {
				const policy = await this.#policy.effectivePolicy(conversation.id);
				if (!policy.enabled) {
					return {
						delivered: false,
						deliveryStatus: "skipped",
						skippedReason: "conversation_disabled",
					};
				}
				const access =
					conversation.kind === "group"
						? policy.trigger.groupAccess
						: conversation.kind === "private"
							? policy.trigger.privateAccess
							: "open";
				if (access === "disabled") {
					return {
						delivered: false,
						deliveryStatus: "skipped",
						skippedReason: "conversation_access_disabled",
					};
				}
				if (insideQuietHours(policy, this.#now())) {
					return {
						delivered: false,
						deliveryStatus: "skipped",
						skippedReason: "conversation_quiet_hours",
					};
				}
				const channelProblem = this.#channelProblem(conversation);
				if (channelProblem !== undefined) {
					return {
						delivered: false,
						deliveryStatus: "skipped",
						skippedReason: channelProblem,
					};
				}
				const turn = await host.submitBackgroundTurn({
					conversationId: conversation.durableConversationId,
					...(input.context === undefined ? {} : { context: input.context }),
					kind: input.kind,
					prompt: input.prompt,
				});
				const consumed = consumeProactiveMarkers(turn.text);
				if (consumed.marker !== undefined) {
					await this.#record(pluginId, input, conversation.id, "suppressed", consumed.marker);
					return {
						delivered: false,
						deliveryStatus: "suppressed",
						marker: consumed.marker,
						...(consumed.scheduleLaterMs === undefined
							? {}
							: { scheduleLaterMs: consumed.scheduleLaterMs }),
						skippedReason: `marker_${consumed.marker}`,
						text: consumed.text,
					};
				}
				if (consumed.text.length === 0) {
					await this.#record(pluginId, input, conversation.id, "skipped", "empty_output");
					return { delivered: false, deliveryStatus: "skipped", skippedReason: "empty_output" };
				}
				const outcome = await this.#replyDispatcher.handleAnswer({
					activityId: turn.activityId,
					conversationId: conversation.durableConversationId,
					entryId: turn.entryId,
					text: consumed.text,
				});
				const deliveryStatus = outcome?.deliveryStatus ?? "skipped";
				await this.#record(pluginId, input, conversation.id, deliveryStatus, outcome?.reason);
				return {
					delivered: deliveryStatus === "sent",
					deliveryStatus,
					...(outcome?.reason === undefined ? {} : { skippedReason: outcome.reason }),
					text: consumed.text,
				};
			},
			this.#lock,
		);
		this.#logger.info("plugin background turn finished", {
			conversationId: conversation.id,
			delivered: result.delivered,
			deliveryStatus: result.deliveryStatus,
			kind: input.kind,
			pluginId,
			...(result.marker === undefined ? {} : { marker: result.marker }),
			...(result.skippedReason === undefined ? {} : { skippedReason: result.skippedReason }),
		});
		return result;
	}

	#channelProblem(conversation: ResolvedConversation): string | undefined {
		if (conversation.kind !== "private" && conversation.kind !== "group") return undefined;
		const channelId = conversation.channelId;
		if (channelId === null) return "channel_unavailable";
		const adapter = this.#channels.get(channelId);
		if (adapter === undefined) return "channel_unavailable";
		if (adapter.diagnostics().connected !== true) return "channel_disconnected";
		if (!this.#channels.hasCapability(channelId, "send", conversation.id)) {
			return "channel_send_unavailable";
		}
		if (conversation.platformConversationId === null) return "channel_destination_missing";
		return undefined;
	}

	async #record(
		pluginId: string,
		input: PluginBackgroundTurnInput,
		conversationId: string,
		deliveryStatus: string,
		reason: string | undefined,
	): Promise<void> {
		await this.#audit({
			action: "proactive.background-turn",
			actorId: pluginId,
			actorKind: "plugin",
			payload: {
				conversationId,
				deliveryStatus,
				kind: input.kind,
				...(input.taskId === undefined ? {} : { taskId: input.taskId }),
			},
			...(reason === undefined ? {} : { reason }),
			result:
				deliveryStatus === "sent"
					? "ok"
					: deliveryStatus === "failed" || deliveryStatus === "uncertain"
						? "failed"
						: "denied",
			targetId: input.taskId ?? conversationId,
			targetKind: input.taskId === undefined ? "conversation" : "proactive-task",
		});
	}
}

function previewOf(contentText: string | null, partsJson: string | null): string {
	if (typeof contentText === "string" && contentText.trim().length > 0) {
		return contentText.trim().slice(0, MAX_PREVIEW_CHARS);
	}
	if (partsJson === null) return "";
	try {
		const parsed = JSON.parse(partsJson) as unknown;
		if (!Array.isArray(parsed)) return "";
		const text = parsed
			.flatMap((part) => {
				if (typeof part !== "object" || part === null || !("type" in part)) return [];
				if (part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
				return [part.text];
			})
			.join(" ")
			.trim();
		return text.slice(0, MAX_PREVIEW_CHARS);
	} catch {
		return "";
	}
}
