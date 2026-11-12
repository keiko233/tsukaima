import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	ModelPolicyRouter,
	PiDurableConversationHost,
	createFakeModel,
	createOpenAICompatibleModelPort,
	type ModelPort,
	type ModelPolicy,
} from "@tsukaima/core";
import { type TsukaimaDatabase, migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import type { SqliteStorage } from "@tsukaima/durable";
import { OneBotChannel } from "@tsukaima/onebot";
import type { OneBotTransportFactory } from "@tsukaima/onebot";
import { loadConfig, type TsukaimaConfig } from "./config.ts";
import { readRuntimeSettings, type RuntimeSettings } from "./runtime-settings.ts";

export interface LifecycleOptions {
	readonly onebotTransportFactory?: OneBotTransportFactory;
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
	private currentState: LifecycleState["state"] = "starting";
	private currentStage = "initialize";
	private failureReason: string | undefined;
	private onebotTransportFactory: OneBotTransportFactory | undefined;

	conversationHost: PiDurableConversationHost | undefined;
	domainDatabase: TsukaimaDatabase | undefined;
	durableStorage: SqliteStorage | undefined;
	lastProcessingError: Error | undefined;
	logLevel: TsukaimaConfig["logLevel"];
	modelRouter: ModelPolicyRouter | undefined;
	onebotChannel: OneBotChannel | undefined;
	onebotRestartRequired = false;
	processedMessageCount = 0;
	routingPolicies: readonly ModelPolicy[] = [];
	private activeOneBotSettings: Pick<RuntimeSettings, "onebotAccessToken" | "onebotWsUrl"> = {};

	constructor(config: TsukaimaConfig, options?: LifecycleOptions) {
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

	private log(level: TsukaimaConfig["logLevel"], message?: string): void {
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

	private createModelPort(): ModelPort {
		const { openAiApiKey, openAiBaseUrl, openAiModelId } = this.config;
		if (openAiBaseUrl === undefined || openAiApiKey === undefined || openAiModelId === undefined) {
			this.log("info", "OpenAI-compatible provider not configured; using fake model");
			return createFakeModel();
		}
		return createOpenAICompatibleModelPort(
			{ apiKey: openAiApiKey, baseUrl: openAiBaseUrl, providerId: "openai-compatible" },
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
		const model = this.createModelPort();
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
					botAccountId: "tsukaima-server",
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
				try {
					if (this.conversationHost === undefined) return;
					const conversationId = await this.conversationHost.createConversation();
					await this.conversationHost.append({
						conversationId,
						envelope,
						submittedAtMs: Date.now(),
					});
					this.processedMessageCount += 1;
				} catch (error) {
					this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
					this.log("error", "Failed to process OneBot message");
				}
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

	async stop(): Promise<void> {
		this.transition("stopping", "maintenance");
		this.onebotChannel?.stop();
		await this.conversationHost?.close();
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
	}
}

export { loadConfig };
