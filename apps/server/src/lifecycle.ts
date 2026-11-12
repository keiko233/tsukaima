import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type TsukaimaDatabase, migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import type { SqliteStorage } from "@tsukaima/durable";
import type { TsukaimaConfig } from "./config.ts";

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

	durableStorage?: SqliteStorage;
	domainDatabase?: TsukaimaDatabase;

	constructor(config: TsukaimaConfig) {
		this.config = config;
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
		this.transition("channel-adapters");
		this.transition("ready", "ready");
	}

	fail(reason: string): void {
		this.failureReason = reason;
		this.currentState = "failed";
		this.currentStage = "failed";
	}

	async stop(): Promise<void> {
		this.transition("stopping");
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
	}
}
