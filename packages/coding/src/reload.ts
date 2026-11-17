import type { HealthCheckResult } from "./types.ts";

export interface ReloadContext {
	/** Deployment row that owns this reload, carried into the durable restart intent. */
	readonly deploymentId?: string;
	readonly proposalId?: string;
	readonly reason: string;
}

export interface ReloadResult {
	/**
	 * The reload was accepted and persisted but the process has not switched yet (a supervised
	 * restart/update). Callers must not report the deployment as completed in this case.
	 */
	readonly deferred?: boolean;
	readonly message: string;
	readonly reloadedAtMs: number;
	readonly success: boolean;
}

export interface ReloadController {
	reload(componentId: string, context: ReloadContext): Promise<ReloadResult>;
}

export class NoopReloadController implements ReloadController {
	async reload(componentId: string, context: ReloadContext): Promise<ReloadResult> {
		return {
			message: `No-op reload for "${componentId}" (reason: ${context.reason})`,
			reloadedAtMs: Date.now(),
			success: true,
		};
	}
}

export interface SupervisedReloadOptions {
	readonly healthCheck: () => Promise<HealthCheckResult> | HealthCheckResult;
	readonly now?: () => number;
	readonly reload: ReloadController;
	/** Invoked when the post-reload health check fails. Must be idempotent. */
	readonly rollback?: (outcome: SupervisedReloadOutcome) => Promise<void> | void;
}

export interface SupervisedReloadOutcome {
	/** The reload was persisted for a supervisor instead of switching this process in place. */
	readonly deferred: boolean;
	readonly message: string;
	readonly postCheck: HealthCheckResult;
	readonly preCheck: HealthCheckResult;
	readonly reload: ReloadResult | null;
	readonly reloadedAtMs: number;
	readonly rollbackAttempted: boolean;
	readonly success: boolean;
}

/**
 * Pre-health -> reload -> post-health -> rollback hook. A failed pre-check never reloads, and
 * a failed post-check always attempts the rollback hook once.
 */
export class SupervisedReloadController implements ReloadController {
	readonly #options: SupervisedReloadOptions;

	constructor(options: SupervisedReloadOptions) {
		this.#options = options;
	}

	async #check(now: () => number): Promise<HealthCheckResult> {
		try {
			const result = await this.#options.healthCheck();
			return { ...result, checkedAtMs: result.checkedAtMs || now() };
		} catch (error) {
			return {
				checkedAtMs: now(),
				message: error instanceof Error ? error.message : String(error),
				ok: false,
			};
		}
	}

	async reload(componentId: string, context: ReloadContext): Promise<SupervisedReloadOutcome> {
		const now = this.#options.now ?? Date.now;
		const preCheck = await this.#check(now);
		if (!preCheck.ok) {
			return {
				deferred: false,
				message: `Pre-reload health check failed: ${preCheck.message ?? "unhealthy"}`,
				postCheck: preCheck,
				preCheck,
				reload: null,
				reloadedAtMs: now(),
				rollbackAttempted: false,
				success: false,
			};
		}

		let reload: ReloadResult | null = null;
		try {
			reload = await this.#options.reload.reload(componentId, context);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const postCheck: HealthCheckResult = { checkedAtMs: now(), message, ok: false };
			const rollbackAttempted = await this.#attemptRollback({
				deferred: false,
				message,
				postCheck,
				preCheck,
				reload: null,
				reloadedAtMs: now(),
				rollbackAttempted: false,
				success: false,
			});
			return {
				deferred: false,
				message: `Reload failed: ${message}`,
				postCheck,
				preCheck,
				reload: null,
				reloadedAtMs: now(),
				rollbackAttempted,
				success: false,
			};
		}

		const postCheck = await this.#check(now);
		const success = reload.success && postCheck.ok;
		if (success) {
			return {
				deferred: reload.deferred === true,
				message: reload.message,
				postCheck,
				preCheck,
				reload,
				reloadedAtMs: now(),
				rollbackAttempted: false,
				success: true,
			};
		}
		const outcome: SupervisedReloadOutcome = {
			deferred: reload?.deferred === true,
			message: `Post-reload health check failed: ${postCheck.message ?? "unhealthy"}`,
			postCheck,
			preCheck,
			reload,
			reloadedAtMs: now(),
			rollbackAttempted: false,
			success: false,
		};
		const rollbackAttempted = await this.#attemptRollback(outcome);
		return { ...outcome, rollbackAttempted };
	}

	async #attemptRollback(outcome: SupervisedReloadOutcome): Promise<boolean> {
		if (this.#options.rollback === undefined) return false;
		try {
			await this.#options.rollback(outcome);
			return true;
		} catch {
			return false;
		}
	}
}
