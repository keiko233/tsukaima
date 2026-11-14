import type {
	ConversationPolicy,
	MessageEnvelope,
	MessagePart,
	PluginStatusInput,
	PluginStatusSnapshot,
} from "@elaina/contracts";
import type {
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginRequestApi,
	PluginSettingsApi,
} from "./host.ts";
import type { PluginManifest } from "./manifest.ts";
import type { PluginPermission } from "./permissions.ts";

export interface PluginLogger {
	trace(message: string, details?: unknown): void;
	debug(message: string, details?: unknown): void;
	info(message: string, details?: unknown): void;
	warn(message: string, details?: unknown): void;
	error(message: string, details?: unknown): void;
	child?(target: string, fields?: Record<string, unknown>): PluginLogger;
}

export type SerializedValue = unknown;

export interface PluginStorage {
	conversation: {
		get<T = SerializedValue>(conversationId: string, key: string): Promise<T | undefined>;
		set(conversationId: string, key: string, value: SerializedValue): Promise<void>;
	};
	global: {
		get<T = SerializedValue>(key: string): Promise<T | undefined>;
		set(key: string, value: SerializedValue): Promise<void>;
	};
}

export interface PluginConfig {
	get<T = SerializedValue>(key: string): Promise<T | undefined>;
}

export type PluginMediaKind = "image" | "sticker" | "audio" | "video" | "file";

export type PluginMediaSource = "channel" | "webui" | "migration" | "generated";

export interface PluginMediaStoreInput {
	readonly bytes: Uint8Array;
	readonly durationMs?: number;
	readonly expiresAt?: string;
	readonly height?: number;
	readonly kind: PluginMediaKind;
	readonly metadata?: unknown;
	readonly mimeType?: string;
	readonly source?: PluginMediaSource;
	readonly width?: number;
}

/**
 * Secret-free view of one canonical `media` row. Filesystem paths and remote source URLs are
 * deliberately omitted so plugin code and model-visible text cannot leak them.
 */
export interface PluginMediaRecord {
	readonly createdAt: string;
	readonly durationMs: number | null;
	readonly expiresAt: string | null;
	readonly height: number | null;
	readonly id: string;
	readonly kind: PluginMediaKind;
	readonly mimeType: string;
	readonly sha256: string;
	readonly sizeBytes: number;
	readonly source: PluginMediaSource;
	readonly width: number | null;
}

/** Content-addressed media access. The host enforces `media.read` / `media.write`. */
export interface PluginMediaApi {
	store(input: PluginMediaStoreInput): Promise<PluginMediaRecord>;
	findById(mediaId: string): Promise<PluginMediaRecord | undefined>;
	findBySha(sha256: string): Promise<PluginMediaRecord | undefined>;
	/** Read bytes by canonical media id. Throws when the blob is missing. */
	readBytes(mediaId: string): Promise<Uint8Array>;
}

export interface PluginEvents {
	emit(name: PluginHookName, payload: unknown): Promise<void>;
	on(name: PluginHookName, handler: (payload: unknown) => unknown | Promise<unknown>): () => void;
	/**
	 * Ordered transform fan-out. Every handler may return a replacement payload; the next
	 * handler receives the previous result. Used by `reply.transform`.
	 */
	transform?(name: PluginHookName, payload: unknown): Promise<unknown>;
}

export interface PluginToolRegistry {
	invoke(
		name: string,
		input: Record<string, unknown>,
		context?: ToolInvocationContext,
	): Promise<PluginToolInvocationResult>;
	register(tool: PluginTool): void;
	list(): readonly PluginTool[];
}

export interface PluginUiRegistry {
	register(definition: PluginUiDefinition): void;
	list(): readonly PluginUiDefinition[];
	/**
	 * Publish a health/status snapshot for the plugin page. The host validates and stamps it.
	 * A null value clears the current status.
	 */
	setStatus(status: PluginStatusInput | null): void;
}

export type PluginModelInputModality = "text" | "image" | "audio" | "video" | "file";

export type PluginModelReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PluginModelReasoning {
	readonly levels: readonly PluginModelReasoningLevel[];
	readonly default?: PluginModelReasoningLevel;
}

