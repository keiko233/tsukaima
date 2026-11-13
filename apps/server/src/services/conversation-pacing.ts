import type { ConversationPolicy } from "@tsukaima/contracts";

type ConversationPacingState = {
	lurkAtMs?: number;
	lastReplyAtMs?: number;
	replyTimestampsMs: number[];
};

/**
 * Tracks the small amount of non-durable pacing state needed to enforce cooldown and the
 * per-minute reply ceiling. Message aggregation itself stays durable in the host window.
 */
export class ConversationPacingTracker {
	readonly #state = new Map<string, ConversationPacingState>();

	#entry(conversationId: string): ConversationPacingState {
		const existing = this.#state.get(conversationId);
		if (existing !== undefined) return existing;
		const created: ConversationPacingState = { replyTimestampsMs: [] };
		this.#state.set(conversationId, created);
		return created;
	}

	recordReply(conversationId: string, nowMs = Date.now()): void {
		const state = this.#entry(conversationId);
		state.lastReplyAtMs = nowMs;
		state.replyTimestampsMs.push(nowMs);
		const cutoff = nowMs - 60_000;
		state.replyTimestampsMs = state.replyTimestampsMs.filter((value) => value > cutoff);
	}

	recordLurk(conversationId: string, nowMs = Date.now()): void {
		this.#entry(conversationId).lurkAtMs = nowMs;
	}

	isRecentlyActive(conversationId: string, windowMs: number, nowMs = Date.now()): boolean {
		const state = this.#state.get(conversationId);
		if (state === undefined) return false;
		const latest = Math.max(
			state.lastReplyAtMs ?? 0,
			state.lurkAtMs ?? 0,
			...(state.replyTimestampsMs.length === 0 ? [0] : state.replyTimestampsMs),
		);
		return latest > 0 && nowMs - latest <= Math.max(0, windowMs);
	}

	/** Remaining cooldown/rate-limit time, or 0 when a model run may flush immediately. */
	remainingCooldownMs(
		conversationId: string,
		policy: ConversationPolicy,
		nowMs = Date.now(),
	): number {
		const state = this.#state.get(conversationId);
		if (state === undefined) return 0;
		let remaining = 0;
		const lastOutputAt = Math.max(state.lastReplyAtMs ?? 0, state.lurkAtMs ?? 0);
		if (policy.pacing.replyCooldownMs > 0 && lastOutputAt > 0) {
			remaining = Math.max(remaining, lastOutputAt + policy.pacing.replyCooldownMs - nowMs);
		}
		if (policy.pacing.maxRepliesPerMinute > 0) {
			const cutoff = nowMs - 60_000;
			const recent = state.replyTimestampsMs.filter((value) => value > cutoff);
			if (recent.length >= policy.pacing.maxRepliesPerMinute) {
				const oldest = Math.min(...recent);
				remaining = Math.max(remaining, oldest + 60_000 - nowMs);
			}
		}
		return Math.max(0, remaining);
	}
}
