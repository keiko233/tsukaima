import { oc } from "@orpc/contract";
import { z } from "zod";
import { healthResponseSchema, messagePartSchema } from "./base.ts";
import {
	conversationPolicyPatchSchema,
	conversationPolicySchema,
	triggerClassificationSchema,
} from "./policy.ts";

/**
 * The oRPC contract is the single source of truth for the admin/health API. Every consumer
 * (server handlers, the WebUI client, tests) derives its input/output types from here, so the
 * wire surface cannot drift between the two sides.
 */

const chatKindSchema = z.enum(["private", "group", "webui", "task", "plugin"]);

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof logLevelSchema>;
export const deliveryStatusSchema = z.enum([
	"received",
	"pending",
	"accepted",
	"sent",
	"failed",
	"uncertain",
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export const channelStateSchema = z.string();

// ─── WebUI view models ───────────────────────────────────────────────────────

export const messageSummarySchema = z.object({
	contentText: z.string(),
	deliveryStatus: deliveryStatusSchema,
	direction: z.enum(["inbound", "outbound", "system"]),
	/**
	 * Durable entry this message was produced from, when it is an assistant answer. It is the
	 * handle the transcript uses to expand the run's steps; `null` for messages with no agent
	 * run behind them.
	 */
	durableEntryId: z.string().nullable(),
	id: z.string(),
	kind: z.string(),
	occurredAt: z.string(),
	parts: z.array(messagePartSchema),
	platformMessageId: z.string().nullable(),
	replyToMessageId: z.string().nullable(),
	senderDisplayName: z.string(),
	senderExternalId: z.string().nullable(),
	senderKind: z.enum(["human", "bot", "assistant", "system"]),
	triggerClassification: triggerClassificationSchema,
});
export type MessageSummary = z.infer<typeof messageSummarySchema>;

export const sessionSummarySchema = z.object({
	createdAt: z.string(),
	id: z.string(),
	isReceiving: z.boolean(),
	kind: z.string(),
	latestMessage: messageSummarySchema.nullable(),
	status: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const chatSummarySchema = z.object({
	channelId: z.string().nullable(),
	createdAt: z.string(),
	id: z.string(),
	kind: chatKindSchema,
	pinned: z.boolean(),
	platformConversationId: z.string().nullable(),
	sessions: z.array(sessionSummarySchema),
	status: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const sessionDetailSchema = z.object({
	channelId: z.string().nullable(),
	chat: z.object({
		id: z.string(),
		kind: chatKindSchema,
		platformConversationId: z.string().nullable(),
		status: z.string(),
		title: z.string(),
	}),
	createdAt: z.string(),
	id: z.string(),
	isReceiving: z.boolean(),
	kind: z.string(),
	status: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

export const sessionContextSectionSchema = z.object({
	key: z.string(),
	label: z.string(),
	tokens: z.number().int().nonnegative(),
});
export type SessionContextSection = z.infer<typeof sessionContextSectionSchema>;

export const sessionContextToolSchema = z.object({
	deferred: z.boolean(),
	description: z.string(),
	name: z.string(),
	tokens: z.number().int().nonnegative(),
});
export type SessionContextTool = z.infer<typeof sessionContextToolSchema>;

export const sessionContextMemoryItemSchema = z.object({
	id: z.string().nullable(),
	kind: z.string(),
	scope: z.string(),
	summary: z.string(),
	tier: z.enum(["recent", "warm", "long-term"]),
});
export type SessionContextMemoryItem = z.infer<typeof sessionContextMemoryItemSchema>;

export const sessionContextStatsSchema = z.object({
	autocompact: z.object({
		backgroundTokens: z.number().int().nonnegative(),
		bufferTokens: z.number().int().nonnegative(),
		enabled: z.boolean(),
		keepRecentTokens: z.number().int().nonnegative(),
	}),
	categories: z.object({
		memoriesTokens: z.number().int().nonnegative(),
		messagesTokens: z.number().int().nonnegative(),
		otherSystemTokens: z.number().int().nonnegative(),
		personaTokens: z.number().int().nonnegative(),
		policyTokens: z.number().int().nonnegative(),
		toolsTokens: z.number().int().nonnegative(),
	}),
	compacted: z.boolean(),
	contextWindow: z.number().int().nonnegative(),
	deferredToolsTokens: z.number().int().nonnegative(),
	freeSpaceTokens: z.number().int().nonnegative(),
	measuredUsageTokens: z.number().int().nonnegative().nullable(),
	memories: z.object({
		enabled: z.boolean(),
		items: z.array(sessionContextMemoryItemSchema),
		recentCount: z.number().int().nonnegative(),
		warmTopics: z.array(z.string()),
	}),
	messageCount: z.number().int().nonnegative(),
	model: z.object({
		modelId: z.string(),
		providerId: z.string(),
	}),
	personaName: z.string().nullable(),
	sections: z.array(sessionContextSectionSchema),
	tokenSource: z.enum(["usage", "estimated"]),
	tools: z.array(sessionContextToolSchema),
	usedPercent: z.number().nonnegative(),
	usedTokens: z.number().int().nonnegative(),
});
export type SessionContextStats = z.infer<typeof sessionContextStatsSchema>;

// ─── Raw domain rows ─────────────────────────────────────────────────────────

export const conversationRowSchema = z.object({
	chatObjectId: z.string().nullable(),
	channelId: z.string().nullable(),
	createdAt: z.string(),
	durableConversationId: z.string(),
	id: z.string(),
	isReceiving: z.number().int(),
	kind: chatKindSchema,
	platformConversationId: z.string().nullable(),
	status: z.string(),
	title: z.string().nullable(),
	updatedAt: z.string(),
});
export type ConversationRow = z.infer<typeof conversationRowSchema>;

export const modelPolicyRowSchema = z.object({
	allowedToolsJson: z.string().nullable(),
	capability: z.string(),
	createdAt: z.string(),
	dailyBudgetUsd: z.number().nullable(),
	fallbacksJson: z.string(),
	id: z.string(),
	isActive: z.number().int(),
	maxOutputTokens: z.number().int().nullable(),
	primaryModel: z.string(),
	primaryProvider: z.string(),
	thinkingLevel: z.string().nullable(),
	updatedAt: z.string(),
});
export type ModelPolicyRow = z.infer<typeof modelPolicyRowSchema>;

export const requestRowSchema = z.object({
	accountId: z.string(),
	channelId: z.string(),
	comment: z.string().nullable(),
	createdAt: z.string(),
	errorMessage: z.string().nullable(),
	flag: z.string(),
	groupExternalId: z.string().nullable(),
	id: z.string(),
	kind: z.enum(["friend", "group-add", "group-invite"]),
	rawJson: z.string().nullable(),
	requesterDisplayName: z.string().nullable(),
	requesterExternalId: z.string(),
	resolutionAction: z.enum(["approve", "reject"]).nullable(),
	resolutionReason: z.string().nullable(),
	resolvedAt: z.string().nullable(),
	status: z.enum(["pending", "approved", "rejected", "failed", "uncertain"]),
	subType: z.string().nullable(),
	updatedAt: z.string(),
});
export type RequestRow = z.infer<typeof requestRowSchema>;

const chatObjectRowSchema = z.object({
	channelId: z.string().nullable(),
	createdAt: z.string(),
	id: z.string(),
	kind: chatKindSchema,
	muted: z.number().int(),
	pinned: z.number().int(),
	platformConversationId: z.string().nullable(),
	status: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});

export const groupSummarySchema = z.object({
	channelId: z.string().nullable(),
	createdAt: z.string(),
	id: z.string(),
	memberCount: z.number().int(),
	platformConversationId: z.string().nullable(),
	sessionCount: z.number().int(),
	status: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const groupDetailSchema = groupSummarySchema.extend({
	members: z.array(
		z.object({
			displayName: z.string(),
			platformRole: z.string().nullable(),
			role: z.string(),
			userId: z.string(),
		}),
	),
	sessions: z.array(conversationRowSchema),
});
export type GroupDetail = z.infer<typeof groupDetailSchema>;

const identitySummarySchema = z.object({
	displayName: z.string().nullable(),
	externalId: z.string(),
	id: z.string(),
	platform: z.string(),
	platformAccountId: z.string(),
});

export const userSummarySchema = z.object({
	displayName: z.string(),
	identities: z.array(identitySummarySchema),
	id: z.string(),
	kind: z.enum(["human", "bot", "system"]),
	notes: z.string().nullable(),
	preferredName: z.string().nullable(),
	trustLevel: z.string(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const userDetailSchema = userSummarySchema.extend({
	aliases: z.array(z.string()),
	chats: z.array(chatObjectRowSchema.extend({ sessions: z.array(conversationRowSchema) })),
	groups: z.array(chatObjectRowSchema),
});
export type UserDetail = z.infer<typeof userDetailSchema>;

// ─── Plugins ─────────────────────────────────────────────────────────────────

export const pluginStatusLevelSchema = z.enum(["ok", "warning", "error", "unknown"]);
export type PluginStatusLevel = z.infer<typeof pluginStatusLevelSchema>;

const pluginStatusScalarSchema = z.union([z.string().max(2048), z.number(), z.boolean()]);

export const pluginStatusInputSchema = z.object({
	level: pluginStatusLevelSchema,
	code: z.string().max(256).optional(),
	summary: z.string().max(2048).optional(),
	message: z.string().max(8192).optional(),
	progress: z
		.object({
			current: z.number().nonnegative(),
			total: z.number().positive().optional(),
			label: z.string().max(512).optional(),
		})
		.optional(),
	metrics: z.record(z.string().max(128), pluginStatusScalarSchema).optional(),
	details: z
		.record(z.string().max(128), z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]))
		.optional(),
	staleAfterMs: z.number().int().positive().max(86_400_000).optional(),
});
export type PluginStatusInput = z.infer<typeof pluginStatusInputSchema>;

export const pluginStatusSnapshotSchema = pluginStatusInputSchema.extend({
	updatedAt: z.string().min(1),
});
export type PluginStatusSnapshot = z.infer<typeof pluginStatusSnapshotSchema>;

export const pluginUiDefinitionSchema = z.object({
	component: z.string(),
	data: z.record(z.string(), z.unknown()),
	i18nKeys: z.array(z.string()).readonly().optional(),
	id: z.string(),
	kind: z.enum(["panel", "conversation-action", "message-card", "settings-form", "approval-card"]),
	requiredPermissions: z.array(z.string()).readonly().optional(),
	schema: z.record(z.string(), z.unknown()).optional(),
	slot: z
		.enum(["panel", "conversation-action", "message-card", "settings-form", "approval-card"])
		.optional(),
	title: z.string(),
	version: z.string().optional(),
});
export type PluginUiDefinitionRow = z.infer<typeof pluginUiDefinitionSchema>;

export const pluginLifecycleStateSchema = z.object({
	failureCount: z.number().int().nonnegative(),
	quarantinedAt: z.string().nullable(),
	quarantineReason: z.string().nullable(),
	retainData: z.boolean(),
});
export type PluginLifecycleState = z.infer<typeof pluginLifecycleStateSchema>;

export const pluginRowSchema = z.object({
	apiVersion: z.string(),
	config: z.record(z.string(), z.unknown()),
	configSchema: z.record(z.string(), z.unknown()).optional(),
	enabled: z.number().int(),
	id: z.string(),
	kind: z.enum(["builtin", "first-party", "third-party"]),
	lifecycle: pluginLifecycleStateSchema.optional(),
	modelProviders: z.array(z.string()).readonly(),
	name: z.string(),
	permissions: z.array(z.string()).readonly(),
	runMode: z.enum(["host", "worker"]),
	rpcMethods: z.array(z.string()).readonly(),
	secretKeys: z.array(z.string()).readonly(),
	secretsSet: z.array(z.string()).readonly(),
	status: pluginStatusSnapshotSchema.nullable(),
	tools: z.array(z.string()).readonly(),
	ui: z.array(pluginUiDefinitionSchema).readonly(),
	version: z.string(),
});
export type PluginRow = z.infer<typeof pluginRowSchema>;

export const pluginConfigUpdateInputSchema = z.object({
	config: z.record(z.string(), z.unknown()),
	pluginId: z.string().min(1),
});

export const pluginEnabledUpdateInputSchema = z.object({
	enabled: z.boolean(),
	pluginId: z.string().min(1),
});

export const pluginRpcInputSchema = z.object({
	input: z.unknown().optional(),
	method: z.string().min(1),
	pluginId: z.string().min(1).optional(),
});

export const pluginManifestInputSchema = z.record(z.string(), z.unknown());

export const pluginInstallInputSchema = z.object({
	config: z.record(z.string(), z.unknown()).optional(),
	enabled: z.boolean().optional(),
	grantedPermissions: z.array(z.string()).optional(),
	manifest: pluginManifestInputSchema,
	runMode: z.enum(["host", "worker"]).optional(),
});

export const pluginUpgradeInputSchema = z.object({
	config: z.record(z.string(), z.unknown()).optional(),
	grantedPermissions: z.array(z.string()).optional(),
	manifest: pluginManifestInputSchema,
	pluginId: z.string().min(1),
});

export const pluginDowngradeInputSchema = z.object({
	manifest: pluginManifestInputSchema,
	pluginId: z.string().min(1),
});

export const pluginLifecycleInputSchema = z.object({
	pluginId: z.string().min(1),
});

export const pluginUninstallInputSchema = z.object({
	pluginId: z.string().min(1),
	retainData: z.boolean().optional(),
});

// ─── Diagnostics ─────────────────────────────────────────────────────────────

const logValueSchema: z.ZodType<unknown> = z.unknown();

export const logEntrySchema = z.object({
	ansi: z.string(),
	fields: z.record(z.string(), logValueSchema),
	id: z.number().int(),
	level: logLevelSchema,
	message: z.string(),
	span: z
		.object({
			fields: z.record(z.string(), logValueSchema),
			name: z.string(),
		})
		.nullable(),
	target: z.string(),
	text: z.string(),
	timestamp: z.string(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const logSnapshotSchema = z.object({
	capacity: z.number().int(),
	dropped: z.number().int(),
	entries: z.array(logEntrySchema),
});
export type LogSnapshot = z.infer<typeof logSnapshotSchema>;

export const modelUsageRecordSchema = z.object({
	capability: z.string(),
	inputTokens: z.number().int(),
	modelId: z.string(),
	outputTokens: z.number().int(),
	providerId: z.string(),
});

export const modelRefSchema = z.object({
	modelId: z.string(),
	providerId: z.string(),
});

export const modelPolicySchema = z.object({
	capability: z.string(),
	fallbacks: z.array(modelRefSchema).optional(),
	maxOutputTokens: z.number().int().optional(),
	primary: modelRefSchema,
	thinking: z.enum(["off", "low", "medium", "high"]).optional(),
});
export type ModelPolicy = z.infer<typeof modelPolicySchema>;

export const diagnosticsDataSchema = z.object({
	channels: z.array(
		z.object({
			connected: z.boolean(),
			configured: z.boolean(),
			eventCount: z.number().int(),
			id: z.string(),
			kind: z.string(),
			lastErrorClass: z.string().nullable(),
			mode: z.string().optional(),
			origin: z.string().optional(),
			reconnectAttempts: z.number().int(),
			remoteAddress: z.string().optional(),
			restartRequired: z.boolean(),
			state: channelStateSchema,
		}),
	),
	lastError: z.string().optional(),
	logLevel: logLevelSchema,
	processedMessages: z.number().int(),
	providerRestartRequired: z.boolean(),
	routingPolicies: z.array(modelPolicySchema),
	state: z.object({
		reason: z.string().optional(),
		stage: z.string(),
		startedAtMs: z.number().int(),
		state: z.enum(["starting", "degraded", "ready", "maintenance", "failed"]),
	}),
	usage: z.array(modelUsageRecordSchema),
	usageTotals: z.object({
		inputTokens: z.number().int(),
		outputTokens: z.number().int(),
	}),
});
export type DiagnosticsData = z.infer<typeof diagnosticsDataSchema>;

// ─── Settings ────────────────────────────────────────────────────────────────

export const settingsViewSchema = z.object({
	logLevel: logLevelSchema,
	modelProviderId: z.string().optional(),
	plugins: z.array(
		z.object({
			config: z.record(z.string(), z.unknown()),
			id: z.string(),
			secretsSet: z.array(z.string()),
		}),
	),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

export const runtimeSettingsSchema = z.object({
	logLevel: logLevelSchema,
	/** Plugin id that owns the active model provider. */
	modelProviderId: z.string().min(1).optional(),
});
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export const runtimeSettingsPatchSchema = z
	.object({
		logLevel: logLevelSchema.optional(),
		modelProviderId: z.union([z.string().min(1), z.literal(""), z.null()]).optional(),
	})
	.refine((input) => input.logLevel !== undefined || input.modelProviderId !== undefined, {
		message: "At least one setting must be provided",
	});
export type RuntimeSettingsPatch = z.infer<typeof runtimeSettingsPatchSchema>;

// ─── Input schemas ───────────────────────────────────────────────────────────

const sessionIdInputSchema = z.object({ sessionId: z.string().min(1) });

/** Which assistant turn to expand. `entryId` is `messages.durableEntryId`. */
export const runStepsInputSchema = z.object({
	entryId: z.string().min(1),
	sessionId: z.string().min(1),
});

export const chatsCreateLocalInputSchema = z.object({
	sessionTitle: z.string().trim().min(1).max(120),
	title: z.string().trim().min(1).max(120),
});

export const chatsListInputSchema = z
	.object({ status: z.enum(["active", "archived", "all"]).optional() })
	.optional();

export const diagnosticsLogsInputSchema = z
	.object({
		afterId: z.number().int().nonnegative().optional(),
		level: logLevelSchema.optional(),
		limit: z.number().int().positive().max(10_000).optional(),
	})
	.optional();

export const groupsGetInputSchema = z.object({ groupId: z.string().min(1) });

export const modelPoliciesSetInputSchema = z.object({
	capability: z.string().min(1),
	maxOutputTokens: z.number().int().positive().optional(),
	primaryModel: z.string().min(1),
	primaryProvider: z.string().min(1),
});

export const requestsGetInputSchema = z.object({ requestId: z.string().min(1) });

export const requestsListInputSchema = z
	.object({ status: z.enum(["all", "pending", "processed"]).optional() })
	.optional();

export const requestsRespondInputSchema = z.object({
	action: z.enum(["approve", "reject"]),
	reason: z.string().trim().max(300).optional(),
	requestId: z.string().min(1),
});

export const sessionsCreateInputSchema = z.object({
	chatObjectId: z.string().min(1),
	title: z.string().trim().min(1).max(120),
});

export const sessionsSendInputSchema = z.object({
	sessionId: z.string().min(1),
	target: z.enum(["channel", "elaina"]),
	text: z.string().trim().min(1).max(8_000),
});

export const sessionsUpdateInputSchema = z.object({
	sessionId: z.string().min(1),
	status: z.enum(["active", "archived"]).optional(),
	title: z.string().trim().min(1).max(120).optional(),
});

export const usersGetInputSchema = z.object({ userId: z.string().min(1) });

const createLocalChatOutputSchema = z.object({
	chatId: z.string(),
	sessionId: z.string(),
});

const createSessionOutputSchema = z.object({ id: z.string() });
const okSchema = z.object({ ok: z.literal(true) });

// ─── Auth ────────────────────────────────────────────────────────────────────

export const authStatusOutputSchema = z.object({
	authenticated: z.boolean(),
	configured: z.boolean(),
	username: z.string().optional(),
});
export type AuthStatus = z.infer<typeof authStatusOutputSchema>;

// ─── Live event stream ───────────────────────────────────────────────────────

const liveEventTimestampSchema = z.object({
	timestamp: z.string().min(1),
});

export const liveSnapshotEventSchema = liveEventTimestampSchema.extend({
	lifecycle: z.object({
		reason: z.string().optional(),
		stage: z.string().min(1),
		startedAtMs: z.number().int().nonnegative(),
		state: z.enum(["starting", "degraded", "ready", "maintenance", "failed"]),
	}),
	processedMessages: z.number().int().nonnegative(),
	type: z.literal("snapshot"),
});
export type LiveSnapshotEvent = z.infer<typeof liveSnapshotEventSchema>;

export const liveHeartbeatEventSchema = liveEventTimestampSchema.extend({
	type: z.literal("heartbeat"),
});
export type LiveHeartbeatEvent = z.infer<typeof liveHeartbeatEventSchema>;

export const liveMessageReceivedEventSchema = liveEventTimestampSchema.extend({
	channelId: z.string().min(1),
	chatObjectId: z.string().min(1),
	messageId: z.string().min(1),
	sessionId: z.string().min(1),
	type: z.literal("message.received"),
});
export type LiveMessageReceivedEvent = z.infer<typeof liveMessageReceivedEventSchema>;

const liveActivityEventBaseSchema = liveEventTimestampSchema.extend({
	activityId: z.string().min(1),
	conversationId: z.string().min(1),
	envelopeCount: z.number().int().nonnegative(),
});

export const liveActivityOpenedEventSchema = liveActivityEventBaseSchema.extend({
	type: z.literal("activity.opened"),
});
export type LiveActivityOpenedEvent = z.infer<typeof liveActivityOpenedEventSchema>;

export const liveActivityClosedEventSchema = liveActivityEventBaseSchema.extend({
	type: z.literal("activity.closed"),
});
export type LiveActivityClosedEvent = z.infer<typeof liveActivityClosedEventSchema>;

const liveReplyEventBaseSchema = liveEventTimestampSchema.extend({
	channelId: z.string().min(1).nullable(),
	chatObjectId: z.string().min(1),
	entryId: z.string().min(1),
	sessionId: z.string().min(1),
	text: z.string(),
});

export const liveBeforeReplyEventSchema = liveReplyEventBaseSchema.extend({
	type: z.literal("before.reply"),
});
export type LiveBeforeReplyEvent = z.infer<typeof liveBeforeReplyEventSchema>;

export const liveAfterReplyEventSchema = liveReplyEventBaseSchema.extend({
	deliveryStatus: deliveryStatusSchema,
	type: z.literal("after.reply"),
});
export type LiveAfterReplyEvent = z.infer<typeof liveAfterReplyEventSchema>;

export const livePluginStatusEventSchema = liveEventTimestampSchema.extend({
	pluginId: z.string().min(1),
	status: pluginStatusSnapshotSchema.nullable(),
	type: z.literal("plugin.status"),
});
export type LivePluginStatusEvent = z.infer<typeof livePluginStatusEventSchema>;

// ─── Live agent run ─────────────────────────────────────────────────────────

/**
 * One tool call of the current round, as the WebUI shows it while a run is active. Mirrors the
 * durable `ToolSlot` presentation but flattens it to what a viewer needs: identity, status, and
 * the retained output tail.
 */
export const liveToolCallSchema = z.object({
	callId: z.string().min(1),
	/** Retained running output; bounded by the durable output buffer, never the full stream. */
	output: z.string().optional(),
	status: z.enum(["pending", "running", "done"]),
	toolName: z.string().min(1),
});
export type LiveToolCall = z.infer<typeof liveToolCallSchema>;

/**
 * The in-flight run of one conversation: enough for an agent-style activity view. Every field
 * but `sessionId` is optional because a run has phases: it starts before the model streams a
 * first token, may spend time in tool rounds, and may fail without ever answering.
 */
export const liveRunStateSchema = z.object({
	/** Committed partial of the in-flight response; grows as the model streams. */
	partialText: z.string().optional(),
	/** Committed reasoning so far, when the provider reports it. */
	partialThinking: z.string().optional(),
	/** Why the newest run ended without an answer, so a client can show it after the run ends. */
	failure: z.string().optional(),
	/** `true` once the run ended, so the client can stop showing it as in flight. */
	settled: z.boolean(),
	/** Run start, used for the elapsed-time label. */
	startedAtMs: z.number().int().nonnegative(),
	sessionId: z.string().min(1),
	/** Tool calls of the current round, in call order. */
	tools: z.array(liveToolCallSchema),
	/** Assistant turns completed so far, which bounds the run. */
	turns: z.number().int().nonnegative(),
});
export type LiveRunState = z.infer<typeof liveRunStateSchema>;

export const liveRunEventSchema = liveEventTimestampSchema.extend({
	/** Present while a run is active or just failed; absent once the run settled cleanly. */
	run: liveRunStateSchema.nullable(),
	sessionId: z.string().min(1),
	type: z.literal("run.state"),
});
export type LiveRunEvent = z.infer<typeof liveRunEventSchema>;

// ─── Persisted run steps ────────────────────────────────────────────────────

/**
 * One step of a completed agent turn, derived from the durable transcript rather than the
 * ephemeral `pi.live` document. `pi.live` is cleared when a run settles, so a transcript that
 * wants to keep showing "what the agent did" has to read the durable entries instead.
 *
 * Kinds mirror what a coding agent shows: its reasoning, the tools it ran, and the text it
 * produced. `tool` steps are paired with the result that follows them, so a reader sees the
 * call and its outcome as one row.
 */
export const runStepSchema = z.discriminatedUnion("kind", [
	z.object({
		/** Short, already-truncated text of the model's reasoning. */
		kind: z.literal("thinking"),
		text: z.string(),
	}),
	z.object({
		/** Arguments the model passed, as a compact single-line JSON string. */
		argumentsText: z.string(),
		/** The tool's own text output, truncated. Empty when it produced none. */
		output: z.string(),
		/** Whether the tool reported an error. */
		isError: z.boolean(),
		kind: z.literal("tool"),
		/** Tool name as the model called it. */
		toolName: z.string(),
	}),
	z.object({
		kind: z.literal("text"),
		text: z.string(),
	}),
	z.object({
		/** Why the run ended without an answer. */
		detail: z.string(),
		kind: z.literal("failure"),
	}),
]);
export type RunStep = z.infer<typeof runStepSchema>;

export const runStepsSchema = z.object({
	/**
	 * Total time the turn spent in the model and its tools, in seconds. The durable transcript
	 * records per-message durations, not a wall clock for the turn, so this is their sum; it is
	 * absent when the entries carry no timing.
	 */
	durationSeconds: z.number().nonnegative().optional(),
	/** Steps in transcript order. Empty when the turn produced none worth showing. */
	steps: z.array(runStepSchema),
});
export type RunSteps = z.infer<typeof runStepsSchema>;

export const liveEventSchema = z.discriminatedUnion("type", [
	liveSnapshotEventSchema,
	liveHeartbeatEventSchema,
	liveMessageReceivedEventSchema,
	liveActivityOpenedEventSchema,
	liveActivityClosedEventSchema,
	liveBeforeReplyEventSchema,
	liveAfterReplyEventSchema,
	livePluginStatusEventSchema,
	liveRunEventSchema,
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

// ─── Conversation policy and personas ───────────────────────────────────────

export const policyRevisionSchema = z.object({
	conversationId: z.string().nullable(),
	createdAt: z.string(),
	id: z.string(),
	isActive: z.boolean(),
	policy: conversationPolicySchema,
	scope: z.enum(["global", "conversation"]),
	updatedAt: z.string(),
});
export type PolicyRevision = z.infer<typeof policyRevisionSchema>;

export const conversationPolicyViewSchema = z.object({
	conversation: policyRevisionSchema.nullable(),
	global: policyRevisionSchema.nullable(),
	policy: conversationPolicySchema,
	source: z.object({
		conversationId: z.string().nullable(),
		revisionId: z.string().nullable(),
		scope: z.enum(["global", "conversation", "default"]),
		version: z.number().int(),
	}),
});
export type ConversationPolicyView = z.infer<typeof conversationPolicyViewSchema>;

export const policyGetInputSchema = z
	.object({
		chatObjectId: z.string().min(1).optional(),
		conversationId: z.string().min(1).optional(),
	})
	.strict()
	.optional();

export const policyUpdateInputSchema = z
	.object({
		conversationId: z.string().min(1).optional(),
		policy: conversationPolicyPatchSchema,
		scope: z.enum(["global", "conversation"]),
	})
	.strict();

export const policyHistoryInputSchema = z
	.object({
		conversationId: z.string().min(1).optional(),
		scope: z.enum(["global", "conversation"]),
	})
	.strict();

export const personaSummarySchema = z.object({
	createdAt: z.string(),
	id: z.string(),
	isActive: z.boolean(),
	name: z.string(),
	prompt: z.string(),
	selfAliases: z.array(z.string()),
	summary: z.string(),
	version: z.number().int(),
});
export type PersonaSummary = z.infer<typeof personaSummarySchema>;

export const personaUpsertInputSchema = z
	.object({
		id: z.string().min(1).optional(),
		isActive: z.boolean().optional(),
		name: z.string().trim().min(1).max(120),
		prompt: z.string().trim().min(1).max(20_000),
		selfAliases: z.array(z.string().trim().min(1)).max(50).optional(),
		summary: z.string().trim().min(1).max(1_000),
		version: z.number().int().min(1).optional(),
	})
	.strict();

export const personaBindInputSchema = z
	.object({
		chatKind: z.enum(["private", "group"]).optional(),
		chatObjectId: z.string().min(1).optional(),
		conversationId: z.string().min(1).optional(),
		personaId: z.string().min(1),
		scope: z.enum(["global", "chat-kind", "chat-object", "conversation"]),
	})
	.strict();

export const personaBindingSchema = z.object({
	chatKind: z.enum(["private", "group"]).nullable(),
	chatObjectId: z.string().nullable(),
	conversationId: z.string().nullable(),
	createdAt: z.string(),
	id: z.string(),
	isActive: z.boolean(),
	isGlobal: z.boolean(),
	personaId: z.string(),
});
export type PersonaBinding = z.infer<typeof personaBindingSchema>;

// ─── Memories ────────────────────────────────────────────────────────────────

export const memoryStatusSchema = z.enum(["active", "pending", "rejected", "expired", "revoked"]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memoryScopeSchema = z.enum([
	"global",
	"persona",
	"user",
	"conversation",
	"project",
	"ephemeral",
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryKindSchema = z.enum([
	"fact",
	"summary",
	"setting",
	"person",
	"preference",
	"style",
	"glossary",
	"todo",
	"event",
	"relationship",
	"observation",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryRowSchema = z.object({
	confidence: z.number(),
	content: z.string(),
	conversationId: z.string().nullable(),
	createdAt: z.string(),
	createdBy: z.enum(["agent", "user", "migration", "system", "task"]),
	dedupeKey: z.string().nullable(),
	embeddingModel: z.string().nullable(),
	evidenceJson: z.string().nullable(),
	expiresAt: z.string().nullable(),
	extractionModel: z.string().nullable(),
	extractionPromptVersion: z.string().nullable(),
	id: z.string(),
	importance: z.number(),
	kind: z.string(),
	pinned: z.boolean(),
	projectId: z.string().nullable(),
	revokedAt: z.string().nullable(),
	scope: memoryScopeSchema,
	sourceActivityId: z.string().nullable(),
	sourceConversationId: z.string().nullable(),
	sourceEntryId: z.string().nullable(),
	sourceMessageId: z.string().nullable(),
	status: memoryStatusSchema,
	subjectUserId: z.string().nullable(),
	summary: z.string(),
	updatedAt: z.string(),
	visibility: z.string(),
});
export type MemoryRow = z.infer<typeof memoryRowSchema>;

export const memoryListInputSchema = z
	.object({
		conversationId: z.string().min(1).optional(),
		kind: z.string().min(1).optional(),
		limit: z.number().int().positive().max(500).optional(),
		offset: z.number().int().nonnegative().optional(),
		query: z.string().trim().max(500).optional(),
		scope: memoryScopeSchema.optional(),
		status: memoryStatusSchema.optional(),
		subjectUserId: z.string().min(1).optional(),
	})
	.strict()
	.optional();

export const memoryGetInputSchema = z.object({ id: z.string().min(1) }).strict();

export const memoryCreateInputSchema = z
	.object({
		confidence: z.number().min(0).max(1).optional(),
		content: z.string().trim().max(20_000).optional(),
		conversationId: z.string().min(1).optional(),
		createdBy: z.enum(["agent", "user", "migration", "system", "task"]).optional(),
		dedupeKey: z.string().min(1).max(256).optional(),
		evidenceJson: z.string().max(20_000).optional(),
		expiresAt: z.string().min(1).optional(),
		importance: z.number().min(0).max(1).optional(),
		kind: z.string().trim().min(1).max(64),
		pinned: z.boolean().optional(),
		projectId: z.string().min(1).optional(),
		scope: memoryScopeSchema,
		status: memoryStatusSchema.optional(),
		subjectUserId: z.string().min(1).optional(),
		summary: z.string().trim().min(1).max(4_000),
		supersedes: z.array(z.string().min(1)).max(50).optional(),
		visibility: z.string().trim().min(1).max(64).optional(),
	})
	.strict();

export const memoryUpdateInputSchema = z
	.object({
		confidence: z.number().min(0).max(1).optional(),
		content: z.string().trim().max(20_000).optional(),
		dedupeKey: z.string().min(1).max(256).nullish(),
		expiresAt: z.string().min(1).nullish(),
		id: z.string().min(1),
		importance: z.number().min(0).max(1).optional(),
		kind: z.string().trim().min(1).max(64).optional(),
		pinned: z.boolean().optional(),
		status: memoryStatusSchema.optional(),
		summary: z.string().trim().min(1).max(4_000).optional(),
		supersedes: z.array(z.string().min(1)).max(50).optional(),
		visibility: z.string().trim().min(1).max(64).optional(),
	})
	.strict();

export const memoryPinInputSchema = z
	.object({ id: z.string().min(1), pinned: z.boolean() })
	.strict();

export const memoryCompactInputSchema = z
	.object({
		conversationId: z.string().min(1),
		throughMessageId: z.string().min(1).optional(),
	})
	.strict();

export const memorySearchInputSchema = z
	.object({
		conversationId: z.string().min(1).optional(),
		limit: z.number().int().positive().max(100).optional(),
		query: z.string().trim().min(1).max(1_000),
	})
	.strict();

export const memorySearchResultSchema = z.object({
	lexical: z.number(),
	memory: memoryRowSchema,
	recency: z.number(),
	score: z.number(),
	vector: z.number(),
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

export const memoryCompactResultSchema = z.object({
	created: z.boolean(),
	memory: memoryRowSchema.nullable(),
});
export type MemoryCompactResult = z.infer<typeof memoryCompactResultSchema>;

// ─── Contract ────────────────────────────────────────────────────────────────

export const appContract = oc.router({
	admin: {
		chats: {
			createLocal: oc
				.input(chatsCreateLocalInputSchema)
				.output(createLocalChatOutputSchema)
				.meta({ audit: true }),
			list: oc.input(chatsListInputSchema).output(z.array(chatSummarySchema)),
		},
		conversations: {
			list: oc.output(z.array(conversationRowSchema)),
		},
		diagnostics: {
			clearLogs: oc.output(z.object({ cleared: z.number().int() })).meta({ audit: true }),
			logs: oc.input(diagnosticsLogsInputSchema).output(logSnapshotSchema),
			status: oc.output(diagnosticsDataSchema),
		},
		groups: {
			get: oc.input(groupsGetInputSchema).output(groupDetailSchema.nullable()),
			list: oc.output(z.array(groupSummarySchema)),
		},
		memory: {
			approve: oc.input(memoryGetInputSchema).output(memoryRowSchema).meta({ audit: true }),
			compact: oc
				.input(memoryCompactInputSchema)
				.output(memoryCompactResultSchema)
				.meta({ audit: true }),
			create: oc.input(memoryCreateInputSchema).output(memoryRowSchema).meta({ audit: true }),
			expire: oc.output(z.object({ expired: z.number().int() })).meta({ audit: true }),
			get: oc.input(memoryGetInputSchema).output(memoryRowSchema.nullable()),
			list: oc.input(memoryListInputSchema).output(z.array(memoryRowSchema)),
			pin: oc.input(memoryPinInputSchema).output(memoryRowSchema).meta({ audit: true }),
			reject: oc.input(memoryGetInputSchema).output(memoryRowSchema).meta({ audit: true }),
			revoke: oc.input(memoryGetInputSchema).output(memoryRowSchema).meta({ audit: true }),
			search: oc.input(memorySearchInputSchema).output(z.array(memorySearchResultSchema)),
			update: oc.input(memoryUpdateInputSchema).output(memoryRowSchema).meta({ audit: true }),
		},
		modelPolicies: {
			list: oc.output(z.array(modelPolicyRowSchema)),
			set: oc
				.input(modelPoliciesSetInputSchema)
				.output(z.array(modelPolicySchema))
				.meta({ audit: true }),
		},
		personas: {
			bindPersona: oc
				.input(personaBindInputSchema)
				.output(personaBindingSchema)
				.meta({ audit: true }),
			bindings: oc.output(z.array(personaBindingSchema)),
			list: oc.output(z.array(personaSummarySchema)),
			upsert: oc.input(personaUpsertInputSchema).output(personaSummarySchema).meta({ audit: true }),
		},
		policies: {
			get: oc.input(policyGetInputSchema).output(conversationPolicyViewSchema),
			history: oc.input(policyHistoryInputSchema).output(z.array(policyRevisionSchema)),
			update: oc
				.input(policyUpdateInputSchema)
				.output(conversationPolicyViewSchema)
				.meta({ audit: true }),
		},
		plugins: {
			downgrade: oc.input(pluginDowngradeInputSchema).output(pluginRowSchema).meta({ audit: true }),
			install: oc.input(pluginInstallInputSchema).output(pluginRowSchema).meta({ audit: true }),
			list: oc.output(z.array(pluginRowSchema)),
			reload: oc.input(pluginLifecycleInputSchema).output(pluginRowSchema).meta({ audit: true }),
			rpc: oc.input(pluginRpcInputSchema).output(z.unknown()).meta({ audit: true }),
			setEnabled: oc
				.input(pluginEnabledUpdateInputSchema)
				.output(pluginRowSchema)
				.meta({ audit: true }),
			uninstall: oc
				.input(pluginUninstallInputSchema)
				.output(z.object({ pluginId: z.string(), removed: z.boolean() }))
				.meta({ audit: true }),
			upgrade: oc.input(pluginUpgradeInputSchema).output(pluginRowSchema).meta({ audit: true }),
			updateConfig: oc
				.input(pluginConfigUpdateInputSchema)
				.output(
					z.object({
						config: z.record(z.string(), z.unknown()),
						secretsSet: z.array(z.string()),
					}),
				)
				.meta({ audit: true }),
		},
		requests: {
			get: oc.input(requestsGetInputSchema).output(requestRowSchema.nullable()),
			list: oc.input(requestsListInputSchema).output(z.array(requestRowSchema)),
			respond: oc.input(requestsRespondInputSchema).output(requestRowSchema).meta({ audit: true }),
		},
		sessions: {
			contextStats: oc.input(sessionIdInputSchema).output(sessionContextStatsSchema.nullable()),
			create: oc
				.input(sessionsCreateInputSchema)
				.output(createSessionOutputSchema)
				.meta({ audit: true }),
			get: oc.input(sessionIdInputSchema).output(sessionDetailSchema.nullable()),
			messages: oc.input(sessionIdInputSchema).output(z.array(messageSummarySchema)),
			runSteps: oc.input(runStepsInputSchema).output(runStepsSchema),
			send: oc.input(sessionsSendInputSchema).output(messageSummarySchema).meta({ audit: true }),
			setReceiving: oc.input(sessionIdInputSchema).output(okSchema).meta({ audit: true }),
			update: oc.input(sessionsUpdateInputSchema).output(okSchema).meta({ audit: true }),
		},
		settings: {
			get: oc.output(settingsViewSchema),
			update: oc.input(runtimeSettingsPatchSchema).output(settingsViewSchema).meta({ audit: true }),
		},
		users: {
			get: oc.input(usersGetInputSchema).output(userDetailSchema.nullable()),
			list: oc.output(z.array(userSummarySchema)),
		},
	},
	auth: {
		status: oc.output(authStatusOutputSchema),
	},
	health: {
		status: oc.output(healthResponseSchema),
	},
});

export type AppContract = typeof appContract;
