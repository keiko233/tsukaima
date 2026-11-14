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
} from "@elaina/core";
import {
	DomainCodingStore,
	NoopReloadController,
	SELF_ITERATION_HOST_BINDING,
} from "@elaina/coding";
import {
	auditLog,
	conversations,
	media,
	type ElainaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@elaina/db";
import { BACKGROUND_CONTEXT, openDurableStorage, type SqliteStorage } from "@elaina/durable";
import { eq } from "drizzle-orm";
import { createPluginToolsExtension, type AuditEntry, type ElainaPlugin } from "@elaina/sdk";
import { MigrationRegistry, type PluginMigrationPlan } from "@elaina/plugin-registry";
import { runBackupDrill as executeBackupDrill, type BackupDrillReport } from "@elaina/migration";
import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@elaina/contracts";
import { loadConfig, type ElainaConfig } from "./config.ts";
import { createLogger, LogBuffer, type Logger } from "./logging.ts";
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
	readonly plugins?: readonly ElainaPlugin[];
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

export class ElainaLifecycle {
	readonly config: ElainaConfig;
	readonly startedAtMs = Date.now();
	readonly backupDrills: BackupDrillScheduler;
	readonly channels: ChannelRegistry;
	readonly contextProvider: DrizzleContextProvider;
	readonly conversationPacing: ConversationPacingTracker;
	readonly conversationPolicy: ConversationPolicyService;
	readonly conversationRouter: ConversationRouter;
	readonly hooks: HookBus;
	readonly pluginHost: PluginHost;
	readonly pluginMigrations: MigrationRegistry;
	readonly pluginSettings: PluginSettingsStore;
	readonly pluginStatuses: PluginStatusStore;
	readonly pluginStorage: PluginStorageStore;
	readonly pluginTasks: PluginTaskService;
	readonly pluginConversations: PluginConversationService;
	/** One lock shared by inbound turns, outbound pacing, tasks, and background turns. */
	readonly executionLock: ConversationExecutionLock;
	readonly memory: MemoryService;
	private readonly plugins: readonly ElainaPlugin[];
	readonly media: MediaService;
	readonly replyDispatcher: ReplyDispatcher;
	readonly requestService: RequestService;
	private currentState: LifecycleState["state"] = "starting";
	private currentStage = "initialize";
	private failureReason: string | undefined;
	private readonly stopListeners = new Set<() => void>();

	conversationHost: PiDurableConversationHost | undefined;
	domainDatabase: ElainaDatabase | undefined;
	durableStorage: SqliteStorage | undefined;
	lastProcessingError: Error | undefined;
	logLevel: ElainaConfig["logLevel"];
	readonly logs: LogBuffer;
	readonly logger: Logger;
	readonly modelUsageLedger = new ModelUsageLedger();
	modelRouter: ModelPolicyRouter | undefined;
	private memoryModel: ModelPort | undefined;
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

	constructor(config: ElainaConfig, options?: LifecycleOptions) {
		this.config = config;
		this.logLevel = config.logLevel;
		this.logger =
			options?.logger ??
			createLogger({
				level: config.logLevel,
				target: "elaina::server",
			});
		this.logs = this.logger.buffer;
		this.plugins = options?.plugins ?? builtinPlugins;
		this.runtimeLog = this.logger.child("elaina::server::lifecycle");
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
		this.pluginMigrations = new MigrationRegistry({
			database: () => this.domainDatabase,
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
			channels: this.channels,
			conversationCapabilities: (conversationId) =>
				this.conversationPolicy.capabilitiesForDurableConversation(conversationId),
			conversations: this.pluginConversations,
			database: () => this.domainDatabase,
			hooks: this.hooks,
			logger: this.logger,
			migrations: this.pluginMigrations,
			media: this.media,
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

	private setLogLevel(level: ElainaConfig["logLevel"]): void {
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
		this.transition("durable-storage");
		this.durableStorage = await openDurableStorage(join(this.config.dataDir, "durable.sqlite"));
		this.transition("domain-database");
		this.domainDatabase = await openDomainDatabase(join(this.config.dataDir, "domain.sqlite"));
		migrateDomainDatabase(this.domainDatabase);
		this.transition("plugin-migrations");
		const pluginMigrations: PluginMigrationPlan[] = [];
		for (const plugin of this.plugins) {
			pluginMigrations.push({
				enabled: await this.pluginSettings.isEnabled(plugin.manifest.name),
				migrations: plugin.manifest.migrations.map((migration) => ({
					sql: migration.sql,
					version: migration.version,
					...(migration.checksum === undefined ? {} : { checksum: migration.checksum }),
					...(migration.rollbackSql === undefined ? {} : { rollbackSql: migration.rollbackSql }),
				})),
				pluginId: plugin.manifest.name,
			});
		}
		await this.pluginMigrations.migrate(pluginMigrations);
		this.transition("load-settings");
		const settings = await readRuntimeSettings(this.domainDatabase);
		this.setLogLevel(settings.logLevel);

		// Plugins register model providers during setup, which happens later in startup. The
		// host therefore prepares plugin surfaces first, then resolves the active provider.
		this.transition("plugins");
		await this.pluginHost.prepare();
		this.transition("domain-services");
		const model = await this.createModelPort(settings);
		this.memoryModel = model;
		this.activeProviderId = model.providerId;
		this.conversationHost = new PiDurableConversationHost({
			contextProvider: this.contextProvider,
			executionLock: this.executionLock,
			model,
			onActivityEvent: (event) => this.forwardActivityEvent(event),
			onAnswer: async (answer) => {
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
		const pluginTools =
			conversationHost === undefined
				? undefined
				: createPluginToolsExtension(
						() => this.pluginHost.tools(),
						(name, input, context) => this.pluginHost.invokeTool(name, input, context),
						{
							audit: (entry) => this.writeAudit(entry),
							logger: (message, error) => {
								this.runtimeLog.warn(message, {
									error: error instanceof Error ? error.message : String(error),
								});
							},
							policyContext: (tool, context) => this.pluginHost.toolPolicyContext(tool, context),
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

	async applyRuntimeSettings(settings: RuntimeSettings): Promise<void> {
		this.setLogLevel(settings.logLevel);
		const requestedProviderId = settings.modelProviderId;
		this.providerRestartRequired =
			requestedProviderId !== undefined && requestedProviderId !== this.activeProviderId;
		this.runtimeLog.info("runtime settings applied", {
			logLevel: settings.logLevel,
			providerRestartRequired: this.providerRestartRequired,
		});
	}

	/** Apply configuration for a built-in plugin; plugins react through `settings.onChange`. */
	async updatePluginConfig(pluginId: string, patch: Record<string, unknown>): Promise<void> {
		await this.pluginHost.applySettings(pluginId, patch);
	}

	async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
		await this.pluginHost.setEnabled(pluginId, enabled);
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
		const response = await model.models.completeSimple(selected, {
			messages: [{ content: prompt, role: "user", timestamp: Date.now() }],
		});
		return response.content
			.filter(
				(part): part is { readonly text: string; readonly type: "text" } => part.type === "text",
			)
			.map((part) => part.text)
			.join("");
	}

	/** Embed through the first configured plugin provider; silently degrades when absent. */
	private async embedMemoryTexts(
		texts: readonly string[],
	): Promise<MemoryEmbeddingOutput | undefined> {
		try {
			for (const provider of this.pluginHost.modelProviders()) {
				const result =
					provider.embed !== undefined
						? await provider.embed({ texts })
						: provider.embedding === undefined
							? undefined
							: await provider.embedding.embed({ texts });
				if (result !== undefined) {
					return { modelId: result.modelId, vectors: result.vectors };
				}
			}
		} catch {
			// Embedding is optional; callers fall back to lexical/recency ranking.
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
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
		this.runtimeLog.info("lifecycle stopped");
	}
}

export { loadConfig };
