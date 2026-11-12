import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
	ModelPolicyRouter,
	ModelUsageLedger,
	PiDurableConversationHost,
	createFakeModel,
	createOpenAICompatibleModelPort,
	type ModelPort,
	type ModelPolicy,
} from "@elaina/core";
import {
	conversations,
	type ElainaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@elaina/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@elaina/durable";
import type { SqliteStorage } from "@elaina/durable";
import { OneBotChannel } from "@elaina/onebot";
import type { OneBotTransportFactory } from "@elaina/onebot";
import { loadConfig, type ElainaConfig } from "./config.ts";
import { readRuntimeSettings, type RuntimeSettings } from "./runtime-settings.ts";
import type { MessageEnvelope } from "@elaina/contracts";

export interface LifecycleOptions {
	readonly onebotTransportFactory?: OneBotTransportFactory;
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
	private currentState: LifecycleState["state"] = "starting";
	private currentStage = "initialize";
	private failureReason: string | undefined;
	private onebotTransportFactory: OneBotTransportFactory | undefined;

	conversationHost: PiDurableConversationHost | undefined;
	domainDatabase: ElainaDatabase | undefined;
	durableStorage: SqliteStorage | undefined;
	lastProcessingError: Error | undefined;
	logLevel: ElainaConfig["logLevel"];
	readonly modelUsageLedger = new ModelUsageLedger();
	modelRouter: ModelPolicyRouter | undefined;
	onebotChannel: OneBotChannel | undefined;
	onebotRestartRequired = false;
	processedMessageCount = 0;
	providerRestartRequired = false;
	routingPolicies: readonly ModelPolicy[] = [];
	private activeOneBotSettings: Pick<RuntimeSettings, "onebotAccessToken" | "onebotWsUrl"> = {};
	private activeProviderSettings: Pick<
		RuntimeSettings,
		"openAiApiKey" | "openAiBaseUrl" | "openAiModelId"
	> = {};

	constructor(config: ElainaConfig, options?: LifecycleOptions) {
		this.config = config;
		this.logLevel = config.logLevel;
		if (options?.onebotTransportFactory !== undefined) {
			this.onebotTransportFactory = options.onebotTransportFactory;
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

	private transition(stage: string, state: LifecycleState["state"] = "starting"): void {
		this.currentStage = stage;
		this.currentState = state;
		this.log("info", stage);
	}

	private log(level: ElainaConfig["logLevel"], message?: string): void {
		const priority = { debug: 0, error: 3, info: 1, warn: 2 } as const;
		if (priority[level] < priority[this.logLevel]) return;
		const payload = {
			level,
			message: message ?? this.currentStage,
			stage: this.currentStage,
			timestamp: new Date().toISOString(),
		};
		if (level === "error") console.error(JSON.stringify(payload));
		else if (level === "warn") console.warn(JSON.stringify(payload));
		else console.log(JSON.stringify(payload));
	}

	private createModelPort(settings: RuntimeSettings): ModelPort {
		const openAiApiKey = settings.openAiApiKey ?? this.config.openAiApiKey;
		const openAiBaseUrl = settings.openAiBaseUrl ?? this.config.openAiBaseUrl;
		const openAiModelId = settings.openAiModelId ?? this.config.openAiModelId;
		if (openAiBaseUrl === undefined || openAiApiKey === undefined || openAiModelId === undefined) {
			this.log("info", "OpenAI-compatible provider not configured; using fake model");
			return createFakeModel({
				onMessage: (message) => {
					this.modelUsageLedger.record(message, "basic-chat");
				},
			});
		}
		return createOpenAICompatibleModelPort(
			{
				apiKey: openAiApiKey,
				baseUrl: openAiBaseUrl,
				onMessage: (message) => {
					this.modelUsageLedger.record(message, "basic-chat");
				},
				providerId: "openai-compatible",
			},
			[{ capabilities: ["basic-chat", "tool-use"], modelId: openAiModelId }],
		);
	}

	async start(): Promise<void> {
		this.transition("prepare-directories");
		await mkdir(join(this.config.dataDir, "blobs"), { recursive: true });
		this.transition("durable-storage");
		this.durableStorage = await openDurableStorage(join(this.config.dataDir, "durable.sqlite"));
		this.transition("domain-database");
		this.domainDatabase = await openDomainDatabase(join(this.config.dataDir, "domain.sqlite"));
		migrateDomainDatabase(this.domainDatabase);
		this.transition("load-settings");
		const settings = await readRuntimeSettings(this.domainDatabase);
		this.logLevel = settings.logLevel;

		this.transition("domain-services");
		const model = this.createModelPort(settings);
		const activeOpenAiApiKey = settings.openAiApiKey ?? this.config.openAiApiKey;
		const activeOpenAiBaseUrl = settings.openAiBaseUrl ?? this.config.openAiBaseUrl;
		const activeOpenAiModelId = settings.openAiModelId ?? this.config.openAiModelId;
		this.activeProviderSettings = {
			...(activeOpenAiApiKey === undefined ? {} : { openAiApiKey: activeOpenAiApiKey }),
			...(activeOpenAiBaseUrl === undefined ? {} : { openAiBaseUrl: activeOpenAiBaseUrl }),
			...(activeOpenAiModelId === undefined ? {} : { openAiModelId: activeOpenAiModelId }),
		};
		this.conversationHost = new PiDurableConversationHost({
			model,
			storage: this.durableStorage,
		});
		const models = model.models.getModels(model.providerId);
		this.modelRouter = new ModelPolicyRouter(models);
		this.routingPolicies = [
			{
				capability: "basic-chat",
				primary: { modelId: model.modelId, providerId: model.providerId },
			},
		];

		this.transition("channel-adapters");
		await this.replaceOneBotChannel(settings);

		this.transition("ready", "ready");
	}

	fail(reason: string): void {
		this.failureReason = reason;
		this.currentState = "failed";
		this.currentStage = "failed";
		this.log("error", reason);
	}

	async applyRuntimeSettings(settings: RuntimeSettings): Promise<void> {
		this.logLevel = settings.logLevel;
		this.onebotRestartRequired =
			settings.onebotWsUrl !== this.activeOneBotSettings.onebotWsUrl ||
			settings.onebotAccessToken !== this.activeOneBotSettings.onebotAccessToken;
		this.providerRestartRequired =
			settings.openAiApiKey !== this.activeProviderSettings.openAiApiKey ||
			settings.openAiBaseUrl !== this.activeProviderSettings.openAiBaseUrl ||
			settings.openAiModelId !== this.activeProviderSettings.openAiModelId;
	}

	private async replaceOneBotChannel(settings: RuntimeSettings): Promise<void> {
		this.onebotChannel?.stop();
		this.onebotChannel = undefined;
		this.activeOneBotSettings = {
			...(settings.onebotAccessToken === undefined
				? {}
				: { onebotAccessToken: settings.onebotAccessToken }),
			...(settings.onebotWsUrl === undefined ? {} : { onebotWsUrl: settings.onebotWsUrl }),
		};
		if (settings.onebotWsUrl === undefined) {
			return;
		}
		try {
			const channel = new OneBotChannel(
				{
					botAccountId: "elaina-server",
					channelId: "onebot",
					reconnect: { initialDelayMs: 1_000, jitterRatio: 0.1, maxDelayMs: 30_000 },
					url: settings.onebotWsUrl,
					...(settings.onebotAccessToken !== undefined
						? { accessToken: settings.onebotAccessToken }
						: {}),
				},
				this.onebotTransportFactory,
			);
			channel.onMessage(async (envelope) => {
				await this.processEnvelope(envelope);
			});
			await channel.start();
			this.onebotChannel = channel;
			this.onebotRestartRequired = false;
		} catch (error) {
			this.onebotRestartRequired = true;
			this.log(
				"error",
				`OneBot channel failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async processEnvelope(envelope: MessageEnvelope): Promise<void> {
		try {
			const conversationId = await this.resolveConversationId(envelope);
			if (this.conversationHost === undefined) {
				throw new Error("Conversation host is not ready");
			}
			await this.conversationHost.append({
				conversationId,
				envelope,
				submittedAtMs: Date.now(),
			});
			this.processedMessageCount += 1;
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			this.log("error", "Failed to process channel message");
			throw error;
		}
	}

	private async resolveConversationId(envelope: MessageEnvelope): Promise<string> {
		if (this.conversationHost === undefined || this.domainDatabase === undefined) {
			throw new Error("Conversation host or domain database is not ready");
		}
		const kind = envelope.conversationKey.kind;
		if (kind !== "private" && kind !== "group") {
			return this.conversationHost.createConversation();
		}
		const platformConversationId =
			kind === "group" ? envelope.conversationKey.groupId : envelope.conversationKey.peerId;
		if (platformConversationId === undefined) {
			return this.conversationHost.createConversation();
		}
		const database = this.domainDatabase;
		const findExisting = async () => {
			const [row] = await database
				.select({ durableConversationId: conversations.durableConversationId })
				.from(conversations)
				.where(
					and(
						eq(conversations.channelId, envelope.channelId),
						eq(conversations.platformConversationId, platformConversationId),
					),
				)
				.limit(1);
			return row?.durableConversationId;
		};
		const existing = await findExisting();
		if (existing !== undefined) {
			return existing;
		}
		const durableConversationId = await this.conversationHost.createConversation();
		await database
			.insert(conversations)
			.values({
				channelId: envelope.channelId,
				durableConversationId,
				id: randomUUID(),
				kind,
				platformConversationId,
				title: kind === "group" ? `Group ${platformConversationId}` : envelope.sender.displayName,
			})
			.onConflictDoNothing();
		return (await findExisting()) ?? durableConversationId;
	}

	async stop(): Promise<void> {
		this.transition("stopping", "maintenance");
		this.onebotChannel?.stop();
		await this.conversationHost?.close();
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
	}
}

export { loadConfig };
