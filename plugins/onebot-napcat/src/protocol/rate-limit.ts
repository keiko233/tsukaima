/**
 * Small deterministic interval limiter used for optional speech-to-text calls. The limit is
 * enforced both globally and per chat so one busy group cannot starve private transcription
 * or vice versa.
 */
export class OneBotIntervalRateLimiter {
	readonly #chatLast = new Map<string, number>();
	readonly #minIntervalMs: number;
	#globalLast = -Infinity;

	constructor(minIntervalMs: number) {
		this.#minIntervalMs = Math.max(0, minIntervalMs);
	}

	tryAcquire(chatKey: string, nowMs = Date.now()): boolean {
		if (this.#minIntervalMs === 0) {
			this.#globalLast = nowMs;
			this.#chatLast.set(chatKey, nowMs);
			return true;
		}
		const lastChat = this.#chatLast.get(chatKey) ?? -Infinity;
		if (nowMs - this.#globalLast < this.#minIntervalMs) return false;
		if (nowMs - lastChat < this.#minIntervalMs) return false;
		this.#globalLast = nowMs;
		this.#chatLast.set(chatKey, nowMs);
		return true;
	}
}
