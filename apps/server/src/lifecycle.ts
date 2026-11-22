import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	ConversationExecutionLock,
	ModelPolicyRouter,
	ModelUsageLedger,
	PiDurableConversationHost,
	TOOL_SEARCH_TOOL_NAME,
	composeInterjectPrompt,
	createFakeModel,
	type ActivityWindowEvent,
	type AdmittedTurn,
	type ConversationGatePort,
	type DurableExtension,
	type FastLaneInterjectInput,
	type FastLaneInterjectResult,
	type LiveRunSnapshot,
	type ModelPort,
	type ModelPolicy,
} from "@tsukaima/core";
import {
	createHostSandbox,
	DomainCodingStore,
	reconcileRestartDeployment,
	WorktreeManager,
	type DeploymentApplicationVerification,
	type DeploymentIdentity,
	type DeploymentProposal,
	type DeploymentRecord,
} from "@tsukaima/coding";
import {
	auditLog,
	chatObjects,
	conversations,
	media,
	workspaceSessions,
	type TsukaimaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage, type SqliteStorage } from "@tsukaima/durable";
import { KeyvCache } from "@tsukaima/cache";
import { eq } from "drizzle-orm";
import {
	createPluginToolsExtension,
	MODEL_CAPABILITIES,
	type AuditEntry,
	type TsukaimaPlugin,
} from "@tsukaima/sdk";
import {
	ONEBOT_AUDIO_TRANSCRIBE_BINDING,
	ONEBOT_CHANNEL_KIND,
	ONEBOT_MENTION_NAME_BINDING,
	ONEBOT_VIDEO_FRAME_EXTRACTOR_BINDING,
} from "@tsukaima-plugin/onebot-napcat";
import {
	MigrationRegistry,
	PluginDatabaseStore,
	loadPluginMigrations,
	migrateLegacyPluginTables,
	wrapPluginSqlConnection,
} from "@tsukaima/plugin-registry";
import { runBackupDrill as executeBackupDrill, type BackupDrillReport } from "@tsukaima/migration";
import {
	CONVERSATION_GATE_BINDING,
	SOCIAL_PROFILE_BINDING,
	messagePartsText,
	skillsTurnContextResultSchema,
	type ChannelNotice,
	type ChannelRequest,
	type MessageEnvelope,
	type MessagePart,
	type ProactiveBubbleGateBridge,
	type RestartMode,
	type RestartStatus,
} from "@tsukaima/contracts";
import { loadConfig, type TsukaimaConfig } from "./config.ts";
import {
	createDailyFileLogSink,
	createLogger,
	LogBuffer,
	previewText,
	type DailyFileLogSink,
	type Logger,
} from "./logging.ts";
import {
	DEFAULT_LOG_LEVEL,
	readRuntimeSettings,
	type RuntimeSettings,
} from "./runtime-settings.ts";
import { builtinPlugins } from "./plugins/builtin.ts";
import {
	BackupDrillScheduler,
	type BackupDrillRunResult,
} from "./services/backup-drill-scheduler.ts";
import { ChannelRegistry } from "./services/channel-registry.ts";
import { ConversationGateService } from "./services/conversation-gate.ts";
import { NativeDecisionModels } from "./services/decision-models.ts";
import { ConversationPacingTracker } from "./services/conversation-pacing.ts";
import { ConversationPolicyService } from "./services/conversation-policy.ts";
import { ConversationRouter } from "./services/conversation-router.ts";
import { DrizzleContextProvider } from "./services/context-provider.ts";
import { ChatSnapshotService } from "./services/chat-snapshot.ts";
import {
	MEMORY_SERVICE_BINDING,
	MemoryService,
	type MemoryEmbeddingOutput,
} from "./services/memory-service.ts";
import {
	CHAT_HISTORY_SERVICE_BINDING,
	ChatHistoryService,
} from "./services/chat-history-service.ts";
import { SocialProfileService } from "./services/social-profile.ts";
import { InboundMediaResolver } from "./services/inbound-media.ts";
import { resolveImCallerContext } from "./services/im-caller-context.ts";
import { computeOmittedSessionTools } from "./services/session-tool-policy.ts";
import { isDirectSendToolName } from "./services/tool-names.ts";
import { authorizeWorkspaceToolCall } from "./services/workspace-authorization.ts";
import { MediaService } from "./services/media-service.ts";
import { HookBus } from "./services/hook-bus.ts";
import { createMentionIdentityStore } from "./services/mention-identity-store.ts";
import { PluginConversationService } from "./services/plugin-conversation-service.ts";
import { PluginHost } from "./services/plugin-host.ts";
import { PluginSettingsStore } from "./services/plugin-settings.ts";
import { PluginStatusStore } from "./services/plugin-status.ts";
import { PluginStorageStore } from "./services/plugin-storage.ts";
import { PluginTaskService } from "./services/plugin-task-service.ts";
import { ReplyDispatcher } from "./services/reply-dispatcher.ts";
import { FollowUpIntentStore } from "./services/follow-up-intents.ts";
import { readGitIdentity } from "./services/git-identity.ts";
import { GitHubCliService, githubHostFromApiUrl } from "./services/github-cli-service.ts";
import { GitHubService } from "./services/github-service.ts";
import { ReplyExpectationStore } from "./services/reply-expectations.ts";
import { SidechatService, resolveSidechatTarget } from "./services/sidechat.ts";
import { LiveRunCache } from "./services/live-run-cache.ts";
import { DependencyInstaller } from "./services/dependency-installer.ts";
import { PromptHookService } from "./services/prompt-hooks.ts";
import { PROMPT_TOOL_NAMES, createPromptTools } from "./services/prompt-tools.ts";
import { PromptService } from "./services/prompts.ts";
import {
	RestartCoordinator,
	type RestartIntent,
	type RestartSettlementOutcome,
} from "./services/restart-coordinator.ts";
import { OutboundService } from "./services/outbound.ts";
import { RequestService } from "./services/request-service.ts";
import { RepositoryService } from "./services/repository-service.ts";
import { ScheduleExecutionService } from "./services/schedule-executor.ts";
import { ScheduleService } from "./services/schedule-service.ts";
import { SCHEDULE_TOOL_NAMES, createScheduleToolsExtension } from "./services/schedule-tools.ts";
import { SessionMessagingService } from "./services/session-messaging.ts";
import { UpgradeService } from "./services/upgrade-service.ts";
import { createVideoFrameExtractor } from "./services/video-frames.ts";
import {
	CODING_AGENT_TOOL_NAMES,
	createCodingAgentToolsExtension,
} from "./services/coding-agent-tools.ts";
import { WorkspaceReferenceService } from "./services/workspace-references.ts";
import { WorkspaceSqlService } from "./services/workspace-sql.ts";
import { WorkspaceTodoService } from "./services/workspace-todos.ts";
import {
	IM_WORKSPACE_DELEGATION_TOOL_NAMES,
	WORKSPACE_TOOL_NAMES,
	createWorkspaceToolsExtension,
} from "./services/workspace-tools.ts";
import { WorkspaceService } from "./services/workspace.ts";
import {
	createPiModelRuntime,
	isWorkspaceWorktreeCheckout,
	WORKSPACE_NATIVE_TASK_CONSTRAINTS,
	WorkspaceNativeRunner,
	type WorkspaceRunFinishedEvent,
} from "./services/workspace-native-runner.ts";

/**
 * Minimum spacing between logged failures for one channel stage and conversation. Detached
 * inbound handlers can fail on every event, so the log needs a floor that still surfaces a
 * breakage immediately.
 */
const INBOUND_FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Model names owned by built-in host extensions. Plugin shorthands must not shadow these, and
 * the plugin host and plugin-tools extension must allocate from the same reserved set.
 */
function reservedModelToolNames(): readonly string[] {
	return [
		TOOL_SEARCH_TOOL_NAME,
		...PROMPT_TOOL_NAMES,
		...SCHEDULE_TOOL_NAMES,
		...CODING_AGENT_TOOL_NAMES,
		...WORKSPACE_TOOL_NAMES,
	];
}

export interface LifecycleOptions {
	/** Optional scheduled backup/restore drill override; disabled unless configured. */
	readonly backupDrill?:
		| {
				readonly intervalMs?: number;
				readonly root?: string;
				readonly run?: () => Promise<BackupDrillRunResult>;
		  }
		| undefined;
	/** Process environment, used for plugin `configEnv` fallbacks. */
	readonly env?: Record<string, string | undefined>;
	/** Optional dependency installer override (used in tests). */
	readonly dependencyInstaller?: DependencyInstaller | undefined;
	readonly logger?: Logger;
	/** Test or embedding override for the model catalog and provider. */
	readonly model?: ModelPort | undefined;
	/** Optional pre-model conversation gate override (tests or custom classifier endpoints). */
	readonly conversationGate?: ConversationGatePort | undefined;
	/** Opaque host bindings consumed by built-in plugins in tests or embedders. */
	readonly pluginBindings?: ReadonlyMap<string, unknown>;
	/** Overrides the built-in plugin set (tests and future plugin sources). */
	readonly plugins?: readonly TsukaimaPlugin[];
	/** Reply chunking, quote behavior, delivery reconciliation, and answer recovery timing. */
	readonly reply?: {
		readonly pendingGraceMs?: number;
		readonly reconcileIntervalMs?: number;
		readonly reconcileLookbackMs?: number;
		readonly replyAsQuote?: boolean;
		readonly splitMaxChars?: number;
	};
}

export interface LifecycleState {
	readonly state: "starting" | "degraded" | "ready" | "maintenance" | "failed";
	readonly stage: string;
	readonly startedAtMs: number;
	readonly reason?: string;
}

export class TsukaimaLifecycle {
	readonly config: TsukaimaConfig;
	readonly startedAtMs = Date.now();
	readonly backupDrills: BackupDrillScheduler;
	/** Redis-like KV layer: durable TTL values, bounded streams, and a process-local bus. */
	readonly cache: KeyvCache;
	readonly channels: ChannelRegistry;
	readonly contextProvider: DrizzleContextProvider;
	readonly conversationPacing: ConversationPacingTracker;
	readonly conversationPolicy: ConversationPolicyService;
	readonly conversationRouter: ConversationRouter;
	readonly hooks: HookBus;
	readonly pluginHost: PluginHost;
	readonly pluginMigrations: MigrationRegistry;
	readonly pluginDatabases: PluginDatabaseStore;
	readonly pluginSettings: PluginSettingsStore;
	readonly pluginStatuses: PluginStatusStore;
	readonly pluginStorage: PluginStorageStore;
	readonly pluginTasks: PluginTaskService;
	readonly pluginConversations: PluginConversationService;
	/** One lock shared by inbound turns, outbound pacing, tasks, and background turns. */
	readonly executionLock: ConversationExecutionLock;
	readonly memory: MemoryService;
	readonly chatHistory: ChatHistoryService;
	readonly socialProfiles: SocialProfileService;
	/** Admin chat snapshot checkpoint/restore; created after the conversation host exists. */
	private chatSnapshotService: ChatSnapshotService | undefined;
	private readonly plugins: readonly TsukaimaPlugin[];
	readonly media: MediaService;
	private readonly inboundMedia: InboundMediaResolver;
	readonly promptHooks: PromptHookService;
	readonly prompts: PromptService;
	readonly replyExpectations: ReplyExpectationStore;
	readonly followUpIntents: FollowUpIntentStore;
	readonly github: GitHubService;
	readonly githubAuth: GitHubCliService;
	readonly replyDispatcher: ReplyDispatcher;
	readonly outbound: OutboundService;
	readonly requestService: RequestService;
	readonly repository: RepositoryService;
	readonly schedules: ScheduleService;
	readonly restartCoordinator: RestartCoordinator;
	readonly dependencyInstaller: DependencyInstaller;
	readonly sessionMessaging: SessionMessagingService;
	readonly upgrades: UpgradeService;
	readonly workspace: WorkspaceService;
	readonly workspaceTodos: WorkspaceTodoService;
	readonly workspaceNative: WorkspaceNativeRunner;
	private readonly workspaceWorktrees = new Map<string, WorktreeManager>();
	private currentState: LifecycleState["state"] = "starting";
	private currentStage = "initialize";
	private failureReason: string | undefined;
	private readonly stopListeners = new Set<() => void>();
	private readonly customLoggerProvided: boolean;
	private dailyFileSink: DailyFileLogSink | undefined;
	private removeFileSink: (() => void) | undefined;

