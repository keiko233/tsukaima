import { oc } from "@orpc/contract";
import { z } from "zod";
import { healthResponseSchema, messagePartSchema } from "./base.ts";

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
	id: z.string(),
	kind: z.string(),
	occurredAt: z.string(),
	parts: z.array(messagePartSchema),
	platformMessageId: z.string().nullable(),
	replyToMessageId: z.string().nullable(),
	senderDisplayName: z.string(),
	senderExternalId: z.string().nullable(),
	senderKind: z.enum(["human", "bot", "assistant", "system"]),
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

export const pluginRowSchema = z.object({
	apiVersion: z.string(),
	config: z.record(z.string(), z.unknown()),
	configSchema: z.record(z.string(), z.unknown()).optional(),
	enabled: z.number().int(),
	id: z.string(),
	kind: z.enum(["builtin", "first-party", "third-party"]),
	modelProviders: z.array(z.string()).readonly(),
	name: z.string(),
	permissions: z.array(z.string()).readonly(),
	runMode: z.enum(["host", "worker"]),
	rpcMethods: z.array(z.string()).readonly(),
	secretKeys: z.array(z.string()).readonly(),
	secretsSet: z.array(z.string()).readonly(),
	status: pluginStatusSnapshotSchema.nullable(),
	tools: z.array(z.string()).readonly(),
	ui: z
		.array(
			z.object({
				component: z.string(),
				data: z.record(z.string(), z.unknown()),
				id: z.string(),
				kind: z.enum([
					"panel",
					"conversation-action",
					"message-card",
					"settings-form",
					"approval-card",
				]),
				title: z.string(),
			}),
		)
		.readonly(),
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
	target: z.enum(["channel", "tsukaima"]),
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

export const liveEventSchema = z.discriminatedUnion("type", [
	liveSnapshotEventSchema,
	liveHeartbeatEventSchema,
	liveMessageReceivedEventSchema,
	liveActivityOpenedEventSchema,
	liveActivityClosedEventSchema,
	liveBeforeReplyEventSchema,
	liveAfterReplyEventSchema,
	livePluginStatusEventSchema,
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

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
		modelPolicies: {
			list: oc.output(z.array(modelPolicyRowSchema)),
			set: oc
				.input(modelPoliciesSetInputSchema)
				.output(z.array(modelPolicySchema))
				.meta({ audit: true }),
		},
		plugins: {
			list: oc.output(z.array(pluginRowSchema)),
			rpc: oc.input(pluginRpcInputSchema).output(z.unknown()).meta({ audit: true }),
			setEnabled: oc
				.input(pluginEnabledUpdateInputSchema)
				.output(pluginRowSchema)
				.meta({ audit: true }),
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
			create: oc
				.input(sessionsCreateInputSchema)
				.output(createSessionOutputSchema)
				.meta({ audit: true }),
			get: oc.input(sessionIdInputSchema).output(sessionDetailSchema.nullable()),
			messages: oc.input(sessionIdInputSchema).output(z.array(messageSummarySchema)),
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
