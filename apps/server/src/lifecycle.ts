import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	ModelPolicyRouter,
	ModelUsageLedger,
	PiDurableConversationHost,
	createFakeModel,
	type ActivityWindowEvent,
	type ModelPort,
	type ModelPolicy,
} from "@tsukaima/core";
import {
	auditLog,
	conversations,
	type TsukaimaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage, type SqliteStorage } from "@tsukaima/durable";
import { createPluginToolsExtension, type AuditEntry, type TsukaimaPlugin } from "@tsukaima/sdk";
import { MigrationRegistry, type PluginMigrationPlan } from "@tsukaima/plugin-registry";
import type { ChannelNotice, ChannelRequest, MessageEnvelope } from "@tsukaima/contracts";
import { loadConfig, type TsukaimaConfig } from "./config.ts";
import { createLogger, LogBuffer, type Logger } from "./logging.ts";
import { readRuntimeSettings, type RuntimeSettings } from "./runtime-settings.ts";
import { builtinPlugins } from "./plugins/builtin.ts";
import { ChannelRegistry } from "./services/channel-registry.ts";
import { ConversationPacingTracker } from "./services/conversation-pacing.ts";
import { ConversationPolicyService } from "./services/conversation-policy.ts";
import { ConversationRouter } from "./services/conversation-router.ts";
import { DrizzleContextProvider } from "./services/context-provider.ts";
import { MediaService } from "./services/media-service.ts";
import { HookBus } from "./services/hook-bus.ts";
import { PluginHost } from "./services/plugin-host.ts";
import { PluginSettingsStore } from "./services/plugin-settings.ts";
import { PluginStatusStore } from "./services/plugin-status.ts";
import { PluginStorageStore } from "./services/plugin-storage.ts";
import { PluginTaskService } from "./services/plugin-task-service.ts";
import { ReplyDispatcher } from "./services/reply-dispatcher.ts";
import { RequestService } from "./services/request-service.ts";

export interface LifecycleOptions {
	/** Process environment, used for plugin `configEnv` fallbacks. */
	readonly env?: Record<string, string | undefined>;
	readonly logger?: Logger;
	/** Test or embedding override for the model catalog and provider. */
	readonly model?: ModelPort;
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
	private readonly plugins: readonly TsukaimaPlugin[];
	readonly media: MediaService;
	readonly replyDispatcher: ReplyDispatcher;
	readonly requestService: RequestService;
	private currentState: LifecycleState["state"] = "starting";
	private currentStage = "initialize";
	private failureReason: string | undefined;
	private readonly stopListeners = new Set<() => void>();

	conversationHost: PiDurableConversationHost | undefined;
	domainDatabase: TsukaimaDatabase | undefined;
	durableStorage: SqliteStorage | undefined;
	lastProcessingError: Error | undefined;
	logLevel: TsukaimaConfig["logLevel"];
	readonly logs: LogBuffer;
	readonly logger: Logger;
	readonly modelUsageLedger = new ModelUsageLedger();
	modelRouter: ModelPolicyRouter | undefined;
	processedMessageCount = 0;
	providerRestartRequired = false;
	routingPolicies: readonly ModelPolicy[] = [];
	private readonly runtimeLog: Logger;
	private readonly modelOverride: ModelPort | undefined;
	private activeProviderId: string | undefined;

	constructor(config: TsukaimaConfig, options?: LifecycleOptions) {
		this.config = config;
		this.logLevel = config.logLevel;
		this.logger =
			options?.logger ??
			createLogger({
				level: config.logLevel,
				target: "tsukaima::server",
			});
		this.logs = this.logger.buffer;
		this.plugins = options?.plugins ?? builtinPlugins;
		this.runtimeLog = this.logger.child("tsukaima::server::lifecycle");
		this.modelOverride = options?.model;
		this.hooks = new HookBus(this.logger);
		this.channels = new ChannelRegistry({
			onEnvelope: (channelId, envelope) => {
				void this.handleChannelEnvelope(channelId, envelope).catch(() => undefined);
			},
			onNotice: (channelId, notice) => {
				void this.handleChannelNotice(channelId, notice).catch(() => undefined);
			},
			onRequest: (channelId, request) => {
				void this.handleChannelRequest(channelId, request).catch(() => undefined);
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
			audit: (entry) => this.writeAudit(entry),
			database: () => this.domainDatabase,
			host: () => this.conversationHost,
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
			logger: this.runtimeLog,
		});
		this.replyDispatcher = new ReplyDispatcher({
			audit: (entry) => this.writeAudit(entry),
			channels: this.channels,
			database: () => this.domainDatabase,
			hooks: this.hooks,
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
		this.pluginHost = new PluginHost({
			audit: (entry) => this.writeAudit(entry),
			...(options?.pluginBindings === undefined ? {} : { bindings: options.pluginBindings }),
			channels: this.channels,
			database: () => this.domainDatabase,
			hooks: this.hooks,
			logger: this.logger,
			migrations: this.pluginMigrations,
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
		this.activeProviderId = model.providerId;
		this.conversationHost = new PiDurableConversationHost({
			contextProvider: this.contextProvider,
			model,
			onActivityEvent: (event) => this.forwardActivityEvent(event),
			onAnswer: (answer) => this.replyDispatcher.handleAnswer(answer),
			storage: this.durableStorage,
		});
		const persistedSessions = await this.domainDatabase
			.select({ durableConversationId: conversations.durableConversationId })
			.from(conversations);
		for (const session of persistedSessions) {
			await this.conversationHost.resumeActivityWindow(session.durableConversationId);
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
		this.transition("ready", "ready");
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

	private async handleChannelEnvelope(channelId: string, envelope: MessageEnvelope): Promise<void> {
		try {
			const result = await this.conversationRouter.ingest(envelope);
			if (!result.duplicated && !result.ignored) {
				this.processedMessageCount += 1;
				this.hooks.emitDetached("message.received", {
					channelId,
					chatObjectId: result.chatObjectId,
					classification: result.classification,
					envelope,
					sessionId: result.sessionId,
				});
			}
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
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