export interface PluginModelDescriptor {
	readonly id: string;
	readonly name?: string;
	readonly capabilities: readonly string[];
	readonly input?: readonly PluginModelInputModality[];
	readonly reasoning?: PluginModelReasoning;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
}

export interface PluginModelInfo extends PluginModelDescriptor {
	readonly providerId: string;
	/** Present when the model registry is hosted by Elaina. */
	readonly pluginId?: string;
}

export interface PluginModelQuery {
	readonly providerId?: string;
	readonly capability?: string;
	readonly input?: PluginModelInputModality;
}

export interface PluginModelPort {
	readonly providerId: string;
	readonly modelId: string;
	/** Opaque to the SDK: the host consumes the underlying pi-ai `Models` collection. */
	readonly models: unknown;
}

export type PluginModelMessageContentPart =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface PluginModelCompleteMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string | readonly PluginModelMessageContentPart[];
}

export interface PluginModelCompleteRequest {
	readonly providerId?: string;
	readonly modelId?: string;
	readonly messages: readonly PluginModelCompleteMessage[];
	readonly capability?: string;
	readonly input?: PluginModelInputModality;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignal;
}

export interface PluginModelCompleteResult {
	readonly modelId: string;
	readonly providerId: string;
	readonly text: string;
}

export interface PluginEmbeddingRequest {
	readonly modelId?: string;
	readonly texts: readonly string[];
}

export interface PluginEmbeddingResult {
	readonly modelId: string;
	readonly providerId: string;
	readonly vectors: readonly (readonly number[])[];
}

export interface PluginAudioTranscribeRequest {
	readonly modelId?: string;
	readonly audio: Uint8Array | ArrayBuffer | string;
	readonly mimeType?: string;
}

export interface PluginAudioTranscribeResult {
	readonly modelId: string;
	readonly providerId: string;
	readonly text: string;
	readonly language?: string;
}

export interface PluginEmbeddingPort {
	embed(request: PluginEmbeddingRequest): Promise<PluginEmbeddingResult> | PluginEmbeddingResult;
}

export interface PluginAudioTranscribePort {
	transcribeAudio(
		request: PluginAudioTranscribeRequest,
	): Promise<PluginAudioTranscribeResult> | PluginAudioTranscribeResult;
}

export interface PluginModelProvider {
	readonly id: string;
	/** False when the plugin has no usable credentials yet; the host then falls back. */
	isConfigured?(): boolean | Promise<boolean>;
	/** Enabled models currently offered by this provider. Disabled models must be omitted. */
	listModels?(): readonly PluginModelDescriptor[] | Promise<readonly PluginModelDescriptor[]>;
	createPort(options?: {
		readonly onMessage?: (message: unknown) => void;
	}): PluginModelPort | Promise<PluginModelPort>;
	/** Optional text/multimodal completion handler. */
	complete?(
		request: PluginModelCompleteRequest,
	): Promise<PluginModelCompleteResult> | PluginModelCompleteResult;
	/** Optional embedding port (`embedding` capability). */
	embed?(request: PluginEmbeddingRequest): Promise<PluginEmbeddingResult> | PluginEmbeddingResult;
	/** Object-shaped embedding port alias. */
	embedding?: PluginEmbeddingPort;
	/** Optional speech-to-text port (`audio.transcribe` capability). */
	transcribeAudio?(
		request: PluginAudioTranscribeRequest,
	): Promise<PluginAudioTranscribeResult> | PluginAudioTranscribeResult;
	/** Object-shaped audio-transcribe port alias. */
	audioTranscribe?: PluginAudioTranscribePort;
}

export interface PluginModelRegistry {
	registerProvider(provider: PluginModelProvider): () => void;
	getProvider(id: string): PluginModelProvider | undefined;
	listProviders(): readonly PluginModelProvider[];
	/** Enabled models from every registered provider, optionally filtered by capability or input. */
	listModels(query?: PluginModelQuery): Promise<readonly PluginModelInfo[]>;
	/** Find one enabled model by id, preferring the requested provider when supplied. */
	findModel(modelId: string, providerId?: string): Promise<PluginModelInfo | undefined>;
	/** Run text or multimodal completion through the selected provider and model. */
	complete(request: PluginModelCompleteRequest): Promise<PluginModelCompleteResult>;
	/** Run embedding through the selected provider/model capability port. */
	embed(request: PluginEmbeddingRequest): Promise<PluginEmbeddingResult>;
	/** Object-shaped alias for `embed`. */
	embedding?(request: PluginEmbeddingRequest): Promise<PluginEmbeddingResult>;
	/** Run speech-to-text through the selected provider/model capability port. */
	transcribeAudio(request: PluginAudioTranscribeRequest): Promise<PluginAudioTranscribeResult>;
	/** Object-shaped alias for `transcribeAudio`. */
	audioTranscribe?(request: PluginAudioTranscribeRequest): Promise<PluginAudioTranscribeResult>;
}