	conversationHost: PiDurableConversationHost | undefined;
	domainDatabase: TsukaimaDatabase | undefined;
	durableStorage: SqliteStorage | undefined;
	lastProcessingError: Error | undefined;
	logLevel: TsukaimaConfig["logLevel"];
	readonly liveRuns: LiveRunCache;
	readonly logs: LogBuffer;
	readonly logger: Logger;
	readonly modelUsageLedger = new ModelUsageLedger();
	modelRouter: ModelPolicyRouter | undefined;
	private memoryModel: ModelPort | undefined;
	private sidechatService: SidechatService | undefined;
	private conversationGateService: ConversationGatePort | undefined;
	private readonly conversationGateOverride: ConversationGatePort | undefined;
	private readonly decisionModels: NativeDecisionModels;
	private readonly codingStore = new DomainCodingStore(() => this.domainDatabase);
	/**
	 * Sender bound to each active turn, keyed by conversation and then by submission request id.
	 * Tools read the head at execution time so an ambient message from a different group member
	 * cannot upgrade the caller's admin status mid-turn. The exact request id is the only cleanup
	 * key: one submission can settle without disturbing another still running in the conversation.
	 */
	private readonly turnSenders = new Map<string, Map<string, string | null>>();
	processedMessageCount = 0;
	providerRestartRequired = false;
	routingPolicies: readonly ModelPolicy[] = [];
	private readonly runtimeLog: Logger;
	private readonly backupDrillRoot: string | undefined;
	private readonly modelOverride: ModelPort | undefined;
	/**
	 * Last time each channel pipeline stage logged a failure. Channel adapters report errors from
	 * a detached promise, so an unthrottled log would let a permanently broken event flood the
	 * buffer. Keyed by stage + conversation key.
	 */
	private readonly inboundFailureLoggedAt = new Map<string, number>();
	/** Last resolved conversation kind per durable conversation id, for transient DB read resilience. */
	private readonly sessionKindByDurableId = new Map<string, string>();
	private activeProviderId: string | undefined;
	/** Provider/model catalog signature; a change invalidates per-conversation model refs. */
	private modelPortSignature: string | undefined;
	/** Last chat/workspace model defaults pushed to durable conversations. */
	private agentDefaultsSignature: string | undefined;
	private beforeReadyCallback: (() => Promise<void>) | undefined;
	private workspaceToolsExtension: DurableExtension | undefined;
	private scheduleToolsExtension: DurableExtension | undefined;
	private codingAgentToolsExtension: DurableExtension | undefined;

