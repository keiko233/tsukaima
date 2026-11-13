import type { HealthCheckResult } from "./types.ts";

export interface ReloadContext {
	readonly proposalId?: string;
	readonly reason: string;
}

export interface ReloadResult {
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
				message,
				postCheck,
				preCheck,
				reload: null,
				reloadedAtMs: now(),
				rollbackAttempted: false,
				success: false,
			});
			return {
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
