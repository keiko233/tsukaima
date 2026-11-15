import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	ConversationExecutionLock,
	ModelPolicyRouter,
	ModelUsageLedger,
	PiDurableConversationHost,
	createFakeModel,
	type ActivityWindowEvent,
	type LiveRunSnapshot,
	type ModelPort,
	type ModelPolicy,
} from "@tsukaima/core";
import {
	DomainCodingStore,
	NoopReloadController,
	SELF_ITERATION_HOST_BINDING,
} from "@tsukaima/coding";
import {
	auditLog,
	conversations,
	media,
	type TsukaimaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage, type SqliteStorage } from "@tsukaima/durable";
import { KeyvCache } from "@tsukaima/cache";
import { eq } from "drizzle-orm";
import { createPluginToolsExtension, type AuditEntry, type TsukaimaPlugin } from "@tsukaima/sdk";
import {
	MigrationRegistry,
	PluginDatabaseStore,
	loadPluginMigrations,
	migrateLegacyPluginTables,
	wrapPluginSqlConnection,
} from "@tsukaima/plugin-registry";
import { runBackupDrill as executeBackupDrill, type BackupDrillReport } from "@tsukaima/migration";
import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
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
import { readRuntimeSettings, type RuntimeSettings } from "./runtime-settings.ts";
import { builtinPlugins } from "./plugins/builtin.ts";
import {
	BackupDrillScheduler,
	type BackupDrillRunResult,
} from "./services/backup-drill-scheduler.ts";
import { ChannelRegistry } from "./services/channel-registry.ts";
import { ConversationPacingTracker } from "./services/conversation-pacing.ts";
import { ConversationPolicyService } from "./services/conversation-policy.ts";
import { ConversationRouter } from "./services/conversation-router.ts";
import { DrizzleContextProvider } from "./services/context-provider.ts";
import {
	MEMORY_SERVICE_BINDING,
	MemoryService,
	type MemoryEmbeddingOutput,
} from "./services/memory-service.ts";
import { MediaService } from "./services/media-service.ts";
import { HookBus } from "./services/hook-bus.ts";
import { PluginConversationService } from "./services/plugin-conversation-service.ts";
import { PluginHost } from "./services/plugin-host.ts";
import { PluginSettingsStore } from "./services/plugin-settings.ts";
import { PluginStatusStore } from "./services/plugin-status.ts";
import { PluginStorageStore } from "./services/plugin-storage.ts";
import { PluginTaskService } from "./services/plugin-task-service.ts";
import { ReplyDispatcher } from "./services/reply-dispatcher.ts";
import { SidechatService } from "./services/sidechat.ts";
import { LiveRunCache } from "./services/live-run-cache.ts";
import { RequestService } from "./services/request-service.ts";

/**
 * Minimum spacing between logged failures for one channel stage and conversation. Detached
 * inbound handlers can fail on every event, so the log needs a floor that still surfaces a
 * breakage immediately.
 */
