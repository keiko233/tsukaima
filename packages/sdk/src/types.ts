import type {
	ConversationPolicy,
	MessageEnvelope,
	MessagePart,
	PluginStatusInput,
	PluginStatusSnapshot,
} from "@tsukaima/contracts";
import type {
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginOutboundApi,
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

export interface PluginCacheSetOptions {
	/** Keep the value for this many milliseconds. Omit to keep it until overwritten. */
	readonly ttlMs?: number;
}

/**
 * Fast, TTL-aware shared state for plugins, backed by the host KV cache.
 *
 * This is intentionally not plugin storage: values may expire, are namespaced per plugin,
 * and are meant for short-lived coordination (search snapshots, cooldowns, stream cursors,
 * cache invalidation). Durable plugin data still belongs in `storage`.
 */
export interface PluginCacheApi {
	get<T = SerializedValue>(key: string): Promise<T | undefined>;
	set(key: string, value: SerializedValue, options?: PluginCacheSetOptions): Promise<void>;
	delete(key: string): Promise<boolean>;
	has(key: string): Promise<boolean>;
	/** Read or compute on a miss. The host serializes concurrent misses for the same key. */
	getOrSet<T = SerializedValue>(
		key: string,
		factory: () => Promise<T> | T,
		options?: PluginCacheSetOptions,
	): Promise<T>;
	/** Publish to this plugin's cache channel namespace. `channel` is not global. */
	publish(channel: string, payload: SerializedValue): Promise<void>;
	/** Host-mode only; worker plugins receive no subscribe function. */
	subscribe?(channel: string, handler: (payload: unknown) => void): () => void;
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
	/** Remove a tool registered by this plugin, e.g. after its upstream server disconnects. */
	unregister(name: string): void;
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

export type PluginModelOutputModality = "text" | "image" | "audio" | "video";

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
	readonly output?: readonly PluginModelOutputModality[];
	readonly reasoning?: PluginModelReasoning;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
}

export interface PluginModelInfo extends PluginModelDescriptor {
	readonly providerId: string;
	/** Present when the model registry is hosted by Tsukaima. */
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
	readonly reasoning?: PluginModelReasoningLevel;
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

export interface PluginDecisionChoiceRequest {
	readonly providerId?: string;
	readonly modelId?: string;
	readonly context: string;
	readonly instructions: string;
	readonly options: Readonly<Record<string, string>>;
	readonly maxTokens?: number;
	readonly signal?: AbortSignal;
}

export interface PluginDecisionChoiceResult {
	readonly providerId: string;
	readonly modelId: string;
	readonly choice: string;
	readonly confidence?: number;
	readonly reason?: string;
}

export interface PluginDecisionChoicePort {
	decideChoice(
		request: PluginDecisionChoiceRequest,
	): Promise<PluginDecisionChoiceResult> | PluginDecisionChoiceResult;
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
	/** Optional native decision-choice port (`decision.choice` capability). */
	decideChoice?(
		request: PluginDecisionChoiceRequest,
	): Promise<PluginDecisionChoiceResult> | PluginDecisionChoiceResult;
	/** Object-shaped decision-choice port alias. */
	decisionChoice?: PluginDecisionChoicePort;
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
	/** Run a constrained decision choice through the selected provider/model capability port. */
	decideChoice(request: PluginDecisionChoiceRequest): Promise<PluginDecisionChoiceResult>;
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
	/** Optional reschedule instant for a deferred task (e.g. quiet-hours deferral). */
	readonly nextRunAtMs?: number;
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
	readonly platformConversationId?: string | null;
	readonly kind: "private" | "group" | "webui" | "workspace" | "task" | "plugin";
	readonly title: string;
	readonly updatedAt: string;
	readonly status: string;
	/** Chat-object mute flag, so proactive candidates can exclude muted chats. */
	readonly muted?: boolean;
}

/** Bounded message metadata plus a short text preview for compact operational context. */
export interface PluginConversationMessage {
	readonly id: string;
	readonly platformMessageId?: string | null;
	readonly direction: "inbound" | "outbound" | "system";
	readonly kind: string;
	readonly senderDisplayName: string | null;
	readonly textPreview: string;
	readonly parts?: readonly MessagePart[];
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
	/** Scheduler kind to materialize if the answer defers itself with `schedule-later`. */
	readonly followUpKind?: string;
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
	/** Durable activity id of the turn, also available when a retry reuses an existing answer. */
	readonly activityId?: string;
	/**
	 * True when the turn's text was already delivered by a channel tool (or was already shown
	 * as the exact answer text). No new bubble was sent, but the reply obligation was satisfied,
	 * so proactive quota and unanswered-streak accounting must still count it.
	 */
	readonly deliveredViaTool?: boolean;
	/** Durable assistant entry id of the turn. */
	readonly entryId?: string;
	/** Output marker that was consumed and never delivered (`skip`, `lurk`, `schedule-later`). */
	readonly marker?: "skip" | "lurk" | "schedule-later";
	readonly skippedReason?: string;
	/** Cleaned assistant text after marker removal. Never logged by the host. */
	readonly text?: string;
	/** Delay requested by `TSUKAIMA_SCHEDULE_LATER` when present. */
	readonly scheduleLaterMs?: number;
	/** Durable submission that produced this turn, used to correlate a deferred follow-up. */
	readonly submissionRequestId?: string;
	/** False when a schedule-later marker could not be persisted; recovery remains pending. */
	readonly followUpRecorded?: boolean;
	/** True when the turn still owes a durable follow-up handoff and must be retried. */
	readonly followUpPending?: boolean;
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

/**
 * Durable host-owned handoff for a plugin background turn that asked to continue later.
 *
 * The host records the request before it settles the reply expectation, so a crash between the
 * assistant answer and the plugin's own task insert cannot lose the follow-up. The owning plugin
 * materializes its task from this row and then marks the row completed; the host never writes
 * plugin task tables directly.
 */
export interface PluginFollowUpIntent {
	readonly conversationId: string;
	readonly createdAtMs: number;
	readonly delayMs: number;
	readonly followUpKind: string;
	readonly id: string;
	readonly pluginId: string;
	readonly scheduledForMs: number;
	readonly sourceTaskId: string | null;
	readonly status: "pending" | "completed";
	readonly submissionRequestId: string;
	readonly updatedAtMs: number;
}

export interface PluginFollowUpListQuery {
	readonly conversationId?: string;
	readonly limit?: number;
	readonly status?: PluginFollowUpIntent["status"];
	readonly submissionRequestId?: string;
}

/** Permission-checked access to the host's durable follow-up outbox. */
export interface PluginFollowUpsApi {
	list(query?: PluginFollowUpListQuery): Promise<readonly PluginFollowUpIntent[]>;
	/** Mark a materialized follow-up completed. Idempotent; only this plugin's rows qualify. */
	complete(followUpId: string): Promise<boolean>;
	/**
	 * Observe newly recorded intents for this plugin. This is only a wake-up hint; the durable
	 * list/startup/tick reconciliation remains authoritative.
	 */
	onChanged(handler: () => void): () => void;
}

/**
 * Narrow, permission-checked access to host-owned user schedules. Plugins own policy and
 * decision state; explicit reminders and follow-ups use the same durable definition/occurrence
 * model as the WebUI. The host resolves target sessions and never exposes another plugin's rows.
 */
export interface PluginScheduleSummary {
	readonly actionKind: "agent_turn" | "workspace_turn" | "notify";
	readonly id: string;
	readonly nextRunAt: string | null;
	readonly ownerKind: "user" | "agent" | "plugin" | "system";
	readonly status: "active" | "paused" | "completed" | "cancelled" | "failed";
	readonly targetSessionId: string;
	readonly title: string;
}

export interface PluginSchedulesApi {
	create(input: {
		readonly actionKind: "agent_turn" | "notify";
		readonly catchUp?: "skip" | "latest" | "all";
		readonly dedupeKey?: string;
		readonly graceMs?: number;
		readonly maxAttempts?: number;
		readonly maxRuns?: number;
		readonly prompt: string;
		readonly recurrence:
			| { readonly at: string; readonly kind: "once" }
			| {
					readonly anchorAt: string;
					readonly everyMs: number;
					readonly kind: "interval";
					readonly until?: string;
			  }
			| {
					readonly daysOfWeek?: number[];
					readonly kind: "calendar";
					readonly startDate: string;
					readonly time: string;
					readonly until?: string;
			  };
		readonly respectQuietHours?: boolean;
		readonly targetSessionId: string;
		readonly timeZone: string;
		readonly title: string;
	}): Promise<PluginScheduleSummary>;
	list(query?: {
		readonly limit?: number;
		readonly targetSessionId?: string;
	}): Promise<readonly PluginScheduleSummary[]>;
	cancel(scheduleId: string): Promise<boolean>;
	onChanged(handler: (schedule: PluginScheduleSummary) => void): () => void;
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
 * SQL handle for a plugin-owned SQLite database. Each plugin gets its own file under the data
 * directory, so statements cannot reach core tables or another plugin's data. `prefix` remains
 * available for plugins that keep the legacy `plugin_<sanitizedId>_` naming convention.
 */
export interface PluginDatabaseApi {
	exec(sql: string): Promise<void>;
	query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
	readonly prefix: string;
}

export interface ToolPolicy {
	readonly visibility: "model" | "ui" | "admin" | "hidden";
	/** Offer the tool only after `tool_search` loads it. Defaults to `true`. */
	readonly lazy?: boolean;
	/** Conversation surface this tool belongs to. Defaults to `"both"`. */
	readonly surface?: ToolSurface;
	/** Legacy alias for `lazy`. */
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

export type ToolSurface = "chat" | "coding" | "both";

export interface ToolInvocationContext {
	readonly conversationId?: string;
	readonly platformConversationId?: string;
	readonly chatKind?: string;
	readonly channelId?: string;
	readonly senderPlatformId?: string;
	readonly userId?: string;
	readonly isAdmin?: boolean;
	readonly role?: string;
	readonly taskKind?: string;
	readonly allowedTools?: readonly string[];
	readonly conversationCapabilities?: readonly string[];
	/** Cancellation signal propagated to cancellable worker/tool executions. */
	readonly signal?: AbortSignal;
}

export type ToolContentPart =
	| { readonly text: string; readonly type: "text" }
	| {
			readonly data: string;
			readonly mimeType: string;
			readonly text?: string;
			readonly type: "image";
	  };

export interface ToolResult {
	content: readonly { readonly text: string; readonly type: "text" }[];
	/** Optional multimodal image blocks returned to vision-capable models (e.g. `viewImage`). */
	images?: readonly { readonly data: string; readonly mimeType: string }[];
}

export interface PluginTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	requiredPermissions: readonly PluginPermission[];
	/** Offer the tool only after `tool_search` loads it. Defaults to `true`. */
	readonly lazy?: boolean;
	/** Conversation surface this tool belongs to. Defaults to `"both"`. */
	readonly surface?: ToolSurface;
	/**
	 * Preferred model-facing shorthand. The canonical `name` still authorizes, audits, and
	 * dispatches the call. When this name would collide with another model tool, the allocator
	 * falls back to the namespaced name instead of silently choosing a loser.
	 */
	readonly shortName?: string;
	/** Explicit model-facing name. When specified, the allocator honors it in Round 1. */
	readonly modelName?: string;
	/**
	 * Additional model-facing names that still resolve to this tool. Use them for names an
	 * earlier release exposed or for a stable shorthand that must survive catalog changes.
	 */
	readonly aliases?: readonly string[];
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
	/** Canonical author-facing name used by routing, policy, and audit. */
	readonly canonicalName?: string;
	/** Earlier model-facing names that still resolve to this registration. */
	readonly aliases?: readonly string[];
	/** Set for tools the model must load through `tool_search` first. */
	readonly deferred?: true;
	readonly surface?: ToolSurface;
	execute(
		args: unknown,
		api: PluginToolExecutionApi,
		context: unknown,
	): Promise<{
		readonly output: ToolContentPart[];
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
	| "channel.disconnected"
	| "schedule.changed";

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
	/** TTL-aware shared cache, present when the plugin declares `cache.*` permissions. */
	cache?: PluginCacheApi;
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
	/** Host-owned outbound sends that also land in durable history. */
	outbound?: PluginOutboundApi;
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
	/** Durable follow-up handoff from background turns. Present with `followups.*` permission. */
	followUps?: PluginFollowUpsApi;
	/** Host-owned explicit schedules. Present with `schedules.*` permission. */
	schedules?: PluginSchedulesApi;
	/** Host-owned plugin migration records and rollback for `host`-mode plugins. */
	migrations?: PluginMigrationsApi;
	/** Namespaced database handle for `host`-mode plugins that own tables. */
	database?: PluginDatabaseApi;
	/** Host bindings for built-in plugins; absent for third-party plugins. */
	dependencies?: PluginDependencyBag;
}
