import type { ConversationPolicy } from "@elaina/contracts";

/** What to do with a pending activity window while a model run is already working. */
export type BusyArbitrationDecision = "interrupt" | "steer" | "wait";

/**
 * Compact, content-bearing input for the sidechat classifier. It intentionally contains only
 * the current request, the pending batch, and the run's visible progress: the classifier is a
 * router, not a second copy of the conversation.
 */
export interface BusyArbitrationInput {
	readonly conversationId: string;
	/** New messages waiting in the activity window, with participant labels. */
	readonly pendingText: string;
	/** The user request the running turn is answering. */
	readonly runningRequest: string;
	/** The last settled assistant answer, when there is one. */
	readonly previousAnswer?: string;
	/** Text the running turn has streamed so far, when it has produced any. */
	readonly partialAnswer?: string;
	readonly policy: ConversationPolicy;
	/** Whether a tool round is running now, which is when `steer` can take effect promptly. */
	readonly toolsActive: boolean;
	readonly turns: number;
	readonly runAgeMs: number;
}

export interface BusyArbitrationResult {
	readonly decision: BusyArbitrationDecision;
	/** 0..1. The host asks for `wait` when this is absent or below the policy threshold. */
	readonly confidence?: number;
	readonly reason?: string;
}

/**
 * A fast sidechat classifier. Returning `undefined` is the same as `wait`: the caller keeps
 * accumulating instead of interrupting or steering.
 */
export type BusyArbiter = (
	input: BusyArbitrationInput,
) => Promise<BusyArbitrationResult | undefined> | BusyArbitrationResult | undefined;