const INBOUND_FAILURE_LOG_INTERVAL_MS = 60_000;

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
	readonly logger?: Logger;
	/** Test or embedding override for the model catalog and provider. */
	readonly model?: ModelPort | undefined;
	/** Opaque host bindings consumed by built-in plugins in tests or embedders. */
	readonly pluginBindings?: ReadonlyMap<string, unknown>;
	/** Overrides the built-in plugin set (tests and future plugin sources). */
	readonly plugins?: readonly TsukaimaPlugin[];
	/** Reply chunking, quote behavior, and pending-delivery reconciliation timing. */
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
	private readonly plugins: readonly TsukaimaPlugin[];
	readonly media: MediaService;
	readonly replyDispatcher: ReplyDispatcher;
	readonly requestService: RequestService;
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
	private activeProviderId: string | undefined;

	constructor(config: TsukaimaConfig, options?: LifecycleOptions) {
		this.config = config;
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
			blobsDir: join(config.dataDir, "blobs"),
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
		});
		this.conversationPacing = new ConversationPacingTracker();
		this.conversationPolicy = new ConversationPolicyService({
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			logger: this.runtimeLog,
		});
		this.conversationRouter = new ConversationRouter({
			applyModelToolPolicy: async (durableConversationId, policy) => {
				const codingTools = this.pluginHost.modelToolNames("self-iteration");
				if (codingTools.length === 0) return;
				await this.conversationHost?.updateModelTools(durableConversationId, {
					remove: policy.capabilities.includes("coding") ? [] : codingTools,
				});
			},
			audit: (entry) => this.writeAudit(entry),
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			ingestMedia: (part) => this.ingestInboundMedia(part),
			logger: this.runtimeLog,
			onInboundTrigger: (conversationId) =>
				this.replyDispatcher.cancelPendingOutput(conversationId),
			pacing: this.conversationPacing,
			policy: this.conversationPolicy,
		});
		this.contextProvider = new DrizzleContextProvider({
			database: () => this.domainDatabase,
			logger: this.runtimeLog,
			policyService: this.conversationPolicy,
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
			complete: (prompt, modelId) => this.completeMemoryPrompt(prompt, modelId),
			database: () => this.domainDatabase,
			embed: (texts) => this.embedMemoryTexts(texts),
			llmEnabled: () => this.memoryModel !== undefined && this.memoryModel.providerId !== "fake",
			logger: this.runtimeLog,
			policyService: this.conversationPolicy,
			tasks: this.pluginTasks,
		});
		this.memory.registerTaskHandlers(this.pluginTasks);
		this.hooks.on("after.reply", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const sessionId = (payload as { sessionId?: unknown }).sessionId;
			if (typeof sessionId !== "string") return;
			void this.memory.scheduleExtraction({ conversationId: sessionId });
			void this.memory.scheduleCompaction({ conversationId: sessionId });
		});
		this.replyDispatcher = new ReplyDispatcher({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			hooks: this.hooks,
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
		this.pluginConversations = new PluginConversationService({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
			lock: this.executionLock,
			logger: this.runtimeLog,
			policy: this.conversationPolicy,
			replyDispatcher: this.replyDispatcher,
		});
		const pluginBindings = new Map(options?.pluginBindings ?? []);
		pluginBindings.set(MEMORY_SERVICE_BINDING, this.memory);
		if (!pluginBindings.has(SELF_ITERATION_HOST_BINDING)) {
			pluginBindings.set(SELF_ITERATION_HOST_BINDING, {
				healthCheck: async () => ({ checkedAtMs: Date.now(), ok: this.ready }),
				reload: new NoopReloadController(),
				repositoryRoot: process.cwd(),
				store: new DomainCodingStore(() => this.domainDatabase),
				worktreeRoot: join(config.dataDir, "worktrees"),
			});
		}
		this.pluginHost = new PluginHost({
			audit: (entry) => this.writeAudit(entry),
			bindings: pluginBindings,
			cache: this.cache,
			channels: this.channels,
			conversationCapabilities: (conversationId) =>
				this.conversationPolicy.capabilitiesForDurableConversation(conversationId),
			conversations: this.pluginConversations,
			database: () => this.domainDatabase,
			hooks: this.hooks,
			logger: this.logger,
			migrations: this.pluginMigrations,
			media: this.media,
			pluginDatabases: this.pluginDatabases,
			onModelMessage: (message, pluginId) => {
				this.modelUsageLedger.record(
					message as Parameters<typeof this.modelUsageLedger.record>[0],
					`plugin:${pluginId}`,
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
			this.setLogLevel(this.config.logLevel);
			this.runtimeLog.debug("TSUKAIMA_LOG_LEVEL overrides persisted runtime setting", {
				envLogLevel: this.config.logLevel,
				persistedLogLevel: settings.logLevel,
			});
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
		this.sidechatService = new SidechatService({
			defaultModelId: async () =>
				this.domainDatabase === undefined
					? undefined
					: (await readRuntimeSettings(this.domainDatabase)).sidechatModelId,
			logger: this.logger,
			model: () => this.memoryModel,
		});
		if (settings.sidechatModelId === undefined) {
			this.runtimeLog.info("sidechat model is not configured; using the active model", {
				modelId: model.modelId,
			});
		}
		this.conversationHost = new PiDurableConversationHost({
			busyArbiter: async (input) => this.sidechatService?.decide(input),
			contextProvider: this.contextProvider,
			executionLock: this.executionLock,
			logger: this.logger.child("tsukaima::core::host"),
			model,
			onActivityEvent: (event) => this.forwardActivityEvent(event),
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
			onLiveRun: (state) => this.forwardLiveRun(state),
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
							trace: (message, fields) => {
								toolLog.trace(message, fields);
							},
						},
					);
		if (conversationHost !== undefined && pluginTools !== undefined) {
			// Install before plugins connect so inbound messages always resolve the extension;
			// the tool getter sees registrations as soon as each plugin's setup completes.
			conversationHost.installExtensions([pluginTools]);
		}
		this.transition("plugins");
		await this.pluginHost.start();
		this.pluginTasks.start();
		await this.memory.start();
		if (conversationHost !== undefined && pluginTools !== undefined) {
			// Reinstall after startup to reset per-conversation checks for sessions that received
			// a message while the extension still had no tools.
			conversationHost.installExtensions([pluginTools]);
		}

		try {
			await this.replyDispatcher.reconcilePendingDeliveries();
		} catch (error) {
			this.runtimeLog.warn("startup pending-delivery reconciliation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.replyDispatcher.startPendingReconciliation();
		this.backupDrills.start();
		this.transition("ready", "ready");
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
		this.runtimeLog.info("runtime settings applied", {
			logLevel: settings.logLevel,
			providerRestartRequired: this.providerRestartRequired,
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
		const response = await model.models.completeSimple(selected, {
			messages: [{ content: prompt, role: "user", timestamp: Date.now() }],
		});
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
	 * Store an inbound media part's bytes and rewrite the part to reference them.
	 *
	 * Channels hand over a remote URL or a platform file reference; nothing else fetches it. Until
	 * the bytes land in the media store, the transcript has nothing to render and the model only
	 * sees a placeholder.
	 */
	private async ingestInboundMedia(part: MessagePart): Promise<MessagePart> {
		if (part.type !== "image" && part.type !== "sticker") return part;
		// Already content-addressed: the bytes are here.
		if (part.sha256 !== undefined && /^[0-9a-f]{64}$/iu.test(part.sha256)) {
			const existing = await this.media.findBySha(part.sha256);
			if (existing !== undefined) {
				this.runtimeLog.trace("inbound media reused from store", {
					mediaId: existing.id,
					sha256: existing.sha256,
					type: part.type,
				});
				return {
					...part,
					mediaId: existing.id,
					mimeType: part.mimeType ?? existing.mimeType,
					sha256: existing.sha256,
					sizeBytes: part.sizeBytes ?? existing.sizeBytes,
				};
			}
		}
		if (part.sourceUrl === undefined) return part;
		const stored = await this.media.storeFromUrl(part.sourceUrl, {
			kind: part.type === "sticker" ? "sticker" : "image",
			...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
			source: "channel",
		});
		this.runtimeLog.debug("inbound media stored from channel url", {
			mediaId: stored.id,
			mimeType: stored.mimeType,
			sizeBytes: stored.sizeBytes,
			type: part.type,
		});
		return {
			...part,
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
			void this.memory.scheduleExtraction({
				activityId: event.activityId,
				durableConversationId: event.conversationId,
			});
			void this.memory.scheduleCompaction({ durableConversationId: event.conversationId });
		}
	}

	private async handleChannelNotice(channelId: string, notice: ChannelNotice): Promise<void> {
		try {
			const result = await this.conversationRouter.ingestNotice(notice);
			if (notice.noticeType === "poke" && notice.isSelfTarget === true && !result.duplicated) {
				this.runtimeLog.info("poke at bot received", {
					channelId,
					conversationKey: notice.conversationKey,
					senderId: notice.actorId,
				});
				await this.writeAudit({
					action: "channel.poke-at-bot",
					actorId: notice.actorId ?? "unknown",
					actorKind: "user",
					payload: { noticeId: notice.id, sessionId: result.sessionId },
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
		this.backupDrills.stop();
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
		this.replyDispatcher.stopPendingReconciliation();
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
