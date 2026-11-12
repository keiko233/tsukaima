import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PiDurableConversationHost, ModelPolicyRouter, createFakeModel } from "@elaina/core";
import type { ModelPolicy } from "@elaina/core";
import { type ElainaDatabase, migrateDomainDatabase, openDomainDatabase } from "@elaina/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@elaina/durable";
import type { SqliteStorage } from "@elaina/durable";
import { OneBotChannel } from "@elaina/onebot";
import type { OneBotTransportFactory } from "@elaina/onebot";
import type { ElainaConfig } from "./config.ts";

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
	modelRouter: ModelPolicyRouter | undefined;
	onebotChannel: OneBotChannel | undefined;
	processedMessageCount = 0;
	routingPolicies: readonly ModelPolicy[] = [];

	constructor(config: ElainaConfig, options?: LifecycleOptions) {
		this.config = config;
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
	}

	async start(): Promise<void> {
		this.transition("prepare-directories");
		await mkdir(join(this.config.dataDir, "blobs"), { recursive: true });
		this.transition("durable-storage");
		this.durableStorage = await openDurableStorage(join(this.config.dataDir, "durable.sqlite"));
		this.transition("domain-database");
		this.domainDatabase = await openDomainDatabase(join(this.config.dataDir, "domain.sqlite"));
		migrateDomainDatabase(this.domainDatabase);
		this.transition("domain-services");

		const model = createFakeModel();
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
		if (this.config.onebotWsUrl) {
			try {
				this.onebotChannel = new OneBotChannel(
					{
						botAccountId: "elaina-server",
						channelId: "onebot",
						reconnect: { initialDelayMs: 1_000, jitterRatio: 0.1, maxDelayMs: 30_000 },
						url: this.config.onebotWsUrl,
						...(this.config.onebotAccessToken !== undefined
							? { accessToken: this.config.onebotAccessToken }
							: {}),
					},
					this.onebotTransportFactory,
				);
				this.onebotChannel.onMessage(async (envelope) => {
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
						console.error("Failed to process OneBot message:", error);
					}
				});
				await this.onebotChannel.start();
			} catch (error) {
				console.error("OneBot channel failed to initialize:", error);
			}
		}

		this.transition("ready", "ready");
	}

	fail(reason: string): void {
		this.failureReason = reason;
		this.currentState = "failed";
		this.currentStage = "failed";
	}

	async stop(): Promise<void> {
		this.transition("stopping", "maintenance");
		this.onebotChannel?.stop();
		await this.conversationHost?.close();
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
	}
}