	constructor(config: TsukaimaConfig, options?: LifecycleOptions) {
		this.config = config;
		this.decisionModels = new NativeDecisionModels(options?.env ?? process.env);
		this.logLevel = config.logLevel;
		this.customLoggerProvided = options?.logger !== undefined;
		this.logger =
			options?.logger ??
			createLogger({
				capacity: config.logBufferCapacity,
				level: config.logLevel,
				target: "tsukaima::server",
			});
		this.logs = this.logger.buffer;
		this.plugins = options?.plugins ?? builtinPlugins;
		this.runtimeLog = this.logger.child("tsukaima::server::lifecycle");
		this.cache = new KeyvCache({
			onError: (error) => {
				this.runtimeLog.warn("cache operation failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
			path: join(config.dataDir, "cache.sqlite"),
		});
		this.liveRuns = new LiveRunCache(this.cache);
		this.backupDrillRoot = options?.backupDrill?.root ?? config.backupDrillRoot;
		this.modelOverride = options?.model;
		this.conversationGateOverride = options?.conversationGate;
		this.backupDrills = new BackupDrillScheduler({
			intervalMs: options?.backupDrill?.intervalMs ?? config.backupDrillIntervalMs ?? 0,
			logger: this.runtimeLog,
			run:
				options?.backupDrill?.run ??
				(async () => {
					const report = await this.runBackupDrill();
					return {
						...(report.error === undefined ? {} : { error: report.error }),
						ok: report.ok,
						reportPath: report.reportPath,
						runId: report.runId,
					};
				}),
		});
		this.executionLock = new ConversationExecutionLock();
		this.hooks = new HookBus(this.logger);
		this.prompts = new PromptService(
			() => this.domainDatabase,
			(entry) => this.writeAudit(entry),
		);
		this.promptHooks = new PromptHookService({
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
		});
		this.dependencyInstaller =
			options?.dependencyInstaller ??
			new DependencyInstaller({
				logger: this.runtimeLog,
				repositoryRoot: config.repositoryRoot,
			});
		this.restartCoordinator = new RestartCoordinator({
			audit: (entry) => this.writeAudit(entry),
			database: () => this.domainDatabase,
			hooks: this.promptHooks,
			logger: this.runtimeLog,
			onSettled: (intent, outcome) => this.reconcileRestartSettlement(intent, outcome),
			prepareUpdate: async (_intent) => {
				await this.dependencyInstaller.install();
			},
		});
		this.channels = new ChannelRegistry({
			onEnvelope: (channelId, envelope) => {
				void this.handleChannelEnvelope(channelId, envelope).catch((error: unknown) =>
					this.reportInboundFailure("envelope", channelId, envelope, error),
				);
			},
			onNotice: (channelId, notice) => {
				void this.handleChannelNotice(channelId, notice).catch((error: unknown) =>
					this.reportInboundFailure("notice", channelId, notice, error),
				);
			},
			onRequest: (channelId, request) => {
				void this.handleChannelRequest(channelId, request).catch((error: unknown) =>
					this.reportInboundFailure("request", channelId, request, error),
				);
			},
		});
		this.media = new MediaService({
			allowedPrivateHosts: config.mediaFetchAllowedHosts,
			blobsDir: join(config.dataDir, "blobs"),
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
		});
		this.inboundMedia = new InboundMediaResolver({
			logger: this.runtimeLog,
			media: this.media,
		});
		this.conversationPacing = new ConversationPacingTracker();
		this.conversationPolicy = new ConversationPolicyService({
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			logger: this.runtimeLog,
			onPolicySynced: async (durableConversationId, policy) => {
				await this.applySessionToolPolicy(durableConversationId, policy);
			},
		});
		this.chatHistory = new ChatHistoryService({
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
			policyService: this.conversationPolicy,
		});
		this.conversationRouter = new ConversationRouter({
			applyModelToolPolicy: async (durableConversationId, policy) =>
				this.applySessionToolPolicy(durableConversationId, policy),
			audit: (entry) => this.writeAudit(entry),
			conversationGate: () => this.conversationGateService,
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			ingestMedia: (part, channelId) => this.ingestInboundMedia(part, channelId),
			logger: this.runtimeLog,
			onInboundTrigger: (conversationId) =>
				this.replyDispatcher.cancelPendingOutput(conversationId),
			pacing: this.conversationPacing,
			policy: this.conversationPolicy,
			promptContext: async (sessionId) => this.promptHooks.renderContext(sessionId),
		});
		this.outbound = new OutboundService({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			hooks: this.hooks,
			logger: this.runtimeLog,
			onDirectSend: (durableConversationId, text) =>
				this.replyDispatcher.noteDirectSend(durableConversationId, text),
			onToolSend: (sent) => {
				// Stickers/media/files are recorded so they never look like chat text: only a text
				// send suppresses a later preamble or a repeated final reply.
				this.replyDispatcher.noteDirectSendParts(sent.durableConversationId, sent.parts);
			},
			runOnOutboundLane: (durableConversationId, task) =>
				this.replyDispatcher.runOnOutboundLane(durableConversationId, task),
			router: () => this.conversationRouter,
		});
		this.contextProvider = new DrizzleContextProvider({
			renderSystem: (id) => this.prompts.renderSystem(id),
			renderPrompt: (key) => this.prompts.render(key),
			// Chat compaction runs on the conversation's own model. The deterministic fake model has
			// no plugin provider; returning `undefined` keeps pi-durable's default summarizer.
			completeText: async (request) => {
				const target = request.model ?? this.activeModelTarget();
				if (target === undefined || target.providerId === "fake") return undefined;
				const result = await this.pluginHost.completeModel(
					{
						maxTokens: request.maxTokens,
						messages: [
							{ content: request.system, role: "system" },
							{ content: request.prompt, role: "user" },
						],
						modelId: target.modelId,
						providerId: target.providerId,
						...(request.signal === undefined ? {} : { signal: request.signal }),
					},
					MODEL_CAPABILITIES.basicChat,
				);
				return result.text;
			},
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
			policyService: this.conversationPolicy,
			stickerHints: async () => {
				if (!(await this.pluginSettings.isEnabled("sticker-meme"))) return undefined;
				const plugin = this.pluginHost.context("sticker-meme");
				if (plugin === undefined) return undefined;
				const result = await this.pluginHost.invokeRpc("sticker-meme.hints", { limit: 3 });
				if (typeof result !== "object" || result === null) {
					return undefined;
				}
				const record = result as { readonly captions?: unknown; readonly packs?: unknown };
				const captions = Array.isArray(record.captions)
					? record.captions.filter((entry): entry is string => typeof entry === "string")
					: undefined;
				const packs = Array.isArray(record.packs)
					? record.packs.flatMap((entry) => {
							if (typeof entry !== "object" || entry === null) return [];
							const item = entry as { readonly itemCount?: unknown; readonly name?: unknown };
							if (typeof item.name !== "string" || typeof item.itemCount !== "number") return [];
							return [{ itemCount: item.itemCount, name: item.name }];
						})
					: undefined;
				return {
					...(captions === undefined ? {} : { captions }),
					...(packs === undefined ? {} : { packs }),
				};
			},
			skillCatalog: async (surface) => {
				if (!(await this.pluginSettings.isEnabled("skills"))) return undefined;
				const plugin = this.pluginHost.context("skills");
				if (plugin === undefined) return undefined;
				const raw = await this.pluginHost.invokeRpc("skills.turnContext", { surface });
				const parsed = skillsTurnContextResultSchema.safeParse(raw);
				return parsed.success ? parsed.data.text : undefined;
			},
		});
		this.requestService = new RequestService({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
		});
		this.pluginSettings = new PluginSettingsStore({
			database: () => this.domainDatabase,
			env: options?.env ?? {},
		});
		this.pluginStatuses = new PluginStatusStore();
		this.pluginStorage = new PluginStorageStore(() => this.domainDatabase);
		this.pluginDatabases = new PluginDatabaseStore({
			directory: join(this.config.dataDir, "plugins"),
		});
		this.pluginMigrations = new MigrationRegistry({
			databases: this.pluginDatabases,
		});
		this.pluginTasks = new PluginTaskService({
			database: () => this.domainDatabase,
			hooks: this.hooks,
			lock: this.executionLock,
			logger: this.runtimeLog,
		});
		this.memory = new MemoryService({
			audit: (entry) => this.writeAudit(entry),
			complete: (prompt, modelId, signal) => this.completeMemoryPrompt(prompt, modelId, signal),
			database: () => this.domainDatabase,
			defaultModelId: async () =>
				this.domainDatabase === undefined
					? undefined
					: (await readRuntimeSettings(this.domainDatabase)).memoryModelId,
			embed: (texts) => this.embedMemoryTexts(texts),
			embeddingModelId: async () => {
				const [model] = await this.pluginHost.listModels({ capability: "embedding" });
				return model?.id;
			},
			extractionPrompt: () => this.prompts.render("memory-extraction"),
			llmEnabled: () => this.memoryModel !== undefined && this.memoryModel.providerId !== "fake",
			logger: this.runtimeLog,
			policyService: this.conversationPolicy,
			tasks: this.pluginTasks,
		});
		this.memory.registerTaskHandlers(this.pluginTasks);
		this.socialProfiles = new SocialProfileService({
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
			policyService: this.conversationPolicy,
		});
		this.chatSnapshotService = new ChatSnapshotService(this);
		this.replyExpectations = new ReplyExpectationStore({
			database: () => this.domainDatabase,
		});
		this.followUpIntents = new FollowUpIntentStore({
			database: () => this.domainDatabase,
		});
		this.hooks.on("message.received", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const record = payload as {
				envelope?: { parts?: readonly MessagePart[] };
				sessionId?: unknown;
			};
			if (typeof record.sessionId !== "string") return;
			const text =
				Array.isArray(record.envelope?.parts) && record.envelope.parts.length > 0
					? messagePartsText(record.envelope.parts)
					: undefined;
			void this.socialProfiles
				.recordInbound({
					conversationId: record.sessionId,
					...(text === undefined ? {} : { text }),
					timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
				})
				.catch((error: unknown) => {
					this.runtimeLog.debug("social profile inbound update skipped", {
						error: error instanceof Error ? error.message : String(error),
						sessionId: record.sessionId,
					});
				});
		});
		// Background memory work is one idle-debounced consolidation job per conversation. Both
		// lifecycle events only note activity (no model call); the debounce coalesces them.
		this.hooks.on("after.reply", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const record = payload as { deliveryStatus?: unknown; sessionId?: unknown };
			if (typeof record.sessionId !== "string") return;
			void this.memory.noteConversationActivity({ conversationId: record.sessionId });
			void this.socialProfiles
				.recordOutbound({
					conversationId: record.sessionId,
					delivered: record.deliveryStatus === "sent",
					proactive: false,
				})
				.catch(() => undefined);
		});
		this.replyDispatcher = new ReplyDispatcher({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			expectations: this.replyExpectations,
			followUps: this.followUpIntents,
			hooks: this.hooks,
			resolveAnswer: async (durableConversationId, submissionRequestId) =>
				(await this.conversationHost?.resolveSubmissionAnswer(
					durableConversationId,
					submissionRequestId,
				)) ?? { status: "missing" },
			lock: this.executionLock,
			logger: this.runtimeLog,
			pacing: this.conversationPacing,
			policy: this.conversationPolicy,
			...(options?.reply?.pendingGraceMs === undefined
				? {}
				: { pendingGraceMs: options.reply.pendingGraceMs }),
			...(options?.reply?.reconcileIntervalMs === undefined
				? {}
				: { reconcileIntervalMs: options.reply.reconcileIntervalMs }),
			...(options?.reply?.reconcileLookbackMs === undefined
				? {}
				: { reconcileLookbackMs: options.reply.reconcileLookbackMs }),
			...(options?.reply?.replyAsQuote === undefined
				? {}
				: { replyAsQuote: options.reply.replyAsQuote }),
			...(options?.reply?.splitMaxChars === undefined
				? {}
				: { splitMaxChars: options.reply.splitMaxChars }),
		});
		this.workspaceTodos = new WorkspaceTodoService({ database: () => this.domainDatabase });
		const workspaceReferences = new WorkspaceReferenceService({
			database: () => this.domainDatabase,
		});
		const workspaceSql = new WorkspaceSqlService({ database: () => this.domainDatabase });
		const resolveSessionId = async (durableConversationId: string): Promise<string | undefined> => {
			const database = this.domainDatabase;
			if (database === undefined) return undefined;
			const [row] = await database
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.durableConversationId, durableConversationId))
				.limit(1);
			return row?.id;
		};
		const workspaceWorktreeRoot = join(config.dataDir, "worktrees");
		const workspaceSandbox = {
			repositoryPath: config.repositoryRoot,
			worktreeRoot: workspaceWorktreeRoot,
		};
		const workspaceSandboxProvider = createHostSandbox(workspaceSandbox);
		this.workspaceNative = new WorkspaceNativeRunner({
			agentDirRoot: join(config.dataDir, "workspace-agents"),
			audit: (entry) => this.writeAudit(entry),
			database: () => this.domainDatabase,
			emitAfterReply: (payload) => this.hooks.emitDetached("after.reply", payload),
			finalizeLiveRun: async (sessionId, entryId) => {
				await this.liveRuns.finalizeAnswer(sessionId, entryId);
			},
			ensureWorktree: async (taskId) => await this.ensureWorkspaceWorktree(taskId),
			executor: async () => await workspaceSandboxProvider(),
			gitIdentity: () => readGitIdentity(this.domainDatabase),
			logger: this.runtimeLog,
			onLiveRun: (sessionId, durableConversationId, snapshot) => {
				this.hooks.emitDetached("agent.activity", {
					...snapshot,
					conversationId: durableConversationId,
				});
				void this.liveRuns.record(sessionId, snapshot).catch((error: unknown) => {
					this.runtimeLog.warn("failed to store workspace live run state", {
						error: error instanceof Error ? error.message : String(error),
						sessionId,
					});
				});
			},
			onRunFinished: async (event) => {
				if (event.aborted || this.currentState !== "ready") return;
				await this.notifyWorkspaceParent(event);
			},
			authorizeCoding: async (sessionId) =>
				(await this.conversationPolicy.effectivePolicy(sessionId)).capabilities.includes("coding"),
			references: workspaceReferences,
			resolveAgentSettings: async (sessionId) => {
				const settings = await this.conversationPolicy.agentSettingsForConversation(sessionId);
				if (settings.model !== null) return settings;
				const model = this.conversationHost?.defaultModelRef;
				return model === undefined ? settings : { ...settings, model };
			},
			resolveModel: async (ref) => {
				const port = await this.workspaceModelPort(ref.providerId);
				return await createPiModelRuntime(port, ref);
			},
			repositoryRoot: config.repositoryRoot,
			sessionDirRoot: join(config.dataDir, "workspace-sessions"),
			taskPrompt: async (input) =>
				[
					"You are the dedicated Tsukaima workspace coding agent.",
					`Repository root: ${input.repositoryRoot}`,
					`Coding task id: ${input.taskId}`,
					`Base revision: ${input.baseRef}`,
					`Task goal: ${input.goal ?? "(the current user request)"}`,
					await this.prompts.render("workspace-task"),
				].join("\n"),
			todos: this.workspaceTodos,
			worktreeRoot: workspaceWorktreeRoot,
		});
		this.sessionMessaging = new SessionMessagingService({
			abortWorkspace: async (sessionId) => await this.workspaceNative.abort(sessionId),
			applyToolPolicy: async (sessionId, durableConversationId) => {
				const policy = await this.conversationPolicy.effectivePolicy(sessionId);
				await this.applySessionToolPolicy(durableConversationId, policy);
			},
			audit: (entry) => this.writeAudit(entry),
			cancelPendingOutput: (durableConversationId) =>
				this.replyDispatcher.cancelPendingOutput(durableConversationId),
			database: () => this.domainDatabase,
			dispatchWorkspace: async (input) => await this.workspaceNative.dispatch(input),
			hooks: this.promptHooks,
			host: () => this.conversationHost,
			logger: this.runtimeLog,
			prepareTurn: async (sessionId, input) => {
				const database = this.domainDatabase;
				if (database === undefined) return undefined;
				const [row] = await database
					.select({ taskId: workspaceSessions.taskId })
					.from(workspaceSessions)
					.where(eq(workspaceSessions.id, sessionId))
					.limit(1);
				if (row === undefined) return undefined;
				const { context } = await this.workspace.prepareNativeTurn(sessionId, {
					goal: input.text,
					...(input.references === undefined ? {} : { references: input.references }),
				});
				return context;
			},
			notifyMessageReceived: ({ chatObjectId, messageId: inboundMessageId, sessionId }) => {
				this.hooks.emitDetached("message.received", {
					channelId: "webui",
					chatObjectId,
					envelope: { id: inboundMessageId },
					sessionId,
				});
			},
			policy: {
				ensureHostPolicy: (sessionId, durableConversationId) =>
					this.conversationPolicy.ensureHostPolicy(sessionId, durableConversationId),
			},
		});
		const scheduleExecution = new ScheduleExecutionService({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
			messaging: this.sessionMessaging,
			policy: this.conversationPolicy,
		});
		this.schedules = new ScheduleService({
			audit: (entry) => this.writeAudit(entry),
			database: () => this.domainDatabase,
			executor: scheduleExecution,
			logger: this.runtimeLog,
			onChanged: (change) => {
				this.hooks.emitDetached("schedule.changed", {
					actionKind: change.actionKind,
					nextRunAt: change.nextRunAt,
					scheduleId: change.id,
					sessionId: change.targetSessionId,
					status: change.status,
				});
			},
		});
		this.scheduleToolsExtension = createScheduleToolsExtension({
			audit: (entry) => this.writeAudit(entry),
			logger: this.runtimeLog,
			messaging: this.sessionMessaging,
			resolveSessionId,
			schedules: this.schedules,
		});
		this.workspace = new WorkspaceService({
			applyToolPolicy: async (sessionId, durableConversationId) => {
				const policy = await this.conversationPolicy.effectivePolicy(sessionId);
				await this.applySessionToolPolicy(durableConversationId, policy);
			},
			audit: (entry) => this.writeAudit(entry),
			createTask: async (input) => await this.createWorkspaceTask(input),
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			isRunning: (sessionId) => this.workspaceNative.isRunning(sessionId),
			logger: this.runtimeLog,
			messaging: this.sessionMessaging,
			policy: this.conversationPolicy,
			references: workspaceReferences,
			repositoryRoot: config.repositoryRoot,
			todos: this.workspaceTodos,
		});
		this.repository = new RepositoryService({
			allowPush: config.allowPush,
			logger: this.runtimeLog,
			repositoryPath: config.repositoryRoot,
		});
		this.githubAuth = new GitHubCliService({
			dataDir: config.dataDir,
			host: githubHostFromApiUrl(config.githubApiUrl),
			logger: this.runtimeLog,
		});
		this.github = new GitHubService({
			apiBaseUrl: config.githubApiUrl,
			auth: this.githubAuth,
			logger: this.runtimeLog,
			repositoryPath: config.repositoryRoot,
		});
		this.upgrades = new UpgradeService({
			audit: (entry) => this.writeAudit(entry),
			coding: this.codingStore,
			database: () => this.domainDatabase,
			defaultRemote: config.upgradeRemote,
			dependencyInstaller: this.dependencyInstaller,
			ensureWorktree: async (taskId) => await this.ensureWorkspaceWorktree(taskId),
			logger: this.runtimeLog,
			repositoryRoot: config.repositoryRoot,
			restart: {
				cancel: (reason) => this.cancelRestart(reason),
				schedule: (input) => this.scheduleRestart(input),
			},
			token: () => this.github.gitCredential(),
			workspace: this.workspace,
		});
		const imDelegationTools = new Set<string>(IM_WORKSPACE_DELEGATION_TOOL_NAMES);
		this.workspaceToolsExtension = createWorkspaceToolsExtension({
			audit: (entry) => this.writeAudit(entry),
			authorizeCaller: async (durableConversationId, toolName) => {
				const caller = await resolveImCallerContext({
					conversationId: durableConversationId,
					database: this.domainDatabase,
					overrides: { turnBoundSender: this.boundTurnSender(durableConversationId) },
					settings: this.pluginSettings,
				});
				const isImChat = caller.chatKind === "private" || caller.chatKind === "group";
				let policy: { readonly workspaceDelegationEnabled: boolean } | undefined;
				if (isImChat && caller.domainConversationId !== undefined) {
					try {
						policy = await this.conversationPolicy.effectivePolicy(caller.domainConversationId);
					} catch (error) {
						this.runtimeLog.warn("workspace tool policy read failed; denying caller", {
							conversationId: durableConversationId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				return authorizeWorkspaceToolCall({
					caller,
					delegationToolNames: imDelegationTools,
					policy,
					toolName,
				});
			},
			gitIdentity: () => readGitIdentity(this.domainDatabase),
			logger: this.runtimeLog,
			messaging: this.sessionMessaging,
			promptHooks: this.promptHooks,
			resolveSessionId,
			schedules: this.schedules,
			workspace: this.workspace,
		});
		this.codingAgentToolsExtension = createCodingAgentToolsExtension({
			audit: (entry) => this.writeAudit(entry),
			authorize: async (durableConversationId) => {
				const caller = await resolveImCallerContext({
					conversationId: durableConversationId,
					database: this.domainDatabase,
					overrides: { turnBoundSender: this.boundTurnSender(durableConversationId) },
					settings: this.pluginSettings,
				});
				const chatKind = caller.chatKind;
				if (chatKind !== "workspace") {
					return {
						allowed: false,
						reason:
							chatKind === "private" || chatKind === "group"
								? "im_tool_not_permitted"
								: "coding_tools_require_workspace",
					};
				}
				const sessionId = caller.domainConversationId;
				if (sessionId === undefined) {
					return { allowed: false, reason: "session_not_found" };
				}
				const policy = await this.conversationPolicy.effectivePolicy(sessionId);
				if (policy.capabilities.includes("coding") !== true) {
					return { allowed: false, reason: "coding_capability_required" };
				}
				return { allowed: true };
			},
			logger: this.runtimeLog,
			messaging: this.sessionMessaging,
			references: workspaceReferences,
			resolveSessionId,
			sql: workspaceSql,
			todos: this.workspaceTodos,
		});
		this.pluginConversations = new PluginConversationService({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			lock: this.executionLock,
			logger: this.runtimeLog,
			policy: this.conversationPolicy,
			promptContext: (sessionId) => this.promptHooks.renderContext(sessionId),
			replyDispatcher: this.replyDispatcher,
		});
		const pluginBindings = new Map(options?.pluginBindings ?? []);
		pluginBindings.set(MEMORY_SERVICE_BINDING, this.memory);
		pluginBindings.set(CHAT_HISTORY_SERVICE_BINDING, this.chatHistory);
		pluginBindings.set(SOCIAL_PROFILE_BINDING, this.socialProfiles);
		const proactiveGateBridge: ProactiveBubbleGateBridge = {
			decideProactiveBubble: async (input) =>
				this.conversationGateService === undefined
					? { decision: "SHOULD", reason: "unconfigured", source: "fallback" }
					: this.conversationGateService.decideProactiveBubble(input),
		};
		pluginBindings.set(CONVERSATION_GATE_BINDING, proactiveGateBridge);
		pluginBindings.set(
			ONEBOT_MENTION_NAME_BINDING,
			createMentionIdentityStore(() => this.conversationRouter),
		);
		if (!pluginBindings.has(ONEBOT_AUDIO_TRANSCRIBE_BINDING)) {
			// Default speech-to-text seam routed through registered plugin model providers.
			pluginBindings.set(
				ONEBOT_AUDIO_TRANSCRIBE_BINDING,
				async (input: {
					readonly audio?: Uint8Array;
					readonly mimeType?: string;
					readonly sourceUrl?: string;
				}) => {
					if (input.audio === undefined) return undefined;
					for (const provider of this.pluginHost.modelProviders()) {
						try {
							const transcribe =
								provider.transcribeAudio !== undefined
									? (req: { readonly audio: Uint8Array; readonly mimeType?: string }) =>
											provider.transcribeAudio!(req)
									: provider.audioTranscribe !== undefined
										? (req: { readonly audio: Uint8Array; readonly mimeType?: string }) =>
												provider.audioTranscribe!.transcribeAudio(req)
										: undefined;
							if (transcribe === undefined) continue;
							const result = await transcribe({
								audio: input.audio,
								...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
							});
							const text = result.text.trim();
							if (text.length > 0) return text;
						} catch (error) {
							this.runtimeLog.debug("OneBot audio transcription failed; degrading gracefully", {
								error: error instanceof Error ? error.message : String(error),
								providerId: provider.id,
							});
						}
					}
					return undefined;
				},
			);
		}
		if (!pluginBindings.has(ONEBOT_VIDEO_FRAME_EXTRACTOR_BINDING)) {
			// Bounded ffmpeg keyframes through the OneBot sidecar or the guarded host fetch. A missing
			// binary, unsupported codec, timeout, or private URL degrades to no frames so the video
			// part itself still reaches the model.
			pluginBindings.set(
				ONEBOT_VIDEO_FRAME_EXTRACTOR_BINDING,
				createVideoFrameExtractor({
					logger: this.runtimeLog,
					resolveBytes: async (input) => {
						const channel = this.channels
							.list()
							.find(
								(adapter) =>
									adapter.kind === ONEBOT_CHANNEL_KIND && adapter.fetchMedia !== undefined,
							);
						if (channel?.fetchMedia !== undefined) {
							try {
								const bytes = await channel.fetchMedia({
									...(input.channelRef === undefined ? {} : { channelRef: input.channelRef }),
									...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
									...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
									...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
									type: "video",
								});
								if (bytes !== undefined && bytes.byteLength > 0) return bytes;
							} catch (error) {
								this.runtimeLog.debug("OneBot video bytes unavailable through channel", {
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
						if (input.sourceUrl === undefined || !/^https?:\/\//iu.test(input.sourceUrl)) {
							return undefined;
						}
						try {
							const stored = await this.media.storeFromUrl(input.sourceUrl, {
								kind: "video",
								source: "channel",
							});
							return await this.media.readBytes(stored.sha256);
						} catch (error) {
							this.runtimeLog.debug("OneBot video URL could not be fetched for frames", {
								error: error instanceof Error ? error.message : String(error),
							});
							return undefined;
						}
					},
					storeFrame: async (bytes, frame) => {
						const stored = await this.media.store({
							bytes,
							kind: "image",
							metadata: { derivedFrom: "video", frameIndex: frame.index },
							mimeType: frame.mimeType,
							source: "channel",
						});
						return { mediaId: stored.id, sha256: stored.sha256 };
					},
				}),
			);
		}
		this.pluginHost = new PluginHost({
			audit: (entry) => this.writeAudit(entry),
			bindings: pluginBindings,
			cache: this.cache,
			channels: this.channels,
			conversationCapabilities: (conversationId) =>
				this.conversationPolicy.capabilitiesForDurableConversation(conversationId),
			conversationRole: (conversationId) =>
				this.conversationPolicy.roleForDurableConversation(conversationId),
			turnSender: (conversationId) => this.boundTurnSender(conversationId),
			conversations: this.pluginConversations,
			followUps: this.followUpIntents,
			database: () => this.domainDatabase,
			hooks: this.hooks,
			logger: this.logger,
			migrations: this.pluginMigrations,
			media: this.media,
			outbound: this.outbound,
			pluginDatabases: this.pluginDatabases,
			reservedToolNames: reservedModelToolNames,
			onModelMessage: (message, pluginId) => {
				this.modelUsageLedger.record(
					message as Parameters<typeof this.modelUsageLedger.record>[0],
					`plugin:${pluginId}`,
				);
			},
			onHostModelMessage: (message, capability) => {
				this.modelUsageLedger.record(
					message as Parameters<typeof this.modelUsageLedger.record>[0],
					capability,
				);
			},
			plugins: this.plugins,
			requests: this.requestService,
			settings: this.pluginSettings,
			statuses: this.pluginStatuses,
			storage: this.pluginStorage,
			tasks: this.pluginTasks,
		});
	}

	/**
	 * Provider id whose port currently serves conversations. `fake` means no plugin provider is
	 * usable, so settings surfaces should not offer a catalog.
	 */
	get activeModelProviderId(): string | undefined {
		return this.activeProviderId;
	}

	/** Conversation model as a sidechat target; the deterministic fake model is not one. */
	private activeModelTarget():
		| { readonly modelId: string; readonly providerId: string }
		| undefined {
		const model = this.memoryModel;
		if (model === undefined || model.providerId === "fake") return undefined;
		return { modelId: model.modelId, providerId: model.providerId };
	}

	/**
	 * Out-of-band fast-lane interjection for urgent direct messages while a main turn is busy.
	 * Uses a one-line persona + familiarity anchor and minimal recent context; never mutates the
	 * active durable run. Returns `undefined` when no model is available so normal busy handling
	 * takes over.
	 */
	private async runFastLaneInterject(
		input: FastLaneInterjectInput,
	): Promise<FastLaneInterjectResult | undefined> {
		const active = this.activeModelTarget();
		const eligible = (
			await this.pluginHost.listModels({ capability: MODEL_CAPABILITIES.sidechat }).catch(() => [])
		).map((candidate) => ({ modelId: candidate.id, providerId: candidate.providerId }));
		const configured =
			input.policy.sidechat.interjectModel?.trim() || input.policy.sidechat.model?.trim();
		const fallback =
			configured !== undefined && configured.length > 0
				? undefined
				: this.domainDatabase === undefined
					? undefined
					: (await readRuntimeSettings(this.domainDatabase)).sidechatModelId;
		const requested =
			configured !== undefined && configured.length > 0 ? configured : fallback?.trim();
		const target =
			requested === undefined || requested.length === 0 || this.decisionModels.supports(requested)
				? (active ?? eligible[0])
				: (resolveSidechatTarget(eligible, requested, active) ?? active);
		if (target === undefined) return undefined;

		const sessionId = this.sessionIdForDurableConversation(input.conversationId);
		const [personaAnchor, socialProfile] = await Promise.all([
			this.contextProvider.personaAnchor(input.conversationId),
			sessionId === undefined
				? Promise.resolve(undefined)
				: this.socialProfiles.getProfile(sessionId).catch(() => undefined),
		]);
		const prompt = composeInterjectPrompt({
			messageText: input.messageText,
			personaAnchor,
			recentLines: input.recentLines,
			...(socialProfile === undefined ? {} : { relationLevel: socialProfile.level }),
			runningTaskSummary: input.runningRequest,
			...(input.senderName === undefined ? {} : { senderName: input.senderName }),
		});
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(100, input.policy.sidechat.interjectTimeoutMs),
		);
		timer.unref?.();
		try {
			const result = await this.pluginHost.completeModel(
				{
					maxTokens: input.policy.sidechat.interjectMaxTokens,
					messages: [
						{ content: prompt.system, role: "system" },
						{ content: prompt.user, role: "user" },
					],
					modelId: target.modelId,
					providerId: target.providerId,
					signal: controller.signal,
				},
				MODEL_CAPABILITIES.sidechat,
			);
			const text = result.text.trim();
			return text.length === 0 ? { handled: false, reason: "empty" } : { handled: true, text };
		} catch (error) {
			this.runtimeLog.debug("fast-lane interjection failed; falling back to busy handling", {
				conversationId: input.conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	get state(): LifecycleState {
		return {
			stage: this.currentStage,
			startedAtMs: this.startedAtMs,
			state: this.currentState,
			...(this.failureReason ? { reason: this.failureReason } : {}),
		};
	}

	get ready(): boolean {
		return this.currentState === "ready" || this.currentState === "degraded";
	}

	setRestartHandler(handler: (intent: RestartIntent) => Promise<void> | void): void {
		this.restartCoordinator.setHandler(handler);
	}

	async scheduleRestart(
		input: {
			readonly delaySeconds?: number;
			readonly mode?: RestartMode;
			readonly reason?: string;
			readonly requestedBy?: string;
		} = {},
	): Promise<RestartStatus> {
		return this.restartCoordinator.schedule({
			...(input.delaySeconds === undefined
				? {}
				: { delayMs: Math.max(1, input.delaySeconds) * 1_000 }),
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(input.reason === undefined ? {} : { reason: input.reason }),
			...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
		});
	}

	async cancelRestart(reason?: string): Promise<boolean> {
		return this.restartCoordinator.cancel(reason);
	}

	async restartStatus(): Promise<RestartStatus | null> {
		return this.restartCoordinator.status();
	}

	async installDependencies(
		options: { readonly signal?: AbortSignal | undefined } = {},
	): Promise<void> {
		await this.dependencyInstaller.install(options);
	}

	/**
	 * Settle the deployment that owned a restart intent once the intent reaches a terminal
	 * state. A deployment stays `scheduled` until this runs, so history never reports an
	 * unfinished restart as deployed.
	 *
	 * A completed restart is only accepted as `deployed`/`rolled_back` when the running process
	 * reports the exact revision the proposal deployed. The runtime never applies a diff itself,
	 * so a supervisor that restarted the old image (or applied nothing) must not be recorded as
	 * success; those rows become `manual_apply_required`.
	 */
	private async reconcileRestartSettlement(
		intent: RestartIntent,
		outcome: RestartSettlementOutcome,
	): Promise<void> {
		const deploymentId = intent.metadata.deploymentId;
		if (typeof deploymentId === "string" && deploymentId.length > 0) {
			const result = await reconcileRestartDeployment(this.codingStore, {
				atMs: Date.now(),
				deploymentId,
				outcome,
				verify: (input) => this.verifyDeploymentApplication(input),
			});
			this.runtimeLog.info("restart settlement reconciled", {
				deploymentId,
				outcome,
				proposalId: result?.proposal?.id,
				restartId: intent.id,
				status: result?.deployment.status ?? "missing",
				updated: result?.updated ?? false,
			});
		}
		if (outcome === "interrupted") {
			await this.upgrades?.failRestart(intent.id, intent.reason);
		}
	}

	/**
	 * Report the exact artifact this process runs.
	 *
	 * The image build records `TSUKAIMA_COMMIT` and, when the deployer supplies it, the checksum
	 * of the approved patch baked into the image (`TSUKAIMA_PATCH_SHA256`). A revision alone is
	 * not evidence: a proposal's `sourceRevision` can be the base commit while its diff is still
	 * uncommitted, so an image built from that commit has none of the approved change.
	 *
	 * Without both labels this returns `undefined` and reconciliation fails closed. A source
	 * checkout has no such evidence either, so it never reports success.
	 */
	private runningDeploymentIdentity(): DeploymentIdentity | undefined {
		// Empty means "not recorded" (the deployer writes an empty value), not an unknown commit.
		const revision = (process.env.TSUKAIMA_COMMIT ?? "").trim();
		const diffChecksum = (process.env.TSUKAIMA_PATCH_SHA256 ?? "").trim().toLowerCase();
		if (revision.length === 0 || diffChecksum.length === 0) return undefined;
		return { diffChecksum, revision };
	}

	/**
	 * Confirm that this process runs exactly the artifact a deployment claimed to apply.
	 *
	 * The verifier reports the observed identity; `reconcileRestartDeployment` compares it with
	 * the deployment's recorded identity (revision **and** approved patch checksum) and only then
	 * settles `deployed`/`rolled_back`. Anything less becomes `manual_apply_required`.
	 */
	private verifyDeploymentApplication(input: {
		readonly deployment: DeploymentRecord;
		readonly proposal: DeploymentProposal | null;
		readonly rollback: boolean;
	}): DeploymentApplicationVerification {
		const identity = this.runningDeploymentIdentity();
		if (identity === undefined) {
			return {
				detail:
					"running process reports no image revision and approved-patch checksum; the applied artifact cannot be verified",
				verified: false,
			};
		}
		const expected = input.deployment.appliedIdentity;
		if (expected === null) {
			return {
				detail:
					"deployment has no recorded artifact identity; the approved patch cannot be verified",
				identity,
				verified: false,
			};
		}
		return {
			detail: `running artifact ${identity.revision} (patch ${identity.diffChecksum})`,
			identity,
			verified: true,
		};
	}

	/**
	 * Keep each conversation's model-tool surface aligned with its execution role.
	 * - WebUI chats can control workspaces, hooks, and host schedules, but never receive coding tools.
	 * - Authorized IM chats (`private`/`group` with `policy.workspaceDelegationEnabled === true`)
	 *   receive `IM_WORKSPACE_DELEGATION_TOOL_NAMES` (eagerly accessible), while strictly never
	 *   receiving `CODING_AGENT_TOOL_NAMES` or `WORKSPACE_CODING_TOOL_NAMES`.
	 * - IM chats receive the unified host `SCHEDULE_TOOL_NAMES` family and never the conflicting
	 *   `proactive-scheduler.*` model tools.
	 * - Workspaces require an explicit `coding` capability and receive repo tools only then.
	 */
	private async applySessionToolPolicy(
		durableConversationId: string,
		policy: {
			readonly capabilities: readonly string[];
			readonly workspaceDelegationEnabled?: boolean;
		},
	): Promise<void> {
		const database = this.domainDatabase;
		const host = this.conversationHost;
		if (database === undefined || host === undefined) return;
		const proactiveTools = this.pluginHost.modelToolNames("proactive-scheduler");
		let kind: string | undefined;
		let readFailed = false;
		const queryKind = async (): Promise<string | undefined> => {
			const [row] = await database
				.select({ chatKind: chatObjects.kind, sessionKind: conversations.kind })
				.from(conversations)
				.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
				.where(eq(conversations.durableConversationId, durableConversationId))
				.limit(1);
			return row?.chatKind ?? row?.sessionKind;
		};
		try {
			kind = await queryKind();
		} catch {
			// Retry once on transient SQLite busy/read failure before falling back.
			try {
				kind = await queryKind();
			} catch (retryError) {
				readFailed = true;
				kind = this.sessionKindByDurableId.get(durableConversationId);
				this.runtimeLog.warn(
					kind === undefined
						? "conversation tool policy read failed; applying fail-closed chat tool filter"
						: "conversation tool policy read failed; reusing cached conversation kind",
					{
						cachedKind: kind ?? null,
						durableConversationId,
						error: retryError instanceof Error ? retryError.message : String(retryError),
					},
				);
			}
		}
		if (kind !== undefined && !readFailed) {
			this.sessionKindByDurableId.set(durableConversationId, kind);
		}
		// Prompt-tool access reads the domain settings, so a transient DB failure must fail closed
		// instead of skipping the filter entirely.
		let agentAccess = false;
		try {
			agentAccess = this.prompts.agentAccess();
		} catch {
			agentAccess = false;
		}
		// One shared helper drives both the durable filter and the WebUI inspector preview.
		const removed = computeOmittedSessionTools({
			agentAccess,
			capabilities: policy.capabilities,
			chatSurfaceOmitted: host.modelToolNamesNotForSurface("chat"),
			codingSurfaceOmitted: host.modelToolNamesNotForSurface("coding"),
			kind,
			proactiveTools,
			readFailed,
			workspaceDelegationEnabled: policy.workspaceDelegationEnabled === true,
		});
		try {
			await host.updateToolAccess(durableConversationId, { remove: [...removed] });
		} catch (error) {
			this.runtimeLog.warn("conversation tool policy sync failed", {
				durableConversationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Workspace task creation owns its durable task row; no plugin RPC is on this path. */
	private async notifyWorkspaceParent(event: WorkspaceRunFinishedEvent): Promise<void> {
		const database = this.domainDatabase;
		if (database === undefined) return;
		const [workspace] = await database
			.select({ parentSessionId: workspaceSessions.parentSessionId })
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, event.sessionId))
			.limit(1);
		const parentSessionId = workspace?.parentSessionId;
		if (parentSessionId === null || parentSessionId === undefined) return;
		const summary = event.assistantText.trim();
		const lines = [
			"[Workspace subagent finished]",
			`workspaceSessionId: ${event.sessionId}`,
			`taskId: ${event.taskId}`,
			...(event.failure === undefined ? [] : [`error: ${event.failure}`]),
			...(summary.length === 0 ? [] : [`summary:\n${summary}`]),
			`Use workspace_status({ sessionId: "${event.sessionId}" }) for proposals/details, and report the outcome to the user.`,
		];
		try {
			await this.sessionMessaging.sendAgentMessage({
				deliveryMode: "follow-up",
				direction: "system",
				sessionId: parentSessionId,
				source: "session-tool",
				text: lines.join("\n"),
			});
		} catch (error) {
			this.runtimeLog.warn("failed to notify parent session of workspace completion", {
				error: error instanceof Error ? error.message : String(error),
				parentSessionId,
				workspaceSessionId: event.sessionId,
			});
		}
	}

	private async createWorkspaceTask(input: {
		readonly baseRef: string;
		readonly goal: string;
		readonly sourceConversationId: string;
	}): Promise<string> {
		const constraints = {
			allowedCommands: [...WORKSPACE_NATIVE_TASK_CONSTRAINTS.allowedCommands],
			maxOutputBytes: WORKSPACE_NATIVE_TASK_CONSTRAINTS.maxOutputBytes,
			pathAllowlist: [...WORKSPACE_NATIVE_TASK_CONSTRAINTS.pathAllowlist],
			timeoutMs: WORKSPACE_NATIVE_TASK_CONSTRAINTS.timeoutMs,
		};
		const task = await this.codingStore.createTask({
			baseRef: input.baseRef,
			constraints,
			goal: input.goal,
			mode: "maintenance",
			sourceConversationId: input.sourceConversationId,
		});
		await this.writeAudit({
			action: "workspace.task.create",
			actorId: input.sourceConversationId,
			actorKind: "agent",
			payload: { baseRef: input.baseRef, goal: input.goal, mode: task.mode },
			result: "ok",
			targetId: task.id,
			targetKind: "coding-task",
		});
		return task.id;
	}

	private async ensureWorkspaceWorktree(taskId: string): Promise<{
		readonly analysisOnly: boolean;
		readonly path: string;
		readonly baseRef: string;
		readonly constraints: {
			readonly allowedCommands: readonly string[];
			readonly pathAllowlist: readonly string[];
			readonly maxOutputBytes?: number;
			readonly timeoutMs?: number;
		};
	}> {
		const task = await this.codingStore.getTask(taskId);
		if (task === null) throw new Error("workspace_task_not_found");
		const manager =
			this.workspaceWorktrees.get(task.id) ??
			new WorktreeManager({
				pathAllowlist: task.constraints.pathAllowlist,
				repositoryPath: this.config.repositoryRoot,
				worktreeRoot: join(this.config.dataDir, "worktrees"),
			});
		this.workspaceWorktrees.set(task.id, manager);
		const path = task.worktreePath ?? manager.pathFor(task.id);
		const checkoutExists = await isWorkspaceWorktreeCheckout(path);
		if (!checkoutExists) {
			await manager.create(task.id, task.baseRef);
		}
		if (task.worktreePath === undefined || !checkoutExists) {
			const latest = (await this.codingStore.getTask(task.id)) ?? task;
			await this.codingStore.updateTask(task.id, {
				timeline: [
					...latest.timeline,
					{
						atMs: Date.now(),
						detail: path,
						outcome: "success" as const,
						tool: "workspace.native.worktree",
					},
				],
				status: "in_progress",
				worktreePath: path,
			});
		}
		return {
			analysisOnly: task.mode === "analysis",
			baseRef: task.baseRef,
			constraints: task.constraints,
			path,
		};
	}

	private async workspaceModelPort(providerId: string): Promise<ModelPort> {
		if (this.modelOverride?.providerId === providerId) return this.modelOverride;
		const provider = this.pluginHost.modelProvider(providerId);
		if (provider !== undefined) {
			try {
				if ((await provider.isConfigured?.()) !== false) {
					return (await provider.createPort({
						onMessage: (message) => {
							this.modelUsageLedger.record(
								message as Parameters<typeof this.modelUsageLedger.record>[0],
								"basic-chat",
							);
						},
					})) as ModelPort;
				}
			} catch (error) {
				this.runtimeLog.warn("workspace model provider unavailable; using host fallback", {
					error: error instanceof Error ? error.message : String(error),
					providerId,
				});
			}
		}
		if (this.modelOverride !== undefined) return this.modelOverride;
		return createFakeModel({
			onMessage: (message) => {
				this.modelUsageLedger.record(message, "basic-chat");
			},
		});
	}

	private transition(stage: string, state: LifecycleState["state"] = "starting"): void {
		this.currentStage = stage;
		this.currentState = state;
		this.runtimeLog.info(state === "ready" ? "server ready" : "lifecycle stage", {
			stage,
			state,
		});
	}

	private setLogLevel(level: TsukaimaConfig["logLevel"]): void {
		this.logLevel = level;
		this.logger.setLevel(level);
	}

	private async createModelPort(settings: RuntimeSettings): Promise<ModelPort> {
		if (this.modelOverride !== undefined) return this.modelOverride;
		const providerId = settings.modelProviderId ?? this.pluginHost.modelProviders()[0]?.id;
		if (providerId === undefined) {
			this.runtimeLog.info("No plugin model provider configured; using deterministic fake model");
			return createFakeModel({
				onMessage: (message) => {
					this.modelUsageLedger.record(message, "basic-chat");
				},
			});
		}
		const provider = this.pluginHost.modelProvider(providerId);
		if (provider !== undefined) {
			try {
				if ((await provider.isConfigured?.()) === false) {
					this.runtimeLog.info("plugin model provider is not configured", { providerId });
					return createFakeModel({
						onMessage: (message) => {
							this.modelUsageLedger.record(message, "basic-chat");
						},
					});
				}
				const port = await provider.createPort({
					onMessage: (message) => {
						this.modelUsageLedger.record(
							message as Parameters<typeof this.modelUsageLedger.record>[0],
							"basic-chat",
						);
					},
				});
				this.runtimeLog.info("plugin model provider configured", { providerId });
				return port as ModelPort;
			} catch (error) {
				this.runtimeLog.warn("plugin model provider unavailable; using fake model", {
					error: error instanceof Error ? error.message : String(error),
					providerId,
				});
			}
		}
		this.runtimeLog.info("No plugin model provider configured; using deterministic fake model");
		return createFakeModel({
			onMessage: (message) => {
				this.modelUsageLedger.record(message, "basic-chat");
			},
		});
	}

	async start(): Promise<void> {
		this.transition("prepare-directories");
		await mkdir(join(this.config.dataDir, "blobs"), { recursive: true });
		if (
			this.config.logDir !== undefined &&
			!this.customLoggerProvided &&
			this.dailyFileSink === undefined
		) {
			this.dailyFileSink = createDailyFileLogSink({
				dir: this.config.logDir,
				...(this.config.logRetentionDays === undefined
					? {}
					: { retentionDays: this.config.logRetentionDays }),
			});
			this.removeFileSink = this.logger.addSink(this.dailyFileSink.sink);
			this.runtimeLog.debug("daily file log sink enabled", {
				dir: this.config.logDir,
				...(this.config.logRetentionDays === undefined
					? {}
					: { retentionDays: this.config.logRetentionDays }),
			});
		}
		this.transition("durable-storage");
		this.durableStorage = await openDurableStorage(join(this.config.dataDir, "durable.sqlite"));
		this.transition("domain-database");
		this.domainDatabase = await openDomainDatabase(join(this.config.dataDir, "domain.sqlite"));
		migrateDomainDatabase(this.domainDatabase);
		await this.restartCoordinator.recover();
		await this.upgrades.recover();
		await this.restartCoordinator
			.resumeIntentFile(join(this.config.dataDir, "restart-intent.json"))
			.catch((error: unknown) => {
				this.runtimeLog.warn("restart intent file check failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		this.transition("plugin-migrations");
		const domainSource = wrapPluginSqlConnection(
			this.domainDatabase.$client as unknown as Parameters<typeof wrapPluginSqlConnection>[0],
		);
		for (const plugin of this.plugins) {
			const pluginId = plugin.manifest.name;
			if (!(await this.pluginSettings.isEnabled(pluginId))) continue;
			if (plugin.manifest.migrations === undefined) continue;
			if (plugin.rootDir === undefined) {
				throw new Error(
					`Plugin ${pluginId} declares a migrations directory but exposes no rootDir`,
				);
			}
			const migrations = await loadPluginMigrations(plugin.rootDir, plugin.manifest.migrations);
			const result = await this.pluginMigrations.run(pluginId, migrations);
			if (result.applied.length > 0) {
				this.runtimeLog.info("applied plugin migrations", {
					pluginId,
					versions: result.applied.map((migration) => migration.version),
				});
			}
			const database = await this.pluginDatabases.open(pluginId);
			const legacy = migrateLegacyPluginTables({
				pluginId,
				source: domainSource,
				target: database,
			});
			if (legacy.imported.length > 0) {
				this.runtimeLog.info("moved legacy plugin tables into the plugin database", {
					pluginId,
					tables: legacy.imported.map((table) => ({
						importedRows: table.importedRows,
						table: table.table,
					})),
				});
			}
			if (legacy.orphaned.length > 0) {
				this.runtimeLog.warn("legacy plugin tables have no target schema and were left in place", {
					pluginId,
					tables: legacy.orphaned,
				});
			}
		}
		this.transition("load-settings");
		const settings = await readRuntimeSettings(this.domainDatabase);
		if (this.config.logLevelFromEnv) {
			if (settings.logLevel === DEFAULT_LOG_LEVEL) {
				this.setLogLevel(this.config.logLevel);
				this.runtimeLog.debug("TSUKAIMA_LOG_LEVEL seeded the log level of a fresh install", {
					envLogLevel: this.config.logLevel,
					persistedLogLevel: settings.logLevel,
				});
			} else {
				this.setLogLevel(settings.logLevel);
				this.runtimeLog.debug("persisted log level wins over the TSUKAIMA_LOG_LEVEL default", {
					envLogLevel: this.config.logLevel,
					persistedLogLevel: settings.logLevel,
				});
			}
		} else {
			this.setLogLevel(settings.logLevel);
		}

		// Plugins register model providers during setup, which happens later in startup. The
		// host therefore prepares plugin surfaces first, then resolves the active provider.
		this.transition("plugins");
		await this.pluginHost.prepare();
		this.transition("domain-services");
		const model = await this.createModelPort(settings);
		this.memoryModel = model;
		this.activeProviderId = model.providerId;
		const sidechatModels = {
			active: () => this.activeModelTarget(),
			eligible: async () =>
				(await this.pluginHost.listModels({ capability: MODEL_CAPABILITIES.sidechat })).map(
					(candidate) => ({ modelId: candidate.id, providerId: candidate.providerId }),
				),
			complete: async (
				target: { readonly modelId: string; readonly providerId: string },
				prompt: string,
				options: {
					readonly maxTokens: number;
					readonly signal: AbortSignal;
					readonly temperature: number;
				},
			) => {
				const result = await this.pluginHost.completeModel(
					{
						maxTokens: options.maxTokens,
						messages: [{ content: prompt, role: "user" }],
						modelId: target.modelId,
						providerId: target.providerId,
						signal: options.signal,
						temperature: options.temperature,
					},
					MODEL_CAPABILITIES.sidechat,
				);
				return result.text;
			},
		};
		this.sidechatService = new SidechatService({
			decisionModels: this.decisionModels,
			prompt: () => this.prompts.render("sidechat"),
			defaultModelId: async () =>
				this.domainDatabase === undefined
					? undefined
					: (await readRuntimeSettings(this.domainDatabase)).sidechatModelId,
			logger: this.logger,
			models: sidechatModels,
		});
		this.conversationGateService =
			this.conversationGateOverride ??
			new ConversationGateService({
				decisionModels: this.decisionModels,
				defaultModelId: async () => {
					if (this.domainDatabase === undefined) return undefined;
					const current = await readRuntimeSettings(this.domainDatabase);
					return current.gateModelId ?? current.sidechatModelId;
				},
				logger: this.logger,
				models: sidechatModels,
			});
		if (settings.sidechatModelId === undefined) {
			this.runtimeLog.info("sidechat model is not configured; using the active model", {
				modelId: model.modelId,
			});
		}
		this.conversationHost = new PiDurableConversationHost({
			busyArbiter: async (input) => this.sidechatService?.decide(input),
			checkRepetitionRewrite: (conversationId, replyText) =>
				this.contextProvider.checkRepetitionRewrite(conversationId, replyText),
			contextProvider: this.contextProvider,
			...(this.conversationGateService === undefined
				? {}
				: { conversationGate: this.conversationGateService }),
			executionLock: this.executionLock,
			fastLaneInterjector: (input) => this.runFastLaneInterject(input),
			logger: this.logger.child("tsukaima::core::host"),
			model,
			onActivityEvent: (event) => this.forwardActivityEvent(event),
			onFastLaneReply: async (reply) => {
				await this.replyDispatcher.handleFastLaneReply(reply);
			},
			onAnswer: async (answer) => {
				const sessionId = this.sessionIdForDurableConversation(answer.conversationId);
				if (sessionId !== undefined) {
					await this.liveRuns.finalizeAnswer(sessionId, answer.entryId).catch((error: unknown) => {
						this.runtimeLog.warn("failed to store final run steps", {
							entryId: answer.entryId,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				}
				await this.replyDispatcher.handleAnswer(answer);
			},
			// The expectation is durable before the turn is admitted, so recovery covers a crash
			// between the answer commit and this observer. A failure here aborts the turn: no reply
			// may be produced without a durable record that it is owed.
			onBackgroundTurnAdmitted: async (turn) => {
				const sessionId = this.sessionIdForDurableConversation(turn.conversationId);
				if (sessionId === undefined) return;
				await this.replyExpectations.expect({
					conversationId: sessionId,
					kind: "background",
					...(turn.origin?.followUpKind === undefined
						? {}
						: { sourceFollowUpKind: turn.origin.followUpKind }),
					...(turn.origin?.pluginId === undefined ? {} : { sourcePluginId: turn.origin.pluginId }),
					...(turn.origin?.sourceTaskId === undefined
						? {}
						: { sourceTaskId: turn.origin.sourceTaskId }),
					submissionRequestId: turn.submissionRequestId,
				});
				if (turn.midRun !== true) this.replyDispatcher.beginTurn(turn.conversationId);
				this.noteTurnSender(turn);
			},
			onTurnAdmitted: async (turn) => {
				const sessionId = this.sessionIdForDurableConversation(turn.conversationId);
				if (sessionId === undefined) return;
				await this.replyExpectations.expect({
					conversationId: sessionId,
					kind: "chat",
					submissionRequestId: turn.submissionRequestId,
				});
				if (turn.midRun !== true) this.replyDispatcher.beginTurn(turn.conversationId);
				this.noteTurnSender(turn);
			},
			// A submission settles exactly once, whatever its outcome: a dispatched answer, empty
			// final text, an interrupted run, `unanswered`, or a refused submit. Deleting the exact
			// request id keeps a stale admin binding from authorizing a later non-admin turn.
			onSubmissionSettled: (event) => {
				this.settleTurnSender(
					event.conversationId,
					event.submissionRequestId,
					event.preserveReplyState === true,
				);
			},
			onLiveRun: (state) => {
				this.forwardLiveRun(state);
			},
			// Detached on purpose: the generation hook must not wait for channel sends (the tool
			// round would stall) or for the conversation lock (a background turn holding it may be
			// waiting on this very run). The dispatcher reserves its outbound lane synchronously, so
			// narration still precedes the turn's final answer.
			onNarration: (narration) => {
				void this.replyDispatcher.handleNarration(narration).catch((error: unknown) => {
					this.runtimeLog.warn("narration delivery failed", {
						conversationId: narration.conversationId,
						error: error instanceof Error ? error.message : String(error),
						narrationId: narration.narrationId,
					});
				});
			},
			// Only chat surfaces stream answer lines mid-run. A workspace or task turn posts its
			// governed result when it settles, so partial code never escapes the worktree.
			readConversationKind: async (durableConversationId) => {
				const known = this.sessionKindByDurableId.get(durableConversationId);
				if (known !== undefined) return known;
				const database = this.domainDatabase;
				if (database === undefined) return undefined;
				const [row] = await database
					.select({ chatKind: chatObjects.kind, sessionKind: conversations.kind })
					.from(conversations)
					.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
					.where(eq(conversations.durableConversationId, durableConversationId))
					.limit(1);
				const kind = row?.chatKind ?? row?.sessionKind;
				if (kind !== undefined) this.sessionKindByDurableId.set(durableConversationId, kind);
				return kind;
			},
			// Only canonical channel chat-send tools count: `workspace_send` and
			// `sticker-meme_send` are not direct sends and must not suppress the final answer.
			isDirectSendTool: (toolName) =>
				isDirectSendToolName(this.pluginHost.resolveModelToolName(toolName) ?? toolName),
			hasDirectSend: (conversationId) => this.replyDispatcher.hasDirectSendThisTurn(conversationId),
			resolveImage: async (part) => {
				if (part.type !== "image") return undefined;
				// Only bytes already in the media store can be shown to the model. A part that only
				// carries a remote URL has not been fetched, so it stays a placeholder rather than
				// blocking the turn on an outbound request.
				const sha256 = part.sha256 ?? (await this.mediaShaFor(part.mediaId));
				if (sha256 === undefined) return undefined;
				try {
					const bytes = await this.media.readBytes(sha256);
					return {
						data: Buffer.from(bytes).toString("base64"),
						mimeType: part.mimeType ?? "image/png",
					};
				} catch {
					return undefined;
				}
			},
			storage: this.durableStorage,
		});
		const persistedSessions = await this.domainDatabase
			.select({
				durableConversationId: conversations.durableConversationId,
				id: conversations.id,
			})
			.from(conversations);
		for (const session of persistedSessions) {
			// Imported DSH conversations carry a `durable_...` marker rather than a Pi numeric
			// conversation id. Create a real durable conversation once and remember it so future
			// inbound turns, WebUI sends, and policy sync can address it.
			let durableConversationId = session.durableConversationId;
			if (!/^\d+$/.test(durableConversationId)) {
				durableConversationId = await this.conversationHost.createConversation();
				await this.domainDatabase
					.update(conversations)
					.set({ durableConversationId, updatedAt: new Date().toISOString() })
					.where(eq(conversations.id, session.id));
			}
			await this.conversationHost.resumeActivityWindow(durableConversationId);
		}
		const models = model.models.getModels(model.providerId);
		this.modelRouter = new ModelPolicyRouter(models);
		this.routingPolicies = [
			{
				capability: "basic-chat",
				primary: { modelId: model.modelId, providerId: model.providerId },
			},
		];

		const conversationHost = this.conversationHost;
		const toolLog = this.logger.child("tsukaima::server::tools");
		const pluginTools =
			conversationHost === undefined
				? undefined
				: createPluginToolsExtension(
						() => this.pluginHost.tools(),
						(name, input, context) => this.pluginHost.invokeTool(name, input, context),
						{
							audit: (entry) => this.writeAudit(entry),
							debug: (message, fields) => {
								toolLog.debug(message, fields);
							},
							logger: (message, error) => {
								this.runtimeLog.warn(message, {
									error: error instanceof Error ? error.message : String(error),
								});
							},
							policyContext: (tool, context) => this.pluginHost.toolPolicyContext(tool, context),
							reservedNames: reservedModelToolNames,
							trace: (message, fields) => {
								toolLog.trace(message, fields);
							},
						},
					);
		const dynamicExtensions = [
			createPromptTools(this.prompts, this.conversationPolicy),
			...(pluginTools === undefined ? [] : [pluginTools]),
			...(this.workspaceToolsExtension === undefined ? [] : [this.workspaceToolsExtension]),
			...(this.scheduleToolsExtension === undefined ? [] : [this.scheduleToolsExtension]),
			...(this.codingAgentToolsExtension === undefined ? [] : [this.codingAgentToolsExtension]),
		];
		if (conversationHost !== undefined && dynamicExtensions.length > 0) {
			// Install before plugins connect so inbound messages always resolve the extension;
			// the tool getter sees registrations as soon as each plugin's setup completes.
			conversationHost.installExtensions(dynamicExtensions);
		}
		this.transition("plugins");
		await this.pluginHost.start();
		this.pluginTasks.start();
		await this.memory.start();
		if (conversationHost !== undefined && dynamicExtensions.length > 0) {
			// Reinstall after startup to reset per-conversation checks for sessions that received
			// a message while the extension still had no tools.
			conversationHost.installExtensions(dynamicExtensions);
		}

		try {
			await this.replyDispatcher.reconcilePendingDeliveries();
		} catch (error) {
			this.runtimeLog.warn("startup pending-delivery reconciliation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			// An interrupted turn commits its answer after the durable scheduler retries it, but
			// the in-memory run observer is gone. Replay answers that never reached a transcript.
			await this.replyDispatcher.recoverUndispatchedAnswers();
		} catch (error) {
			this.runtimeLog.warn("startup answer recovery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.replyDispatcher.startPendingReconciliation();
		this.backupDrills.start();
		if (this.beforeReadyCallback !== undefined) {
			// `/readyz` must not turn green before the single administrator exists; otherwise a
			// supervisor can race the first sign-in after a cold start.
			await this.beforeReadyCallback();
		}
		this.transition("ready", "ready");
		try {
			await this.schedules.recover();
			this.schedules.start();
		} catch (error) {
			this.runtimeLog.warn("schedule runner startup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			const dispatch = (hook: Parameters<SessionMessagingService["dispatchResumeHook"]>[0]) =>
				this.sessionMessaging.dispatchResumeHook(hook);
			const resumed = await this.promptHooks.dispatchStartupResumes(dispatch);
			const armed = await this.promptHooks.resumeTimers(dispatch);
			if (resumed > 0 || armed > 0) {
				this.runtimeLog.info("restored reserved work", { armed, resumed });
			}
		} catch (error) {
			this.runtimeLog.warn("failed to restore reserved work", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Gate readiness on a service that depends on the database but must precede traffic. */
	setBeforeReady(callback: () => Promise<void>): void {
		this.beforeReadyCallback = callback;
	}

	/** Run one isolated SQLite + blob backup/restore drill and return its secret-free report. */
	async runBackupDrill(runId?: string): Promise<BackupDrillReport> {
		return executeBackupDrill({
			dataDir: this.config.dataDir,
			mediaDir: join(this.config.dataDir, "blobs"),
			...(runId === undefined ? {} : { runId }),
			...(this.backupDrillRoot === undefined ? {} : { root: this.backupDrillRoot }),
		});
	}

	fail(reason: string): void {
		this.failureReason = reason;
		this.currentState = "failed";
		this.currentStage = "failed";
		this.runtimeLog.error("lifecycle failed", { reason, stage: this.currentStage });
	}

	private async refreshModelPort(settings?: RuntimeSettings): Promise<void> {
		if (this.modelOverride !== undefined || this.domainDatabase === undefined) return;
		const effectiveSettings = settings ?? (await readRuntimeSettings(this.domainDatabase));
		const model = await this.createModelPort(effectiveSettings);
		this.memoryModel = model;
		this.activeProviderId = model.providerId;
		this.modelRouter = new ModelPolicyRouter(model.models.getModels(model.providerId));
		this.routingPolicies = [
			{
				capability: "basic-chat",
				primary: { modelId: model.modelId, providerId: model.providerId },
			},
		];
		this.conversationHost?.setModel(model);
		// A provider swap can invalidate a stored model id, so re-resolve every conversation
		// against the new port instead of waiting for each one's next turn.
		const portSignature = JSON.stringify({
			modelId: model.modelId,
			models: model.models
				.getModels(model.providerId)
				.map((entry) => entry.id)
				.toSorted(),
			providerId: model.providerId,
		});
		if (portSignature !== this.modelPortSignature) {
			this.modelPortSignature = portSignature;
			this.agentDefaultsSignature = this.agentDefaultsKey(effectiveSettings);
			await this.conversationPolicy.refreshAgentSettings();
		}
		const requestedProviderId = effectiveSettings.modelProviderId;
		this.providerRestartRequired =
			requestedProviderId !== undefined && requestedProviderId !== this.activeProviderId;
		this.runtimeLog.debug("model port refreshed", {
			modelId: model.modelId,
			providerId: model.providerId,
			providerRestartRequired: this.providerRestartRequired,
		});
	}

	async applyRuntimeSettings(settings: RuntimeSettings): Promise<void> {
		this.setLogLevel(settings.logLevel);
		if (this.modelOverride === undefined && this.domainDatabase !== undefined) {
			await this.refreshModelPort(settings);
		} else {
			const requestedProviderId = settings.modelProviderId;
			this.providerRestartRequired =
				requestedProviderId !== undefined && requestedProviderId !== this.activeProviderId;
		}
		if (this.domainDatabase !== undefined && this.conversationHost !== undefined) {
			const signature = this.agentDefaultsKey(settings);
			if (signature !== this.agentDefaultsSignature) {
				this.agentDefaultsSignature = signature;
				await this.conversationPolicy.refreshAgentSettings();
			}
		}
		this.runtimeLog.info("runtime settings applied", {
			logLevel: settings.logLevel,
			providerRestartRequired: this.providerRestartRequired,
		});
	}

	/** Serialized chat/workspace model defaults, used to skip no-op durable re-syncs. */
	private agentDefaultsKey(settings: RuntimeSettings): string {
		return JSON.stringify({
			chatModel: settings.chatModel ?? null,
			chatThinking: settings.chatThinking ?? null,
			workspaceModel: settings.workspaceModel ?? null,
			workspaceThinking: settings.workspaceThinking ?? null,
		});
	}

	/** Apply configuration for a built-in plugin; plugins react through `settings.onChange`. */
	async updatePluginConfig(pluginId: string, patch: Record<string, unknown>): Promise<void> {
		await this.pluginHost.applySettings(pluginId, patch);
		await this.refreshModelPort();
	}

	async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
		await this.pluginHost.setEnabled(pluginId, enabled);
		await this.refreshModelPort();
	}

	async pluginConfig(pluginId: string): Promise<Record<string, unknown>> {
		return this.pluginSettings.read(pluginId);
	}

	async pluginConfigView(pluginId: string) {
		return this.pluginSettings.publicView(pluginId);
	}

	private async completeMemoryPrompt(
		prompt: string,
		modelId?: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const model = this.memoryModel;
		if (model === undefined) return undefined;
		const selected =
			model.models.getModel(model.providerId, modelId ?? model.modelId) ??
			model.models.getModel(model.providerId, model.modelId);
		if (selected === undefined) return undefined;
		const startedAt = performance.now();
		this.runtimeLog.trace("memory prompt completion started", {
			modelId: selected.id,
			promptChars: prompt.length,
			promptPreview: previewText(prompt),
			providerId: model.providerId,
		});
		const response = await model.models.completeSimple(
			selected,
			{
				messages: [{ content: prompt, role: "user", timestamp: Date.now() }],
			},
			{
				reasoning: "low",
				...(signal === undefined ? {} : { signal }),
			},
		);
		const text = response.content
			.filter(
				(part): part is { readonly text: string; readonly type: "text" } => part.type === "text",
			)
			.map((part) => part.text)
			.join("");
		this.runtimeLog.debug("memory prompt completion finished", {
			durationMs: Math.round(performance.now() - startedAt),
			modelId: selected.id,
			outputChars: text.length,
			providerId: model.providerId,
		});
		return text;
	}

	/** Embed through the first configured plugin provider; silently degrades when absent. */
	private async embedMemoryTexts(
		texts: readonly string[],
	): Promise<MemoryEmbeddingOutput | undefined> {
		try {
			for (const provider of this.pluginHost.modelProviders()) {
				const startedAt = performance.now();
				const result =
					provider.embed !== undefined
						? await provider.embed({ texts })
						: provider.embedding === undefined
							? undefined
							: await provider.embedding.embed({ texts });
				if (result !== undefined) {
					this.runtimeLog.debug("memory texts embedded", {
						count: texts.length,
						durationMs: Math.round(performance.now() - startedAt),
						modelId: result.modelId,
						providerId: provider.id,
					});
					return { modelId: result.modelId, vectors: result.vectors };
				}
			}
		} catch (error) {
			// Embedding is optional; callers fall back to lexical/recency ranking.
			this.runtimeLog.debug("memory embedding degraded to lexical fallback", {
				count: texts.length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return undefined;
	}

	/**
	 * Report a failed inbound pipeline stage. The channel registry calls these handlers from a
	 * detached promise, so without this every processing failure vanished: a contract violation
	 * or database error dropped the message with no log, no audit, and no visible symptom beyond
	 * "the bot did not answer".
	 *
	 * Failures are rate-limited per stage and conversation so a persistent breakage cannot flood
	 * the log buffer; the first occurrence is always logged, and `lastProcessingError` still
	 * carries the raw error for the diagnostics panel.
	 */
	private reportInboundFailure(
		stage: "envelope" | "notice" | "request",
		channelId: string,
		payload: unknown,
		error: unknown,
	): void {
		const cause = error instanceof Error ? error : new Error(String(error));
		this.lastProcessingError = cause;
		const record =
			typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
		const conversationKey = this.conversationKeyOf(record.conversationKey);
		const key = `${stage}:${channelId}:${conversationKey}`;
		const now = Date.now();
		const lastLoggedAt = this.inboundFailureLoggedAt.get(key);
		const shouldLog =
			lastLoggedAt === undefined || now - lastLoggedAt >= INBOUND_FAILURE_LOG_INTERVAL_MS;
		if (shouldLog) this.inboundFailureLoggedAt.set(key, now);
		const eventId = typeof record.id === "string" ? record.id : undefined;
		this.runtimeLog.warn("inbound channel event could not be processed", {
			channelId,
			conversationKey,
			error: cause.message,
			...(eventId === undefined ? {} : { eventId }),
			...(shouldLog ? {} : { suppressed: true }),
			stage,
		});
	}

	/** Stable, log-safe conversation identity for a channel payload. */
	private conversationKeyOf(value: unknown): string {
		if (typeof value !== "object" || value === null) return "unknown";
		const record = value as Record<string, unknown>;
		const kind = typeof record.kind === "string" ? record.kind : "unknown";
		const peer =
			typeof record.groupId === "string"
				? `group:${record.groupId}`
				: typeof record.peerId === "string"
					? `peer:${record.peerId}`
					: "unknown";
		return `${kind}:${peer}`;
	}

	private async handleChannelEnvelope(channelId: string, envelope: MessageEnvelope): Promise<void> {
		try {
			const result = await this.conversationRouter.ingest(envelope);
			if (!result.duplicated && !result.ignored) {
				this.processedMessageCount += 1;
				void this.schedules.cancelRepliedSchedules(result.sessionId).catch((error: unknown) => {
					this.runtimeLog.warn("cancel-if-replied schedule check failed", {
						error: error instanceof Error ? error.message : String(error),
						sessionId: result.sessionId,
					});
				});
				this.hooks.emitDetached("message.received", {
					channelId,
					chatObjectId: result.chatObjectId,
					classification: result.classification,
					envelope: result.envelope ?? envelope,
					sessionId: result.sessionId,
				});
			}
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}

	/**
	 * Resolve a durable conversation id to its domain session id. Runs on the request path of the
	 * live event stream, which is why it reads the already-open domain database synchronously
	 * instead of going through an async service. `undefined` means the conversation has no domain
	 * session, so there is nothing for the WebUI to attach the run to.
	 */
	sessionIdForDurableConversation(durableConversationId: string): string | undefined {
		const database = this.domainDatabase;
		if (database === undefined) return undefined;
		const [row] = database
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.limit(1)
			.all();
		return row?.id;
	}

	/**
	 * Bind the triggering inbound sender to a newly admitted turn. Bindings are keyed by the
	 * submission request id, so settlement removes exactly one turn and never shifts another
	 * turn's sender.
	 */
	private noteTurnSender(turn: AdmittedTurn): void {
		const durableConversationId = turn.conversationId;
		const sender =
			turn.senderExternalId === undefined || turn.senderExternalId.trim().length === 0
				? null
				: turn.senderExternalId;
		let entries = this.turnSenders.get(durableConversationId);
		if (entries === undefined) {
			entries = new Map();
			this.turnSenders.set(durableConversationId, entries);
		}
		// A steer joins the run that is already working. When the steer comes from another speaker
		// (or from no human at all), the merged run is mixed-speaker: every entry fails closed so
		// neither speaker's admin status can authorize the other's tool call.
		const mixedSteer =
			turn.whenBusy === "steer" &&
			[...entries.values()].some((bound) => bound === null || bound !== sender);
		if (mixedSteer) {
			for (const submissionRequestId of entries.keys()) {
				entries.set(submissionRequestId, null);
			}
			entries.set(turn.submissionRequestId, null);
			return;
		}
		entries.set(turn.submissionRequestId, sender);
	}

	/** Sender bound to the oldest active turn; `undefined` means no turn is currently bound. */
	private boundTurnSender(durableConversationId: string): string | null | undefined {
		const entries = this.turnSenders.get(durableConversationId);
		if (entries === undefined) return undefined;
		// Map iteration follows insertion order, so the first value is the active head.
		for (const sender of entries.values()) return sender;
		return undefined;
	}

	/**
	 * Release exactly one settled submission's binding. When that was the conversation's last
	 * active turn, its per-turn reply state (shown narrations, tool sends) must not suppress the
	 * next turn either: a turn that ended with empty final text, was interrupted, or was never
	 * answered produces no `handleAnswer` that would otherwise clear it.
	 */
	private settleTurnSender(
		durableConversationId: string,
		submissionRequestId: string,
		preserveReplyState = false,
	): void {
		const entries = this.turnSenders.get(durableConversationId);
		if (entries === undefined) return;
		entries.delete(submissionRequestId);
		if (entries.size > 0) return;
		this.turnSenders.delete(durableConversationId);
		if (!preserveReplyState) this.replyDispatcher.beginTurn(durableConversationId);
	}

	/**
	 * Store an inbound media part's bytes and rewrite the part to reference them.
	 *
	 * Channels hand over a remote URL or a platform file reference; nothing else fetches it. Until
	 * the bytes land in the media store, the transcript has nothing to render and the model only
	 * sees a placeholder.
	 */
	private async ingestInboundMedia(part: MessagePart, channelId: string): Promise<MessagePart> {
		if (part.type !== "image" && part.type !== "sticker") return part;
		// QQ native faces have no downloadable bytes; they stay a sticker summary, not a fetch failure.
		if (part.channelRef?.startsWith("face:") === true) return part;
		// Already content-addressed: the bytes are here.
		if (part.sha256 !== undefined && /^[0-9a-f]{64}$/iu.test(part.sha256)) {
			const existing = await this.media.findBySha(part.sha256);
			if (existing !== undefined) {
				this.runtimeLog.trace("inbound media reused from store", {
					mediaId: existing.id,
					sha256: existing.sha256,
					type: part.type,
				});
				const { mediaUnavailableReason: _previousReason, ...base } = part;
				return {
					...base,
					mediaId: existing.id,
					mimeType: part.mimeType ?? existing.mimeType,
					sha256: existing.sha256,
					sizeBytes: part.sizeBytes ?? existing.sizeBytes,
				};
			}
		}
		const channel = this.channels.get(channelId);
		const resolved = await this.inboundMedia.resolve(part, channel);
		if (resolved.kind === "unavailable") {
			this.runtimeLog.debug("inbound media is unavailable", {
				channelId,
				reason: resolved.reason,
				type: part.type,
			});
			return { ...part, mediaUnavailableReason: resolved.reason };
		}
		const { stored } = resolved;
		this.runtimeLog.debug("inbound media stored", {
			channelId,
			mediaId: stored.id,
			mimeType: stored.mimeType,
			sizeBytes: stored.sizeBytes,
			type: part.type,
			via: resolved.via,
		});
		const { mediaUnavailableReason: _previousReason, ...base } = part;
		return {
			...base,
			mediaId: stored.id,
			mimeType: stored.mimeType,
			sha256: stored.sha256,
			sizeBytes: stored.sizeBytes,
		};
	}

	/** Content hash behind a media row, for parts that reference bytes by id. */
	private async mediaShaFor(mediaId: string | undefined): Promise<string | undefined> {
		if (mediaId === undefined) return undefined;
		const database = this.domainDatabase;
		if (database === undefined) return undefined;
		const [row] = database
			.select({ sha256: media.sha256 })
			.from(media)
			.where(eq(media.id, mediaId))
			.limit(1)
			.all();
		return row?.sha256;
	}

	/**
	 * Forward durable live-run state to plugin hooks. Failing handlers never affect the run
	 * (`HookBus.emit` catches per handler). `conversationId` here is the durable id; the event
	 * stream resolves it to a domain session id before publishing.
	 */
	private forwardLiveRun(state: LiveRunSnapshot): void {
		this.hooks.emitDetached("agent.activity", state);
		const sessionId = this.sessionIdForDurableConversation(state.conversationId);
		if (sessionId === undefined) return;
		void this.liveRuns.record(sessionId, state).catch((error: unknown) => {
			this.runtimeLog.warn("failed to store live run state", {
				conversationId: state.conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/**
	 * Forward durable activity-window transitions to plugin hooks. Failing handlers never
	 * affect message processing (`HookBus.emit` catches per handler).
	 */
	private forwardActivityEvent(event: ActivityWindowEvent): void {
		this.hooks.emitDetached(event.type === "opened" ? "activity.opened" : "activity.closed", {
			activityId: event.activityId,
			conversationId: event.conversationId,
			envelopeCount: event.envelopeCount,
		});
		if (event.type === "closed") {
			void this.memory.noteConversationActivity({ durableConversationId: event.conversationId });
		}
	}

	private async handleChannelNotice(channelId: string, notice: ChannelNotice): Promise<void> {
		try {
			const result = await this.conversationRouter.ingestNotice(notice);
			if (notice.noticeType === "poke" && notice.isSelfTarget === true && !result.duplicated) {
				const wake = await this.conversationRouter.wakeFromNotice(notice, result);
				this.runtimeLog.info("poke at bot received", {
					channelId,
					conversationKey: notice.conversationKey,
					senderId: notice.actorId,
					wakeReason: wake.reason,
					woken: wake.woken,
				});
				await this.writeAudit({
					action: "channel.poke-at-bot",
					actorId: notice.actorId ?? "unknown",
					actorKind: "user",
					payload: {
						noticeId: notice.id,
						sessionId: result.sessionId,
						wakeReason: wake.reason,
						woken: wake.woken,
					},
					result: "ok",
					...(notice.actorId === undefined ? {} : { targetId: notice.actorId }),
					targetKind: "channel-user",
				});
			}
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}

	private async handleChannelRequest(_channelId: string, request: ChannelRequest): Promise<void> {
		try {
			await this.requestService.persist(request);
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}

	triggerStats(): ReturnType<ConversationRouter["triggerStats"]> {
		return this.conversationRouter.triggerStats();
	}

	async processEnvelope(envelope: MessageEnvelope): Promise<void> {
		await this.handleChannelEnvelope(envelope.channelId, envelope);
	}

	async processRequest(request: ChannelRequest): Promise<void> {
		await this.handleChannelRequest(request.channelId, request);
	}

	async processNotice(notice: ChannelNotice): Promise<void> {
		await this.handleChannelNotice(notice.channelId, notice);
	}

	async resolveChannelRequest(
		requestId: string,
		action: "approve" | "reject",
		reason?: string,
	): Promise<{ status: "approved" | "rejected" | "failed" | "uncertain" }> {
		return this.requestService.respond(requestId, action, reason);
	}

	/** Admin chat-snapshot service; available once construction is complete. */
	get chatSnapshots(): ChatSnapshotService {
		if (this.chatSnapshotService === undefined) {
			throw new Error("Chat snapshot service is not ready");
		}
		return this.chatSnapshotService;
	}

	async writeAudit(entry: AuditEntry): Promise<void> {
		const database = this.domainDatabase;
		if (database === undefined) return;
		await database.insert(auditLog).values({
			action: entry.action,
			actorId: entry.actorId ?? "webui-admin",
			actorKind: entry.actorKind ?? "user",
			id: randomUUID(),
			occurredAt: new Date().toISOString(),
			...(entry.payload === undefined ? {} : { payloadJson: JSON.stringify(entry.payload) }),
			...(entry.reason === undefined ? {} : { reason: entry.reason }),
			result: entry.result,
			...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
			targetKind: entry.targetKind,
		});
	}

	/** Registers a synchronous shutdown callback. Used by services that hold the domain DB. */
	onStop(listener: () => void): () => void {
		this.stopListeners.add(listener);
		return () => this.stopListeners.delete(listener);
	}

	async stop(): Promise<void> {
		this.transition("stopping", "maintenance");
		this.githubAuth.close();
		this.backupDrills.stop();
		this.restartCoordinator.close();
		this.promptHooks.close();
		for (const listener of this.stopListeners) {
			try {
				listener();
			} catch (error) {
				this.runtimeLog.warn("shutdown listener failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.stopListeners.clear();
		this.pluginTasks.stop();
		this.schedules.stop();
		this.replyDispatcher.stopPendingReconciliation();
		await this.workspaceNative.dispose();
		await this.pluginHost.stop();
		await this.conversationHost?.close();
		await this.liveRuns.close();
		await this.cache.close();
		this.pluginDatabases.closeAll();
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
		this.runtimeLog.info("lifecycle stopped");
		this.removeFileSink?.();
		this.removeFileSink = undefined;
		this.dailyFileSink?.close();
		this.dailyFileSink = undefined;
	}
}

export { loadConfig };