export type PluginRpcHandler = (input: unknown) => Promise<unknown> | unknown;

export interface PluginRpcRegistry {
	register(method: string, handler: PluginRpcHandler): () => void;
	list(): readonly { readonly method: string }[];
}

export interface PluginChannelApi {
	send(conversationId: string, parts: readonly MessagePart[]): Promise<void>;
}

export type PluginTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface PluginTaskPermissions {
	/** Granted plugin permissions inherited by the task, never escalated by the caller. */
	readonly permissions: readonly PluginPermission[];
}

export interface PluginTask {
	readonly id: string;
	readonly pluginId: string;
	readonly conversationId?: string;
	readonly chatObjectId?: string;
	readonly kind: string;
	readonly payload: unknown;
	readonly dedupeKey?: string;
	readonly status: PluginTaskStatus;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly nextRunAtMs: number;
	readonly intervalMs?: number;
	readonly logs: readonly string[];
	readonly outcome?: unknown;
	readonly permissions: PluginTaskPermissions;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface PluginTaskCreateInput {
	readonly conversationId?: string;
	readonly chatObjectId?: string;
	readonly kind: string;
	readonly payload?: unknown;
	readonly dedupeKey?: string;
	readonly maxAttempts?: number;
	readonly nextRunAtMs?: number;
	readonly intervalMs?: number;
	/** Optional narrowing of the owning plugin's permissions. Escalation is rejected. */
	readonly permissions?: readonly PluginPermission[];
}

export interface PluginTaskListQuery {
	readonly status?: PluginTaskStatus | readonly PluginTaskStatus[];
	readonly kind?: string;
	readonly conversationId?: string;
	readonly limit?: number;
}

export interface PluginTaskWatchEvent {
	readonly type: "created" | "updated" | "completed" | "cancelled";
	readonly task: PluginTask;
}

export interface PluginTaskExecutionResult {
	readonly outcome?: unknown;
	readonly logs?: readonly string[];
	/** A repeatable task may ask to stop after this run. */
	readonly stop?: boolean;
}

export type PluginTaskHandler = (
	task: PluginTask,
) => Promise<PluginTaskExecutionResult | void> | PluginTaskExecutionResult | void;

export interface PluginTaskUpdateInput {
	readonly payload?: unknown;
	readonly nextRunAtMs?: number;
	readonly intervalMs?: number | null;
	readonly maxAttempts?: number;
}

export interface PluginTaskCancelQuery {
	readonly conversationId?: string;
	readonly dedupeKey?: string;
	readonly kind?: string;
	readonly status?: PluginTaskStatus | readonly PluginTaskStatus[];
}

export interface PluginTasksApi {
	create(input: PluginTaskCreateInput): Promise<PluginTask>;
	get(taskId: string): Promise<PluginTask | undefined>;
	list(query?: PluginTaskListQuery): Promise<readonly PluginTask[]>;
	cancel(taskId: string): Promise<PluginTask | undefined>;
	watch(taskId: string, listener: (event: PluginTaskWatchEvent) => void): () => void;
	/** Register the durable handler for one task kind owned by this plugin. */
	registerHandler(kind: string, handler: PluginTaskHandler): () => void;
	/** Update scheduler metadata without resetting claim/attempt state. */
	update(taskId: string, input: PluginTaskUpdateInput): Promise<PluginTask | undefined>;
	/** Cancel every task matching the query (conversation/dedupe scoped). */
	cancelMany(query: PluginTaskCancelQuery): Promise<readonly PluginTask[]>;
}

/**
 * Secret-free conversation metadata. Conversation history itself stays behind
 * `recentMessages()` and is never included in logs.
 */
export interface PluginConversationSummary {
	readonly id: string;
	readonly durableConversationId: string;
	readonly chatObjectId: string | null;
	readonly channelId: string | null;
	readonly kind: "private" | "group" | "webui" | "task" | "plugin";
	readonly title: string;
	readonly updatedAt: string;
	readonly status: string;
	/** Chat-object mute flag, so proactive candidates can exclude muted chats. */
	readonly muted?: boolean;
}

/** Bounded message metadata plus a short text preview for compact operational context. */
export interface PluginConversationMessage {
	readonly id: string;
	readonly direction: "inbound" | "outbound" | "system";
	readonly kind: string;
	readonly senderDisplayName: string | null;
	readonly textPreview: string;
	readonly occurredAt: string;
	readonly deliveryStatus: string | null;
}

export interface PluginBackgroundTurnInput {
	readonly conversationId: string;
	readonly kind: "scheduled" | "proactive";
	readonly prompt: string;
	/** Compact operational context appended to the prompt (never logged by the host). */
	readonly context?: string;
	/** Optional plugin task reference for audit correlation. */
	readonly taskId?: string;
}

export type PluginBackgroundDeliveryStatus =
	| "sent"
	| "failed"
	| "uncertain"
	| "skipped"
	| "suppressed";

export interface PluginBackgroundTurnResult {
	readonly delivered: boolean;
	readonly deliveryStatus: PluginBackgroundDeliveryStatus;
	/** Output marker that was consumed and never delivered (`skip`, `lurk`, `schedule-later`). */
	readonly marker?: "skip" | "lurk" | "schedule-later";
	readonly skippedReason?: string;
	/** Cleaned assistant text after marker removal. Never logged by the host. */
	readonly text?: string;
	/** Delay requested by `ELAINA_SCHEDULE_LATER` when present. */
	readonly scheduleLaterMs?: number;
}

/** Permission-checked conversation surface exposed to plugins. */
export interface PluginConversationsApi {
	list(): Promise<readonly PluginConversationSummary[]>;
	get(conversationId: string): Promise<PluginConversationSummary | undefined>;
	getPolicy(conversationId: string): Promise<ConversationPolicy>;
	recentMessages(
		conversationId: string,
		limit?: number,
	): Promise<readonly PluginConversationMessage[]>;
	submitBackgroundTurn(input: PluginBackgroundTurnInput): Promise<PluginBackgroundTurnResult>;
}

export interface PluginMigrationDescriptor {
	readonly version: string;
	readonly sql: string;
	readonly rollbackSql?: string;
}

export interface PluginMigrationRecord {
	readonly checksum: string;
	readonly durationMs: number;
	readonly pluginId: string;
	readonly rollbackSql: string | null;
	readonly status: PluginMigrationStatus;
	readonly version: string;
}

export type PluginMigrationStatus = "applied" | "rolled_back" | "failed";

export interface PluginMigrationsApi {
	list(): Promise<readonly PluginMigrationRecord[]>;
	rollback(options?: { readonly dryRun?: boolean }): Promise<readonly string[]>;
}

/**
 * A namespaced SQL handle for `host`-mode plugins. Every object must be prefixed with
 * `plugin_<sanitizedId>_`; the host rejects cross-plugin/core access.
 */
export interface PluginDatabaseApi {
	exec(sql: string): Promise<void>;
	query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
	readonly prefix: string;
}

export interface ToolPolicy {
	readonly visibility: "model" | "ui" | "admin" | "hidden";
	readonly deferred?: boolean;
	readonly timeoutMs: number;
	readonly maxConcurrent: number;
	readonly requiredConversationCapabilities?: readonly string[];
	readonly conversationAllowlist?: boolean;
	readonly destructive?: boolean;
	readonly maxPayloadBytes?: number;
	/** Optional task-kind gate (`scheduled`, `proactive`, `coding`, ...). */
	readonly allowedTaskKinds?: readonly string[];
}

export interface ToolInvocationContext {
	readonly conversationId?: string;
	readonly userId?: string;
	readonly isAdmin?: boolean;
	readonly role?: string;
	readonly taskKind?: string;
	readonly allowedTools?: readonly string[];
	readonly conversationCapabilities?: readonly string[];
	/** Cancellation signal propagated to cancellable worker/tool executions. */
	readonly signal?: AbortSignal;
}

export interface ToolResult {
	content: readonly { readonly text: string; readonly type: "text" }[];
}

export interface PluginTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	requiredPermissions: readonly PluginPermission[];
	/** Host-enforced execution policy. Defaults are model-visible, 30s, 4 concurrent. */
	policy?: Partial<ToolPolicy>;
	execute(
		input: Record<string, unknown>,
		context: ToolInvocationContext,
	): Promise<ToolResult> | ToolResult;
}

