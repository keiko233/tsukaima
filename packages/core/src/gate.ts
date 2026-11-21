import {
	CONVERSATION_GATE_BINDING,
	type ConversationGatePolicy,
	type ProactiveBubbleGateBridge,
	type SocialFamiliarityLevel,
} from "@tsukaima/contracts";

export { CONVERSATION_GATE_BINDING };

export type GateDecisionSource = "gate" | "fallback";

export interface BurstCompletionGateInput {
	readonly conversationId: string;
	readonly elapsedMs: number;
	readonly envelopeCount: number;
	readonly messages: readonly string[];
	readonly policy: ConversationGatePolicy;
}

export interface BurstCompletionGateDecision {
	readonly confidence?: number;
	readonly decision: "SEND" | "WAIT";
	readonly latencyMs?: number;
	readonly reason?: string;
	readonly source: GateDecisionSource;
}

export interface UndirectedGroupGateInput {
	readonly conversationId: string;
	readonly messageText: string;
	readonly policy: ConversationGatePolicy;
	readonly recentContext?: readonly string[];
	readonly senderName: string;
}

export interface UndirectedGroupGateDecision {
	readonly confidence?: number;
	readonly decision: "REPLY" | "SKIP";
	readonly latencyMs?: number;
	readonly reason?: string;
	readonly source: GateDecisionSource;
}

export interface ProactiveBubbleGateInput {
	readonly conversationId: string;
	readonly conversationKind: string;
	readonly idleMinutes: number;
	readonly level: SocialFamiliarityLevel;
	readonly policy?: ConversationGatePolicy;
	readonly recentMessages: readonly {
		readonly direction: string;
		readonly textPreview: string;
	}[];
}

export interface ProactiveBubbleGateDecision {
	readonly confidence?: number;
	readonly decision: "SHOULD" | "SKIP";
	readonly latencyMs?: number;
	readonly reason?: string;
	readonly source: GateDecisionSource;
}

export interface GateCircuitState {
	readonly consecutiveFailures: number;
	readonly openedAtMs: number | null;
	readonly state: "closed" | "open" | "half-open";
}

/**
 * Pluggable, fail-open pre-model conversation gate covering three low-cost decisions:
 * 1. Burst completion (`SEND` / `WAIT`)
 * 2. Undirected group reply (`REPLY` / `SKIP`)
 * 3. Proactive bubble (`SHOULD` / `SKIP`)
 *
 * When unconfigured, disabled, timed out, or circuit-broken, implementations must fail open
 * (`SEND`, `REPLY`, `SHOULD`) with `source: "fallback"` so traffic degrades cleanly to
 * deterministic policy rules without blocking.
 */
export interface ConversationGatePort extends ProactiveBubbleGateBridge {
	readonly decideBurstCompletion: (
		input: BurstCompletionGateInput,
	) => Promise<BurstCompletionGateDecision>;
	readonly decideUndirectedGroupReply: (
		input: UndirectedGroupGateInput,
	) => Promise<UndirectedGroupGateDecision>;
	readonly decideProactiveBubble: (
		input: ProactiveBubbleGateInput,
	) => Promise<ProactiveBubbleGateDecision>;
	readonly health?: () => GateCircuitState;
}

/** Underlying classifier or fast-model backend wrapped by {@link FailOpenConversationGate}. */
export interface ConversationGateDriver {
	readonly decideBurstCompletion: (
		input: BurstCompletionGateInput,
		signal: AbortSignal,
	) => Promise<Omit<BurstCompletionGateDecision, "latencyMs" | "source"> | undefined>;
	readonly decideUndirectedGroupReply: (
		input: UndirectedGroupGateInput,
		signal: AbortSignal,
	) => Promise<Omit<UndirectedGroupGateDecision, "latencyMs" | "source"> | undefined>;
	readonly decideProactiveBubble: (
		input: ProactiveBubbleGateInput,
		signal: AbortSignal,
	) => Promise<Omit<ProactiveBubbleGateDecision, "latencyMs" | "source"> | undefined>;
}

export interface GateCircuitBreakerOptions {
	readonly cooldownMs?: number;
	readonly failureThreshold?: number;
	readonly now?: () => number;
}

/**
 * Simple circuit breaker for pre-model gate calls: trips after `failureThreshold` consecutive
 * failures (default 3) and stays open for `cooldownMs` (default 60s) before allowing a single
 * half-open probe.
 */
export class GateCircuitBreaker {
	readonly #cooldownMs: number;
	readonly #failureThreshold: number;
	readonly #now: () => number;
	#consecutiveFailures = 0;
	#openedAtMs: number | null = null;
	#halfOpenProbeInFlight = false;

	constructor(options: GateCircuitBreakerOptions = {}) {
		this.#failureThreshold = Math.max(1, options.failureThreshold ?? 3);
		this.#cooldownMs = Math.max(1_000, options.cooldownMs ?? 60_000);
		this.#now = options.now ?? Date.now;
	}

	state(nowMs = this.#now()): GateCircuitState {
		if (this.#openedAtMs === null) {
			return {
				consecutiveFailures: this.#consecutiveFailures,
				openedAtMs: null,
				state: "closed",
			};
		}
		const elapsed = nowMs - this.#openedAtMs;
		return {
			consecutiveFailures: this.#consecutiveFailures,
			openedAtMs: this.#openedAtMs,
			state: elapsed >= this.#cooldownMs ? "half-open" : "open",
		};
	}

