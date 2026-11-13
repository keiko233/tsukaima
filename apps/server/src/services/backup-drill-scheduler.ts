import type { Logger } from "../logging.ts";

export interface BackupDrillRunResult {
	readonly ok: boolean;
	readonly runId?: string;
	readonly reportPath?: string;
	readonly error?: string;
}

export interface BackupDrillSchedulerOptions {
	/** Zero or a negative value leaves the scheduler disabled. */
	readonly intervalMs: number;
	readonly logger: Logger;
	readonly run: () => Promise<BackupDrillRunResult>;
}

/**
 * Runs backup/restore drills on a fixed interval. It is opt-in: the lifecycle only starts it
 * when `ELAINA_BACKUP_DRILL_INTERVAL_MS` (or an embedding option) is configured, and an
 * overlapping interval is skipped rather than queued. Operators can always trigger a drill
 * explicitly through the lifecycle method or the `ops:backup-drill` CLI.
 */
export class BackupDrillScheduler {
	readonly #intervalMs: number;
	readonly #logger: Logger;
	readonly #run: () => Promise<BackupDrillRunResult>;
	#timer: ReturnType<typeof setInterval> | undefined;
	#running = false;
	#lastResult: BackupDrillRunResult | undefined;
	#lastRunAtMs: number | undefined;

	constructor(options: BackupDrillSchedulerOptions) {
		this.#intervalMs = options.intervalMs;
		this.#logger = options.logger;
		this.#run = options.run;
	}

	get enabled(): boolean {
		return this.#intervalMs > 0;
	}

	get running(): boolean {
		return this.#timer !== undefined;
	}

	get lastResult(): BackupDrillRunResult | undefined {
		return this.#lastResult;
	}

	get lastRunAtMs(): number | undefined {
		return this.#lastRunAtMs;
	}

	start(): void {
		if (!this.enabled || this.#timer !== undefined) return;
		this.#timer = setInterval(() => {
			void this.trigger();
		}, this.#intervalMs);
		this.#timer.unref?.();
		this.#logger.info("backup drill scheduler started", { intervalMs: this.#intervalMs });
	}

	stop(): void {
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#logger.info("backup drill scheduler stopped");
	}

	async trigger(): Promise<BackupDrillRunResult> {
		if (this.#running) {
			return this.#lastResult ?? { ok: false, error: "A backup drill is already running" };
		}
		this.#running = true;
		try {
			const result = await this.#run();
			this.#lastResult = result;
			this.#lastRunAtMs = Date.now();
			if (result.ok) {
				this.#logger.info("backup drill completed", {
					reportPath: result.reportPath,
					runId: result.runId,
				});
			} else {
				this.#logger.warn("backup drill failed", {
					error: result.error,
					reportPath: result.reportPath,
					runId: result.runId,
				});
			}
			return result;
		} catch (error) {
			const result: BackupDrillRunResult = {
				error: error instanceof Error ? error.message : String(error),
				ok: false,
			};
			this.#lastResult = result;
			this.#lastRunAtMs = Date.now();
			this.#logger.error("backup drill crashed", { error: result.error });
			return result;
		} finally {
			this.#running = false;
		}
	}
}
