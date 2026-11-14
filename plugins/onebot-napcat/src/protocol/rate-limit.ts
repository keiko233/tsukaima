import type { PluginLogger } from "@elaina/sdk";
import { createSafeLogger } from "../logging.ts";

/**
 * Small deterministic interval limiter used for optional speech-to-text calls. The limit is
 * enforced both globally and per chat so one busy group cannot starve private transcription
 * or vice versa.
 */
export class OneBotIntervalRateLimiter {
	readonly #chatLast = new Map<string, number>();
	readonly #logger: PluginLogger;
	readonly #minIntervalMs: number;
	#globalLast = -Infinity;

	constructor(minIntervalMs: number, logger?: PluginLogger) {
		this.#minIntervalMs = Math.max(0, minIntervalMs);
		this.#logger = createSafeLogger(logger);
	}

	tryAcquire(chatKey: string, nowMs = Date.now()): boolean {
		if (this.#minIntervalMs === 0) {
			this.#globalLast = nowMs;
			this.#chatLast.set(chatKey, nowMs);
			return true;
		}
		const lastChat = this.#chatLast.get(chatKey) ?? -Infinity;
		if (nowMs - this.#globalLast < this.#minIntervalMs) {
			this.#logger.debug("OneBot enrichment rate limited", {
				chatKey,
				minIntervalMs: this.#minIntervalMs,
				scope: "global",
			});
			return false;
		}
		if (nowMs - lastChat < this.#minIntervalMs) {
			this.#logger.debug("OneBot enrichment rate limited", {
				chatKey,
				minIntervalMs: this.#minIntervalMs,
				scope: "chat",
			});
			return false;
		}
		this.#globalLast = nowMs;
		this.#chatLast.set(chatKey, nowMs);
		this.#logger.trace("OneBot enrichment rate limit acquired", { chatKey });
		return true;
	}
}