export type PluginToolInvocationResult =
	| { ok: true; result: ToolResult }
	| { ok: false; reason: "permission_denied"; permission: PluginPermission }
	| {
			ok: false;
			reason:
				| "busy"
				| "payload_too_large"
				| "task_kind_denied"
				| "timeout"
				| "unauthorized"
				| "unknown_tool";
			message?: string;
	  };

/** The subset of the durable tool API a plugin tool adapter needs. */
export interface PluginToolExecutionApi {
	readonly conversationId: number;
}

/**
 * Structural form of a pi-durable `ToolRegistration`. Kept independent of pi-durable so
 * the plugin SDK can expose tools without depending on the durable runtime.
 */
export interface PluginToolRegistration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		args: unknown,
		api: PluginToolExecutionApi,
		context: unknown,
	): Promise<{
		readonly output: { readonly type: "text"; readonly text: string }[];
		readonly isError?: boolean;
	}>;
}

export interface PluginToolsExtension {
	readonly name: string;
	readonly tools: readonly PluginToolRegistration[];
}

export type PluginUiSlot =
	| "panel"
	| "conversation-action"
	| "message-card"
	| "settings-form"
	| "approval-card";

export interface PluginUiDefinition {
	kind: PluginUiSlot;
	id: string;
	title: string;
	component: string;
	data: Record<string, unknown>;
	/** Declarative component registry version. */
	version?: string;
	requiredPermissions?: readonly PluginPermission[];
	i18nKeys?: readonly string[];
	slot?: PluginUiSlot;
	/** Data contract for the declarative component. */
	schema?: Record<string, unknown>;
}