	/** Returns true when a call may proceed (closed, or first half-open probe after cooldown). */
	allow(nowMs = this.#now()): boolean {
		const snapshot = this.state(nowMs);
		if (snapshot.state === "closed") return true;
		if (snapshot.state === "open") return false;
		if (this.#halfOpenProbeInFlight) return false;
		this.#halfOpenProbeInFlight = true;
		return true;
	}

	recordSuccess(): void {
		this.#consecutiveFailures = 0;
		this.#openedAtMs = null;
		this.#halfOpenProbeInFlight = false;
	}

	recordFailure(nowMs = this.#now()): void {
		this.#halfOpenProbeInFlight = false;
		this.#consecutiveFailures += 1;
		if (this.#consecutiveFailures >= this.#failureThreshold || this.#openedAtMs !== null) {
			this.#openedAtMs = nowMs;
		}
	}

	reset(): void {
		this.#consecutiveFailures = 0;
		this.#openedAtMs = null;
		this.#halfOpenProbeInFlight = false;
	}
}

export interface FailOpenConversationGateOptions {
	readonly breaker?: GateCircuitBreaker;
	readonly defaultTimeoutMs?: number;
	readonly driver: ConversationGateDriver;
	readonly now?: () => number;
	readonly onFallback?: (event: {
		readonly kind: "burst" | "group" | "proactive";
		readonly reason: string;
	}) => void;
}

/**
 * Fail-open decorator around any {@link ConversationGateDriver}. Enforces timeout, circuit
 * breaker protection, and deterministic fallback values (`SEND`, `REPLY`, `SHOULD`).
 */
export class FailOpenConversationGate implements ConversationGatePort {
	readonly #breaker: GateCircuitBreaker;
	readonly #defaultTimeoutMs: number;
	readonly #driver: ConversationGateDriver;
	readonly #now: () => number;
	readonly #onFallback: FailOpenConversationGateOptions["onFallback"];

	constructor(options: FailOpenConversationGateOptions) {
		this.#breaker =
			options.breaker ??
			new GateCircuitBreaker(options.now === undefined ? {} : { now: options.now });
		this.#defaultTimeoutMs = Math.max(100, options.defaultTimeoutMs ?? 1_500);
		this.#driver = options.driver;
		this.#now = options.now ?? Date.now;
		this.#onFallback = options.onFallback;
	}

	health(): GateCircuitState {
		return this.#breaker.state();
	}

	async decideBurstCompletion(
		input: BurstCompletionGateInput,
	): Promise<BurstCompletionGateDecision> {
		if (!input.policy.enabled || !input.policy.burstCompletion) {
			return { decision: "SEND", reason: "disabled", source: "fallback" };
		}
		return this.#runWithBreaker(
			"burst",
			input.policy.timeoutMs,
			(signal) => this.#driver.decideBurstCompletion(input, signal),
			"SEND",
		);
	}

	async decideUndirectedGroupReply(
		input: UndirectedGroupGateInput,
	): Promise<UndirectedGroupGateDecision> {
		if (!input.policy.enabled || !input.policy.undirectedGroupReply) {
			return { decision: "REPLY", reason: "disabled", source: "fallback" };
		}
		return this.#runWithBreaker(
			"group",
			input.policy.timeoutMs,
			(signal) => this.#driver.decideUndirectedGroupReply(input, signal),
			"REPLY",
		);
	}

	async decideProactiveBubble(
		input: ProactiveBubbleGateInput,
	): Promise<ProactiveBubbleGateDecision> {
		if (input.policy !== undefined && (!input.policy.enabled || !input.policy.proactiveBubble)) {
			return { decision: "SHOULD", reason: "disabled", source: "fallback" };
		}
		return this.#runWithBreaker(
			"proactive",
			input.policy?.timeoutMs ?? this.#defaultTimeoutMs,
			(signal) => this.#driver.decideProactiveBubble(input, signal),
			"SHOULD",
		);
	}

	async #runWithBreaker<D extends string>(
		kind: "burst" | "group" | "proactive",
		timeoutMs: number,
		call: (signal: AbortSignal) => Promise<
			| {
					readonly confidence?: number;
					readonly decision: D;
					readonly reason?: string;
			  }
			| undefined
		>,
		fallbackDecision: D,
	): Promise<{
		readonly confidence?: number;
		readonly decision: D;
		readonly latencyMs?: number;
		readonly reason?: string;
		readonly source: GateDecisionSource;
	}> {
		const startedAt = this.#now();
		if (!this.#breaker.allow(startedAt)) {
			this.#onFallback?.({ kind, reason: "circuit_open" });
			return {
				decision: fallbackDecision,
				latencyMs: 0,
				reason: "circuit_open",
				source: "fallback",
			};
		}
		const controller = new AbortController();
		const boundedTimeoutMs = Math.max(100, timeoutMs);
		const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
		timer.unref?.();
		try {
			const result = await call(controller.signal);
			const latencyMs = Math.max(0, this.#now() - startedAt);
			if (result === undefined) {
				this.#breaker.recordFailure(this.#now());
				this.#onFallback?.({ kind, reason: "empty_response" });
				return {
					decision: fallbackDecision,
					latencyMs,
					reason: "empty_response",
					source: "fallback",
				};
			}
			this.#breaker.recordSuccess();
			return {
				...result,
				latencyMs,
				source: "gate",
			};
		} catch (error) {
			const latencyMs = Math.max(0, this.#now() - startedAt);
			const reason = controller.signal.aborted
				? "timeout"
				: error instanceof Error
					? error.message
					: String(error);
			this.#breaker.recordFailure(this.#now());
			this.#onFallback?.({ kind, reason });
			return {
				decision: fallbackDecision,
				latencyMs,
				reason,
				source: "fallback",
			};
		} finally {
			clearTimeout(timer);
		}
	}
}
