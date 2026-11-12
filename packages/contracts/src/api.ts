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

export const pluginRowSchema = z.object({
	apiVersion: z.string(),
	enabled: z.number().int(),
	id: z.string(),
	kind: z.enum(["builtin", "first-party", "third-party"]),
	name: z.string(),
	runMode: z.enum(["host", "worker"]),
	version: z.string(),
});
export type PluginRow = z.infer<typeof pluginRowSchema>;

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
			eventCount: z.number().int(),
			id: z.string(),
			kind: z.string(),
			lastErrorClass: z.string().nullable(),
			reconnectAttempts: z.number().int(),
			restartRequired: z.boolean(),
			state: channelStateSchema,
		}),
	),
	lastError: z.string().optional(),
	logLevel: logLevelSchema,
	onebotConfigured: z.boolean(),
	onebotConnected: z.boolean(),
	onebotLastErrorClass: z.string().nullable(),
	onebotReconnectAttempts: z.number().int(),
	onebotRestartRequired: z.boolean(),
	onebotState: channelStateSchema,
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
	onebotAccessTokenSet: z.boolean(),
	onebotWsUrl: z.string().optional(),
	openAiApiKeySet: z.boolean(),
	openAiBaseUrl: z.string().optional(),
	openAiModelId: z.string().optional(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

export const remoteModelSchema = z.object({
	id: z.string(),
	ownedBy: z.string().optional(),
});

export const remoteModelListSchema = z.object({
	baseUrl: z.string(),
	models: z.array(remoteModelSchema),
});
export type RemoteModelList = z.infer<typeof remoteModelListSchema>;

export const settingsModelsInputSchema = z.object({
	apiKey: z.string().min(1).optional(),
	baseUrl: z.string().url().optional(),
});

export const runtimeSettingsPatchSchema = z
	.object({
		logLevel: logLevelSchema.optional(),
		onebotAccessToken: z.union([z.string().min(1), z.null()]).optional(),
		onebotWsUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
		openAiApiKey: z.union([z.string().min(1), z.null()]).optional(),
		openAiBaseUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
		openAiModelId: z.union([z.string().min(1), z.literal(""), z.null()]).optional(),
	})
	.refine(
		(input) =>
			input.logLevel !== undefined ||
			input.onebotAccessToken !== undefined ||
			input.onebotWsUrl !== undefined ||
			input.openAiApiKey !== undefined ||
			input.openAiBaseUrl !== undefined ||
			input.openAiModelId !== undefined,
		{ message: "At least one setting must be provided" },
	);
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

export const authLoginInputSchema = z.object({
	password: z.string().min(1).max(1_024),
	username: z.string().trim().min(1).max(120),
});
export type AuthLoginInput = z.infer<typeof authLoginInputSchema>;

export const authLoginOutputSchema = z.object({ username: z.string() });
export type AuthLoginOutput = z.infer<typeof authLoginOutputSchema>;

export const authStatusOutputSchema = z.object({
	authenticated: z.boolean(),
	configured: z.boolean(),
	username: z.string().optional(),
});
export type AuthStatus = z.infer<typeof authStatusOutputSchema>;

// ─── Contract ────────────────────────────────────────────────────────────────

export const appContract = oc.router({
	admin: {
		chats: {
			createLocal: oc.input(chatsCreateLocalInputSchema).output(createLocalChatOutputSchema),
			list: oc.input(chatsListInputSchema).output(z.array(chatSummarySchema)),
		},
		conversations: {
			list: oc.output(z.array(conversationRowSchema)),
		},
		diagnostics: {
			clearLogs: oc.output(z.object({ cleared: z.number().int() })),
			logs: oc.input(diagnosticsLogsInputSchema).output(logSnapshotSchema),
			status: oc.output(diagnosticsDataSchema),
		},
		groups: {
			get: oc.input(groupsGetInputSchema).output(groupDetailSchema.nullable()),
			list: oc.output(z.array(groupSummarySchema)),
		},
		modelPolicies: {
			list: oc.output(z.array(modelPolicyRowSchema)),
			set: oc.input(modelPoliciesSetInputSchema).output(z.array(modelPolicySchema)),
		},
		plugins: {
			list: oc.output(z.array(pluginRowSchema)),
		},
		requests: {
			get: oc.input(requestsGetInputSchema).output(requestRowSchema.nullable()),
			list: oc.input(requestsListInputSchema).output(z.array(requestRowSchema)),
			respond: oc.input(requestsRespondInputSchema).output(requestRowSchema),
		},
		sessions: {
			create: oc.input(sessionsCreateInputSchema).output(createSessionOutputSchema),
			get: oc.input(sessionIdInputSchema).output(sessionDetailSchema.nullable()),
			messages: oc.input(sessionIdInputSchema).output(z.array(messageSummarySchema)),
			send: oc.input(sessionsSendInputSchema).output(messageSummarySchema),
			setReceiving: oc.input(sessionIdInputSchema).output(okSchema),
			update: oc.input(sessionsUpdateInputSchema).output(okSchema),
		},
		settings: {
			get: oc.output(settingsViewSchema),
			models: oc.input(settingsModelsInputSchema).output(remoteModelListSchema),
			update: oc.input(runtimeSettingsPatchSchema).output(settingsViewSchema),
		},
		users: {
			get: oc.input(usersGetInputSchema).output(userDetailSchema.nullable()),
			list: oc.output(z.array(userSummarySchema)),
		},
	},
	auth: {
		login: oc.input(authLoginInputSchema).output(authLoginOutputSchema),
		logout: oc.output(okSchema),
		status: oc.output(authStatusOutputSchema),
	},
	health: {
		status: oc.output(healthResponseSchema),
	},
});

export type AppContract = typeof appContract;