export type PluginStatusListener = (status: PluginStatusSnapshot | null) => void;

export type PluginHookName =
	| "message.received"
	| "activity.opened"
	| "activity.closed"
	| "agent.activity"
	| "before.agent"
	| "before.reply"
	| "reply.transform"
	| "after.reply"
	| "task.created"
	| "task.completed"
	| "channel.connected"
	| "channel.disconnected";

export interface PluginHook {
	name: PluginHookName;
	handler: (payload: unknown) => unknown | Promise<unknown>;
}

export interface PluginContext {
	pluginId: string;
	manifest: PluginManifest;
	config: PluginConfig;
	logger: PluginLogger;
	storage: PluginStorage;
	conversation: {
		read(): Promise<readonly MessageEnvelope[]>;
	};
	events: PluginEvents;
	/** Canonical media store, present when the plugin declares a media permission. */
	media?: PluginMediaApi;
	tools: PluginToolRegistry;
	ui: PluginUiRegistry;
	/** Model providers contributed by this plugin. */
	models: PluginModelRegistry;
	/** WebUI-callable procedures contributed by this plugin. */
	rpc: PluginRpcRegistry;
	channel?: PluginChannelApi;
	/** Present when the plugin declares channel permissions. */
	channels?: PluginChannelRegistry;
	/** Per-plugin configuration with host-resolved environment fallbacks. */
	settings?: PluginSettingsApi;
	/** Durable request inbox for friend/group requests. */
	requests?: PluginRequestApi;
	/** Host audit trail. */
	audit?: PluginAuditApi;
	/** Durable host scheduler tasks. Present when the plugin has `tasks.*` permission. */
	tasks?: PluginTasksApi;
	/** Permission-checked conversation metadata and durable background turns. */
	conversations?: PluginConversationsApi;
	/** Host-owned plugin migration records and rollback for `host`-mode plugins. */
	migrations?: PluginMigrationsApi;
	/** Namespaced database handle for `host`-mode plugins that own tables. */
	database?: PluginDatabaseApi;
	/** Host bindings for built-in plugins; absent for third-party plugins. */
	dependencies?: PluginDependencyBag;
}
