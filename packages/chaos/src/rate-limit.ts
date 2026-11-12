import { AbuseGuard } from "./abuse-guard.ts";

export class RateLimitExceededError extends Error {
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		super(`Rate limit exceeded, retry after ${retryAfterMs} ms`);
		this.name = "RateLimitExceededError";
		this.retryAfterMs = retryAfterMs;
	}
}

export class DuplicateEnvelopeIdError extends Error {
	readonly envelopeId: string;

	constructor(envelopeId: string) {
		super(`Duplicate envelope ID: ${envelopeId}`);
		this.name = "DuplicateEnvelopeIdError";
		this.envelopeId = envelopeId;
	}
}

export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly remaining: number;
	readonly retryAfterMs: number;
}

export interface RateLimiterOptions {
	readonly intervalMs: number;
	readonly limit: number;
}

export class RateLimiter {
	private readonly intervalMs: number;
	private readonly limit: number;
	private readonly requests = new Map<string, number[]>();

	constructor(options: RateLimiterOptions) {
		if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
			throw new RangeError("intervalMs must be a positive safe integer");
		}
		if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
			throw new RangeError("limit must be a positive safe integer");
		}
		this.intervalMs = options.intervalMs;
		this.limit = options.limit;
	}

	check(key: string, nowMs: number): RateLimitDecision {
		const requests = this.requests.get(key) ?? [];
		const oldestAllowed = nowMs - this.intervalMs;
		const recent = requests.filter((timestampMs) => timestampMs > oldestAllowed);
		if (recent.length >= this.limit) {
			const oldest = recent[0];
			if (oldest === undefined) throw new RangeError("Rate limiter has no recorded request");
			return { allowed: false, remaining: 0, retryAfterMs: oldest + this.intervalMs - nowMs };
		}
		recent.push(nowMs);
		this.requests.set(key, recent);
		return { allowed: true, remaining: this.limit - recent.length, retryAfterMs: 0 };
	}
}

export interface IdempotentIngestOptions {
	readonly rateLimiter: RateLimiter;
	readonly sizeLimitBytes: number;
}

export class IdempotentIngest {
	private readonly guard: AbuseGuard;
	private readonly rateLimiter: RateLimiter;
	private readonly seen = new Set<string>();

	constructor(options: IdempotentIngestOptions) {
		this.guard = new AbuseGuard({ maxBytes: options.sizeLimitBytes });
		this.rateLimiter = options.rateLimiter;
	}

	ingest(
		input: { readonly key: string; readonly nowMs: number } & { readonly envelope: unknown },
	): RateLimitDecision {
		const { envelope, key, nowMs } = input;
		const decision = this.rateLimiter.check(key, nowMs);
		if (!decision.allowed) return decision;
		const validated = this.guard.check(envelope);
		if (this.seen.has(validated.envelope.id)) {
			throw new DuplicateEnvelopeIdError(validated.envelope.id);
		}
		this.seen.add(validated.envelope.id);
		return decision;
	}
}
