import { randomUUID } from "node:crypto";
import type { PluginContext } from "@elaina/sdk";

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

export interface StickerProgressSnapshot {
	/** Latest running job, or the most recently started job when nothing is running. */
	readonly active: StickerJobProgress | null;
	/** Active jobs plus recently settled jobs, newest first. */
	readonly jobs: readonly StickerJobProgress[];
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

const MAX_SETTLED_JOBS = 10;

function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/\/bot\d+:[^/\s]+/giu, "/bot[REDACTED]");
}

/**
 * Tracks every import/classification job independently so Telegram imports, pack imports, and
 * semantic reclassification can run at the same time without clobbering each other's progress.
 */
export class StickerProgressTracker {
	readonly #context: PluginContext | undefined;
	readonly #jobs = new Map<string, StickerJobProgress>();
	readonly #onSettled: (() => Promise<void>) | undefined;
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

	/** Backwards-compatible alias for the snapshot's `active` job. */
	current(): StickerJobProgress | null {
		return this.active();
	}

	active(): StickerJobProgress | null {
		const jobs = [...this.#jobs.values()];
		const running = jobs.filter((job) => job.status === "running");
		const job = running.at(-1) ?? jobs.at(-1);
		return job === undefined ? null : { ...job };
	}

	jobs(): readonly StickerJobProgress[] {
		return [...this.#jobs.values()].toReversed().map((job) => ({ ...job }));
	}

	snapshot(): StickerProgressSnapshot {
		return { active: this.active(), jobs: this.jobs() };
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
		this.#jobs.set(id, {
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
		});
		this.#pruneSettled();
		this.#pushHostStatus(true);
		return id;
	}

	update(jobId: string, patch: StickerProgressUpdate): void {
		const job = this.#jobs.get(jobId);
		if (job === undefined || job.status !== "running") return;
		this.#jobs.set(jobId, {
			...job,
			...(patch.classified === undefined ? {} : { classified: patch.classified }),
			...(patch.current === undefined ? {} : { current: patch.current }),
			...(patch.currentItem === undefined ? {} : { currentItem: patch.currentItem }),
			...(patch.packTitle === undefined ? {} : { packTitle: patch.packTitle }),
			...(patch.skipped === undefined ? {} : { skipped: patch.skipped }),
			...(patch.stage === undefined ? {} : { stage: patch.stage }),
			...(patch.total === undefined ? {} : { total: patch.total }),
			updatedAt: new Date().toISOString(),
		});
		this.#pushHostStatus(false);
	}

	async complete(jobId: string, patch: StickerProgressUpdate = {}): Promise<void> {
		const job = this.#jobs.get(jobId);
		if (job === undefined) return;
		const now = new Date().toISOString();
		const total = patch.total !== undefined ? patch.total : job.total;
		this.#jobs.set(jobId, {
			...job,
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
		});
		this.#pruneSettled();
		await this.#settleStatus();
	}

	async fail(jobId: string, error: unknown): Promise<void> {
		const job = this.#jobs.get(jobId);
		if (job === undefined) return;
		const now = new Date().toISOString();
		this.#jobs.set(jobId, {
			...job,
			error: errorMessage(error),
			finishedAt: now,
			stage: "error",
			status: "failed",
			updatedAt: now,
		});
		this.#pruneSettled();
		await this.#settleStatus();
	}

	#runningJobs(): readonly StickerJobProgress[] {
		return [...this.#jobs.values()].filter((job) => job.status === "running");
	}

	#pruneSettled(): void {
		const settled = [...this.#jobs.entries()].filter(([, job]) => job.status !== "running");
		const overflow = settled.length - MAX_SETTLED_JOBS;
		if (overflow <= 0) return;
		for (const [id] of settled.slice(0, overflow)) this.#jobs.delete(id);
	}

	#pushHostStatus(force: boolean): void {
		if (this.#context === undefined) return;
		const running = this.#runningJobs();
		const job = running.at(-1);
		if (job === undefined) return;
		const nowMs = Date.now();
		if (!force && nowMs - this.#lastStatusPushMs < 250) return;
		this.#lastStatusPushMs = nowMs;
		const labelParts = [
			job.kind,
			running.length > 1 ? `+${running.length - 1}` : undefined,
			job.packTitle,
			job.stage,
			job.currentItem,
		].filter((part): part is string => typeof part === "string" && part.length > 0);
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
		if (this.#runningJobs().length > 0) {
			this.#pushHostStatus(true);
			return;
		}
		if (this.#onSettled === undefined) return;
		try {
			await this.#onSettled();
		} catch {}
	}
}
