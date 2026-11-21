import { and, desc, eq, ne, or } from "drizzle-orm";
import {
	consumeProactiveMarkers,
	messagePartSchema,
	type ConversationPolicy,
	type MessagePart,
} from "@tsukaima/contracts";
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
	/** Durable prompt hook text rendered before a background agent turn. */
	readonly promptContext?: (sessionId: string) => Promise<string | undefined>;
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
	readonly #promptContext: PluginConversationServiceOptions["promptContext"];

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
		this.#promptContext = options.promptContext;
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
				return await this.#policy.effectivePolicy(conversation.id);
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
			.where(
				or(
					eq(conversations.id, conversationId),
					eq(conversations.durableConversationId, conversationId),
				),
			)
			.limit(1);
		return row === undefined ? undefined : summaryFrom(row.conversation, row.chat ?? undefined);
	}

	async #recentMessages(
		conversationId: string,
		limit = 10,
	): Promise<readonly PluginConversationMessage[]> {
		const database = this.#requireDatabase();
		const resolved = await this.#get(conversationId);
		const targetConversationId = resolved?.id ?? conversationId;
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
				platformMessageId: messages.platformMessageId,
				senderDisplayName: messages.senderDisplayName,
			})
			.from(messages)
			.where(and(eq(messages.conversationId, targetConversationId), ne(messages.kind, "tool")))
			.orderBy(desc(messages.occurredAt))
			.limit(bounded);
		return rows.toReversed().map((row) => {
			const parts = parseParts(row.partsJson);
			return {
				direction: row.direction,
				deliveryStatus: row.deliveryStatus ?? null,
				id: row.id,
				kind: row.kind,
				occurredAt: row.occurredAt,
				...(parts.length === 0 ? {} : { parts }),
				platformMessageId: row.platformMessageId ?? null,
				senderDisplayName: row.senderDisplayName ?? null,
				textPreview: previewOf(row.contentText, row.partsJson),
			};
		});
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
				const hookContext = await this.#promptContext?.(conversation.id).catch(() => undefined);
				const context = [input.context, hookContext]
					.filter((entry): entry is string => entry !== undefined && entry.trim().length > 0)
					.join("\n\n");
				const requestId =
					input.taskId === undefined ? undefined : `plugin:${pluginId}:task:${input.taskId}`;
				// A scheduler retry after the durable answer landed must not run the model again.
				// Reuse the exact answer so marker handling and the follow-up handoff stay idempotent.
				if (requestId !== undefined && host.resolveSubmissionAnswer !== undefined) {
					const resolved = await host.resolveSubmissionAnswer(
						conversation.durableConversationId,
						requestId,
					);
					if (resolved.status === "answered") {
						return await this.#handleBackgroundAnswer({
							activityId: `${conversation.durableConversationId}:background`,
							conversation,
							entryId: resolved.entryId,
							input,
							pluginId,
							submissionRequestId: requestId,
							text: resolved.text,
						});
					}
				}
				const turn = await host.submitBackgroundTurn({
					conversationId: conversation.durableConversationId,
					...(context.length === 0 ? {} : { context }),
					kind: input.kind,
					origin: {
						followUpKind: input.followUpKind ?? "proactive",
						pluginId,
						...(input.taskId === undefined ? {} : { sourceTaskId: input.taskId }),
					},
					prompt: input.prompt,
					// A scheduler task retry must reuse the same durable submission. Otherwise a crash
					// after the answer but before the follow-up handoff could create a second turn.
					...(requestId === undefined ? {} : { requestId }),
				});
				return await this.#handleBackgroundAnswer({
					activityId: turn.activityId,
					conversation,
					entryId: turn.entryId,
					input,
					pluginId,
					submissionRequestId: turn.submissionRequestId,
					text: turn.text,
				});
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

	async #handleBackgroundAnswer(turn: {
		readonly activityId: string;
		readonly conversation: ResolvedConversation;
		readonly entryId: string;
		readonly input: PluginBackgroundTurnInput;
		readonly pluginId: string;
		readonly submissionRequestId: string;
		readonly text: string;
	}): Promise<PluginBackgroundTurnResult> {
		const { activityId, conversation, entryId, pluginId, submissionRequestId, text } = turn;
		const input = turn.input;
		const consumed = consumeProactiveMarkers(text);
		if (consumed.marker !== undefined) {
			const followUpRecorded =
				consumed.marker === "schedule-later"
					? await this.#replyDispatcher.deferExpectation({
							delayMs: consumed.scheduleLaterMs ?? 30 * 60_000,
							durableConversationId: conversation.durableConversationId,
							durableEntryId: entryId,
							followUpKind: input.followUpKind ?? "proactive",
							pluginId,
							...(input.taskId === undefined ? {} : { sourceTaskId: input.taskId }),
							submissionRequestId,
						})
					: await this.#replyDispatcher.suppressExpectation({
							durableConversationId: conversation.durableConversationId,
							durableEntryId: entryId,
							reason: `marker_${consumed.marker}`,
							submissionRequestId,
						});
			const followUpPending =
				consumed.marker === "schedule-later" &&
				(await this.#replyDispatcher.expectationPending(
					conversation.durableConversationId,
					submissionRequestId,
				));
			if (followUpPending) {
				this.#logger.warn("background follow-up remains pending", {
					conversationId: conversation.id,
					kind: input.kind,
					pluginId,
				});
				await this.#record(pluginId, input, conversation.id, "pending", "follow_up_pending");
			}
			if (!followUpPending) {
				await this.#record(pluginId, input, conversation.id, "suppressed", consumed.marker);
			}
			return {
				activityId,
				delivered: false,
				deliveryStatus: "suppressed",
				entryId,
				followUpRecorded: followUpRecorded && !followUpPending,
				...(followUpPending ? { followUpPending: true } : {}),
				marker: consumed.marker,
				...(consumed.scheduleLaterMs === undefined
					? {}
					: { scheduleLaterMs: consumed.scheduleLaterMs }),
				skippedReason: `marker_${consumed.marker}`,
				submissionRequestId,
				text: consumed.text,
			};
		}
		if (consumed.text.length === 0) {
			await this.#replyDispatcher.suppressExpectation({
				durableConversationId: conversation.durableConversationId,
				durableEntryId: entryId,
				reason: "empty_output",
				submissionRequestId,
			});
			await this.#record(pluginId, input, conversation.id, "skipped", "empty_output");
			return {
				activityId,
				delivered: false,
				deliveryStatus: "skipped",
				entryId,
				skippedReason: "empty_output",
				submissionRequestId,
			};
		}
		const outcome = await this.#replyDispatcher.handleAnswer({
			activityId,
			conversationId: conversation.durableConversationId,
			entryId,
			submissionRequestId,
			text: consumed.text,
		});
		const deliveryStatus = outcome?.deliveryStatus ?? "skipped";
		await this.#record(pluginId, input, conversation.id, deliveryStatus, outcome?.reason);
		return {
			activityId,
			delivered: deliveryStatus === "sent",
			deliveryStatus,
			entryId,
			...(outcome?.reason === undefined ? {} : { skippedReason: outcome.reason }),
			submissionRequestId,
			text: consumed.text,
		};
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

function parseParts(partsJson: string | null): readonly MessagePart[] {
	if (partsJson === null) return [];
	try {
		const parsed = JSON.parse(partsJson) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry) => {
			const checked = messagePartSchema.safeParse(entry);
			return checked.success ? [checked.data] : [];
		});
	} catch {
		return [];
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
