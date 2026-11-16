import type { PluginLogger } from "@tsukaima/sdk";
import type { ProviderRateLimit } from "./domain.ts";

export type GovernorBlockReason = "cooldown" | "rate_limited";

export type GovernorDecision =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: GovernorBlockReason; readonly retryAfterMs: number };

export interface ProviderRuntimeStatus {
	readonly cooldownUntilMs: number | null;
	readonly failures: number;
	readonly lastError?: string;
	readonly perHour: number;
	readonly perMinute: number;
	readonly ready: boolean;
	readonly usedHour: number;
	readonly usedMinute: number;
}

interface ProviderState {
	cooldownUntilMs: number;
	failures: number;
	hits: number[];
	lastError?: string;
	limit: ProviderRateLimit;
}

export interface GovernorOptions {
	readonly cooldownMs: number;
	readonly failureThreshold: number;
	readonly logger?: PluginLogger;
	readonly now?: () => number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Per-provider sliding-window rate limits plus a failure-aware cooldown circuit breaker.
 * A provider in cooldown is skipped entirely, which prevents retry storms during an outage.
 */
export class ProviderGovernor {
	readonly #cooldownMs: number;
	readonly #failureThreshold: number;
	readonly #logger: PluginLogger | undefined;
	readonly #now: () => number;
	readonly #states = new Map<string, ProviderState>();

	constructor(options: GovernorOptions) {
		this.#cooldownMs = Math.max(1, Math.floor(options.cooldownMs));
		this.#failureThreshold = Math.max(1, Math.floor(options.failureThreshold));
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
	}

	setLimit(providerId: string, limit: ProviderRateLimit): void {
		this.#state(providerId).limit = {
			perHour: Math.max(1, Math.floor(limit.perHour)),
			perMinute: Math.max(1, Math.floor(limit.perMinute)),
		};
		this.#logger?.trace("provider rate limit set", {
			perHour: this.#state(providerId).limit.perHour,
			perMinute: this.#state(providerId).limit.perMinute,
			providerId,
		});
	}

	getLimit(providerId: string): ProviderRateLimit {
		return this.#state(providerId).limit;
	}

	/** Check and consume one attempt when all rate-limit windows allow it. */
	tryConsume(providerId: string): GovernorDecision {
		const now = this.#now();
		const state = this.#state(providerId);
		if (state.cooldownUntilMs > now) {
			const retryAfterMs = state.cooldownUntilMs - now;
			this.#logger?.trace("provider cooldown wait", {
				providerId,
				retryAfterMs,
				skipReason: "cooldown",
			});
			return { ok: false, reason: "cooldown", retryAfterMs };
		}
		this.#prune(state, now);
		const usedMinute = state.hits.filter((hit) => hit > now - MINUTE).length;
		const usedHour = state.hits.length;
		const minuteRetry = this.#retryAfter(state, now, MINUTE, state.limit.perMinute);
		if (usedMinute >= state.limit.perMinute) {
			const retryAfterMs = Math.max(1_000, (minuteRetry ?? now) - now);
			this.#logger?.trace("provider rate limit wait", {
				limit: state.limit.perMinute,
				providerId,
				retryAfterMs,
				skipReason: "rate_limited",
				used: usedMinute,
				window: "minute",
			});
			return { ok: false, reason: "rate_limited", retryAfterMs };
		}
		if (usedHour >= state.limit.perHour) {
			const hourRetry = this.#retryAfter(state, now, HOUR, state.limit.perHour);
			const retryAfterMs = Math.max(1_000, (hourRetry ?? now) - now);
			this.#logger?.trace("provider rate limit wait", {
				limit: state.limit.perHour,
				providerId,
				retryAfterMs,
				skipReason: "rate_limited",
				used: usedHour,
				window: "hour",
			});
			return { ok: false, reason: "rate_limited", retryAfterMs };
		}
		state.hits.push(now);
		this.#logger?.trace("provider attempt allowed", {
			providerId,
			usedHour: state.hits.length,
			usedMinute: usedMinute + 1,
		});
		return { ok: true };
	}

	recordSuccess(providerId: string): void {
		const state = this.#state(providerId);
		const recovered = state.failures > 0 || state.cooldownUntilMs > 0;
		state.failures = 0;
		state.cooldownUntilMs = 0;
		delete state.lastError;
		if (recovered) {
			this.#logger?.debug("provider circuit closed", { providerId });
		}
	}

	recordFailure(providerId: string, error: unknown): void {
		const state = this.#state(providerId);
		state.failures += 1;
		state.lastError = error instanceof Error ? error.message : String(error);
		if (state.failures >= this.#failureThreshold) {
			state.cooldownUntilMs = this.#now() + this.#cooldownMs;
			// Never log the upstream message here: it is not redacted at this layer.
			this.#logger?.warn("provider circuit opened", {
				cooldownMs: this.#cooldownMs,
				failureThreshold: this.#failureThreshold,
				failures: state.failures,
				providerId,
			});
			return;
		}
		this.#logger?.trace("provider attempt failed", {
			failures: state.failures,
			providerId,
			remainingFailures: this.#failureThreshold - state.failures,
		});
	}

	reset(providerId?: string): void {
		if (providerId === undefined) {
			for (const state of this.#states.values()) {
				state.cooldownUntilMs = 0;
				state.failures = 0;
				delete state.lastError;
			}
			this.#logger?.debug("provider circuits reset", { providers: this.#states.size });
			return;
		}
		const state = this.#states.get(providerId);
		if (state === undefined) return;
		state.cooldownUntilMs = 0;
		state.failures = 0;
		delete state.lastError;
		this.#logger?.debug("provider circuit reset", { providerId });
	}

	status(providerId: string): ProviderRuntimeStatus {
		const now = this.#now();
		const state = this.#state(providerId);
		this.#prune(state, now);
		return {
			cooldownUntilMs: state.cooldownUntilMs > now ? state.cooldownUntilMs : null,
			failures: state.failures,
			...(state.lastError === undefined ? {} : { lastError: state.lastError }),
			perHour: state.limit.perHour,
			perMinute: state.limit.perMinute,
			ready: state.cooldownUntilMs <= now,
			usedHour: state.hits.length,
			usedMinute: state.hits.filter((hit) => hit > now - MINUTE).length,
		};
	}

	#state(providerId: string): ProviderState {
		const existing = this.#states.get(providerId);
		if (existing !== undefined) return existing;
		const created: ProviderState = {
			cooldownUntilMs: 0,
			failures: 0,
			hits: [],
			limit: { perHour: 120, perMinute: 20 },
		};
		this.#states.set(providerId, created);
		return created;
	}

	#prune(state: ProviderState, now: number): void {
		const cutoff = now - HOUR;
		state.hits = state.hits.filter((hit) => hit > cutoff);
	}

	#retryAfter(
		state: ProviderState,
		now: number,
		window: number,
		limit: number,
	): number | undefined {
		const inWindow = state.hits.filter((hit) => hit > now - window);
		if (inWindow.length < limit) return undefined;
		const oldest = inWindow[inWindow.length - limit];
		return oldest === undefined ? undefined : oldest + window;
	}
}
