import { randomUUID } from "node:crypto";
import type { PluginContext } from "@tsukaima/sdk";

export type StickerJobKind =
	| "telegram.import"
	| "packs.importDir"
	| "packs.importBundle"
	| "packs.importDsh"
	| "semantic.reclassify";

export type StickerJobStage =
	| "fetching"
	| "downloading"
	| "converting"
	| "classifying"
	| "saving"
	| "done"
	| "error";

export type StickerJobStatus = "running" | "completed" | "failed";

export interface StickerJobProgress {
	readonly classified: number;
	readonly current: number;
	readonly currentItem?: string;
	readonly dryRun: boolean;
	readonly error?: string;
	readonly finishedAt?: string;
	readonly id: string;
	readonly kind: StickerJobKind;
	readonly packTitle?: string;
	readonly skipped: number;
	readonly stage: StickerJobStage;
	readonly startedAt: string;
	readonly status: StickerJobStatus;
	readonly total: number | null;
	readonly updatedAt: string;
}

export interface StickerProgressUpdate {
	readonly classified?: number;
	readonly current?: number;
	readonly currentItem?: string;
	readonly packTitle?: string;
	readonly skipped?: number;
	readonly stage?: StickerJobStage;
	readonly total?: number | null;
}

function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/\/bot\d+:[^/\s]+/giu, "/bot[REDACTED]");
}

export class StickerProgressTracker {
	readonly #context: PluginContext | undefined;
	readonly #onSettled: (() => Promise<void>) | undefined;
	#job: StickerJobProgress | null = null;
	#lastStatusPushMs = 0;

	constructor(
		options: {
			readonly context?: PluginContext;
			readonly onSettled?: () => Promise<void>;
		} = {},
	) {
		this.#context = options.context;
		this.#onSettled = options.onSettled;
	}

	current(): StickerJobProgress | null {
		return this.#job === null ? null : { ...this.#job };
	}

	start(input: {
		readonly dryRun?: boolean;
		readonly kind: StickerJobKind;
		readonly packTitle?: string;
		readonly stage?: StickerJobStage;
		readonly total?: number | null;
	}): string {
		const now = new Date().toISOString();
		const id = randomUUID();
		this.#job = {
			classified: 0,
			current: 0,
			dryRun: input.dryRun === true,
			id,
			kind: input.kind,
			...(input.packTitle === undefined ? {} : { packTitle: input.packTitle }),
			skipped: 0,
			stage: input.stage ?? "fetching",
			startedAt: now,
			status: "running",
			total: input.total ?? null,
			updatedAt: now,
		};
		this.#pushHostStatus(true);
		return id;
	}

	update(jobId: string, patch: StickerProgressUpdate): void {
		if (this.#job === null || this.#job.id !== jobId || this.#job.status !== "running") return;
		this.#job = {
			...this.#job,
			...(patch.classified === undefined ? {} : { classified: patch.classified }),
			...(patch.current === undefined ? {} : { current: patch.current }),
			...(patch.currentItem === undefined ? {} : { currentItem: patch.currentItem }),
			...(patch.packTitle === undefined ? {} : { packTitle: patch.packTitle }),
			...(patch.skipped === undefined ? {} : { skipped: patch.skipped }),
			...(patch.stage === undefined ? {} : { stage: patch.stage }),
			...(patch.total === undefined ? {} : { total: patch.total }),
			updatedAt: new Date().toISOString(),
		};
		this.#pushHostStatus(false);
	}

	async complete(jobId: string, patch: StickerProgressUpdate = {}): Promise<void> {
		if (this.#job === null || this.#job.id !== jobId) return;
		const now = new Date().toISOString();
		const total = patch.total !== undefined ? patch.total : this.#job.total;
		this.#job = {
			...this.#job,
			...(patch.classified === undefined ? {} : { classified: patch.classified }),
			...(patch.current === undefined
				? total !== null
					? { current: total }
					: {}
				: { current: patch.current }),
			...(patch.currentItem === undefined ? {} : { currentItem: patch.currentItem }),
			...(patch.packTitle === undefined ? {} : { packTitle: patch.packTitle }),
			...(patch.skipped === undefined ? {} : { skipped: patch.skipped }),
			finishedAt: now,
			stage: "done",
			status: "completed",
			...(total === undefined ? {} : { total }),
			updatedAt: now,
		};
		await this.#settleStatus();
	}

	async fail(jobId: string, error: unknown): Promise<void> {
		if (this.#job === null || this.#job.id !== jobId) return;
		const now = new Date().toISOString();
		this.#job = {
			...this.#job,
			error: errorMessage(error),
			finishedAt: now,
			stage: "error",
			status: "failed",
			updatedAt: now,
		};
		await this.#settleStatus();
	}

	#pushHostStatus(force: boolean): void {
		if (this.#context === undefined || this.#job === null) return;
		const nowMs = Date.now();
		if (!force && nowMs - this.#lastStatusPushMs < 250) return;
		this.#lastStatusPushMs = nowMs;
		const job = this.#job;
		const labelParts = [job.kind, job.packTitle, job.stage, job.currentItem].filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
		this.#context.ui.setStatus({
			code: "job_running",
			level: "ok",
			progress: {
				current: job.current,
				label: labelParts.join(" · ").slice(0, 512),
				...(job.total !== null && job.total > 0 ? { total: job.total } : {}),
			},
			summary:
				job.total !== null && job.total > 0
					? `${job.kind}: ${job.current}/${job.total}`
					: `${job.kind}: ${job.stage}`,
		});
	}

	async #settleStatus(): Promise<void> {
		if (this.#onSettled === undefined) return;
		try {
			await this.#onSettled();
		} catch {}
	}
}
