import type { PluginLogger } from "@tsukaima/sdk";
import {
	MAX_RESULTS,
	normalizeUrlForDedupe,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
} from "./domain.ts";
import { ProviderGovernor } from "./governor.ts";
import { elapsedMs, previewText } from "./logging.ts";
import { type SearchPolicy } from "./policy.ts";
import { hostMatches, isHostAllowed } from "./url-policy.ts";

export type SearchAttemptStatus = "empty" | "error" | "ok" | "skipped";

export interface SearchAttempt {
	readonly count: number;
	readonly latencyMs: number;
	readonly providerId: string;
	readonly reason?: string;
	readonly status: SearchAttemptStatus;
}

export interface SearchOutcome {
	readonly attempts: readonly SearchAttempt[];
	readonly error?: string;
	readonly providerIds: readonly string[];
	readonly results: readonly SearchResult[];
	readonly status: "error" | "not_found" | "ok";
}

export interface SearchEngineOptions {
	readonly fetch: typeof fetch;
	readonly governor: ProviderGovernor;
	readonly logger?: PluginLogger;
	readonly now?: () => number;
	readonly policy: SearchPolicy;
	readonly providers: readonly SearchProvider[];
	/** Redacts configured API keys from failure text before it reaches the log sink. */
	readonly redact?: (value: string) => string;
}

export interface SearchOptions {
	/** Explicit provider ids in preference order. Empty means policy priority. */
	readonly providers?: readonly string[];
	/** Query all eligible providers concurrently and merge the results. */
	readonly multi?: boolean;
}

function sanitizeFailure(error: unknown): string {
	if (error instanceof Error) {
		// Provider failures are already written without credentials; cap noisy upstream text.
		return error.message.replace(/\s+/gu, " ").slice(0, 240);
	}
	return String(error).slice(0, 240);
}

/** Policy-driven search routing, fallback, rate limits, cooldown, merging, and dedupe. */
export class SearchEngine {
	readonly #fetch: typeof fetch;
	readonly #governor: ProviderGovernor;
	readonly #logger: PluginLogger | undefined;
	readonly #now: () => number;
	readonly #providers: readonly SearchProvider[];
	#policy: SearchPolicy;
	#redact: (value: string) => string;

	constructor(options: SearchEngineOptions) {
		this.#fetch = options.fetch;
		this.#governor = options.governor;
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
		this.#policy = options.policy;
		this.#providers = options.providers;
		this.#redact = options.redact ?? ((value) => value);
		this.applyRateLimits();
	}

	/** Keeps provider failure logging safe when configured API keys change at runtime. */
	setRedactor(redact: (value: string) => string): void {
		this.#redact = redact;
	}

	get policy(): SearchPolicy {
		return this.#policy;
	}

	listProviders(): readonly SearchProvider[] {
		return this.#providers;
	}

	provider(providerId: string): SearchProvider | undefined {
		return this.#providers.find((provider) => provider.id === providerId);
	}

	setPolicy(policy: SearchPolicy): void {
		this.#policy = policy;
		this.applyRateLimits();
	}

	applyRateLimits(): void {
		for (const provider of this.#providers) {
			const override = this.#policy.rateLimits[provider.id];
			this.#governor.setLimit(provider.id, override ?? provider.rateLimit);
		}
	}

	async search(input: SearchRequest, options: SearchOptions = {}): Promise<SearchOutcome> {
		const startedAt = performance.now();
		const mode = options.multi === true ? "multi" : "fallback";
		const explicit =
			options.providers !== undefined && options.providers.length > 0
				? options.providers
				: undefined;
		const requested = explicit ?? input.providers;
		this.#logger?.trace("search routing", {
			language: input.language ?? null,
			maxResults: input.maxResults,
			mode,
			queryChars: input.query.length,
			requestedProviders: requested === undefined ? null : [...requested],
			timeRange: input.timeRange ?? null,
		});
		const eligible = this.#eligibleProviders(input, options.providers);
		this.#logger?.debug("search candidates selected", {
			candidateIds: eligible.map((provider) => provider.id),
			mode,
		});
		if (eligible.length === 0) {
			this.#logger?.warn("no eligible search provider", {
				mode,
				requestedProviders: requested === undefined ? null : [...requested],
			});
			return {
				attempts: [],
				error: "No eligible search provider is configured for this request",
				providerIds: [],
				results: [],
				status: "error",
			};
		}
		const outcome =
			options.multi === true
				? await this.#searchMulti(input, eligible)
				: await this.#searchFallback(input, eligible);
		this.#logger?.debug("search routed", {
			attempts: outcome.attempts.map((attempt) => ({
				count: attempt.count,
				providerId: attempt.providerId,
				status: attempt.status,
			})),
			durationMs: elapsedMs(startedAt),
			mode,
			providerIds: outcome.providerIds,
			resultCount: outcome.results.length,
			status: outcome.status,
		});
		return outcome;
	}

	async #searchFallback(
		input: SearchRequest,
		providers: readonly SearchProvider[],
	): Promise<SearchOutcome> {
		const attempts: SearchAttempt[] = [];
		for (const [index, provider] of providers.entries()) {
			const results = await this.#runProvider(provider, input, attempts);
			if (results === undefined) {
				this.#logFallback(providers, index, provider.id, "attempt_failed");
				continue;
			}
			if (results.length === 0) {
				this.#logFallback(providers, index, provider.id, "empty_result");
				continue;
			}
			const filtered = this.#filterResults(results, input, provider.id);
			if (filtered.length === 0) {
				attempts[attempts.length - 1] = {
					...(attempts[attempts.length - 1] as SearchAttempt),
					count: 0,
					status: "empty",
				};
				this.#logFallback(providers, index, provider.id, "filtered_out");
				continue;
			}
			return {
				attempts,
				providerIds: [...new Set(filtered.map((result) => result.providerId))],
				results: filtered.slice(0, this.#limit(input)),
				status: "ok",
			};
		}
		return this.#failureOutcome(attempts);
	}

	#logFallback(
		providers: readonly SearchProvider[],
		index: number,
		providerId: string,
		reason: string,
	): void {
		const next = providers[index + 1];
		if (next === undefined) {
			this.#logger?.debug("search fallback exhausted", { providerId, reason });
			return;
		}
		this.#logger?.debug("search falling back", {
			fromProviderId: providerId,
			reason,
			toProviderId: next.id,
		});
	}

	async #searchMulti(
		input: SearchRequest,
		providers: readonly SearchProvider[],
	): Promise<SearchOutcome> {
		const attempts: SearchAttempt[] = [];
		const selected = providers.slice(0, this.#policy.maxProviders);
		this.#logger?.trace("multi search starting", {
			candidateIds: selected.map((provider) => provider.id),
			skipped: providers.length - selected.length,
		});
		const batches = await Promise.all(
			selected.map(async (provider) => await this.#runProvider(provider, input, attempts)),
		);
		const merged = this.#filterResults(
			this.#mergeResults(batches.flatMap((batch) => batch ?? [])),
			input,
		);
		if (merged.length === 0) return this.#failureOutcome(attempts);
		return {
			attempts,
			providerIds: [...new Set(merged.map((result) => result.providerId))],
			results: merged.slice(0, this.#limit(input)),
			status: "ok",
		};
	}

	async #runProvider(
		provider: SearchProvider,
		input: SearchRequest,
		attempts: SearchAttempt[],
	): Promise<SearchResult[] | undefined> {
		const decision = this.#governor.tryConsume(provider.id);
		if (!decision.ok) {
			this.#logger?.debug("provider skipped", {
				providerId: provider.id,
				reason: decision.reason,
				retryAfterMs: decision.retryAfterMs,
			});
			attempts.push({
				count: 0,
				latencyMs: 0,
				providerId: provider.id,
				reason: decision.reason,
				status: "skipped",
			});
			return undefined;
		}
		const startedAt = this.#now();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const execution = Promise.resolve().then(() =>
				provider.search(input, {
					fetch: this.#fetch,
					now: this.#now,
					signal: controller.signal,
				}),
			);
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("Search provider timed out"));
				}, this.#policy.searchTimeoutMs);
			});
			const results = await Promise.race([execution, timeout]);
			if (!Array.isArray(results)) throw new Error("Provider returned malformed results");
			this.#governor.recordSuccess(provider.id);
			const latencyMs = this.#now() - startedAt;
			this.#logger?.debug("provider attempt completed", {
				durationMs: latencyMs,
				providerId: provider.id,
				resultCount: results.length,
				status: results.length === 0 ? "empty" : "ok",
			});
			attempts.push({
				count: results.length,
				latencyMs,
				providerId: provider.id,
				status: results.length === 0 ? "empty" : "ok",
			});
			return results;
		} catch (error) {
			this.#governor.recordFailure(provider.id, error);
			const latencyMs = this.#now() - startedAt;
			this.#logger?.debug("provider attempt failed", {
				durationMs: latencyMs,
				error: this.#redact(previewText(sanitizeFailure(error))),
				providerId: provider.id,
			});
			attempts.push({
				count: 0,
				latencyMs,
				providerId: provider.id,
				reason: sanitizeFailure(error),
				status: "error",
			});
			return undefined;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	#failureOutcome(attempts: readonly SearchAttempt[]): SearchOutcome {
		const failures = attempts.filter((attempt) => attempt.status === "error");
		if (failures.length > 0) {
			return {
				attempts,
				error: `Search failed: ${failures[0]?.reason ?? "provider error"}`,
				providerIds: [],
				results: [],
				status: "error",
			};
		}
		const skipped = attempts.filter((attempt) => attempt.status === "skipped");
		if (skipped.length > 0) {
			return {
				attempts,
				error: "Search providers are rate limited or cooling down",
				providerIds: [],
				results: [],
				status: "error",
			};
		}
		return { attempts, providerIds: [], results: [], status: "not_found" };
	}

	#eligibleProviders(
		input: SearchRequest,
		explicit: readonly string[] | undefined,
	): SearchProvider[] {
		const disabled = new Set(this.#policy.disabledProviders);
		const allowed = new Set(this.#policy.allowedProviders);
		const byId = new Map(this.#providers.map((provider) => [provider.id, provider]));
		const requested = explicit !== undefined && explicit.length > 0 ? explicit : input.providers;
		const hasRequested = requested !== undefined && requested.length > 0;
		const order = hasRequested ? requested : this.#policy.priority;
		const ordered: SearchProvider[] = [];
		const seen = new Set<string>();
		for (const id of order) {
			const provider = byId.get(id);
			if (provider === undefined || seen.has(provider.id)) continue;
			seen.add(provider.id);
			ordered.push(provider);
		}
		// An explicit engine/provider list is authoritative; only policy priority falls through.
		if (!hasRequested) {
			for (const provider of this.#providers) {
				if (seen.has(provider.id)) continue;
				seen.add(provider.id);
				ordered.push(provider);
			}
		}
		const language =
			input.language === undefined
				? undefined
				: this.#policy.languagePools[input.language.toLowerCase()];
		const eligible = ordered.filter((provider) => {
			if (disabled.has(provider.id) || provider.configured === false) return false;
			if (allowed.size > 0 && !allowed.has(provider.id)) return false;
			if (language !== undefined && !language.includes(provider.id)) return false;
			if (input.timeRange !== undefined && !provider.capabilities.includes("time-range")) {
				return false;
			}
			if (
				input.allowedDomains !== undefined &&
				input.allowedDomains.length > 0 &&
				!provider.capabilities.includes("domain")
			) {
				return false;
			}
			if (
				input.language !== undefined &&
				provider.languages !== undefined &&
				!provider.languages.some(
					(candidate) => candidate.toLowerCase() === input.language?.toLowerCase(),
				)
			) {
				return false;
			}
			return true;
		});
		this.#logger?.trace("provider eligibility resolved", {
			allowed: allowed.size,
			disabled: disabled.size,
			eligible: eligible.map((provider) => provider.id),
			eligibleCount: eligible.length,
			explicit: hasRequested,
			orderedCount: ordered.length,
			rejectedCount: ordered.length - eligible.length,
		});
		return eligible;
	}

	#filterResults(
		results: readonly SearchResult[],
		input: SearchRequest,
		providerId?: string,
	): SearchResult[] {
		const kept = results.filter((result) => {
			if (!isHostAllowed(result.domain, this.#policy)) return false;
			if (input.allowedDomains === undefined || input.allowedDomains.length === 0) return true;
			return input.allowedDomains.some((pattern) => hostMatches(pattern, result.domain));
		});
		if (kept.length !== results.length) {
			this.#logger?.trace("results filtered", {
				dropped: results.length - kept.length,
				kept: kept.length,
				providerId: providerId ?? null,
				reason: "domain_policy",
				requestedDomains: input.allowedDomains === undefined ? null : [...input.allowedDomains],
			});
		}
		return kept;
	}

	#mergeResults(results: readonly SearchResult[]): SearchResult[] {
		const merged = new Map<string, { providers: Set<string>; result: SearchResult }>();
		for (const result of results) {
			const key = normalizeUrlForDedupe(result.url);
			const existing = merged.get(key);
			if (existing === undefined) {
				merged.set(key, { providers: new Set([result.providerId]), result });
				continue;
			}
			existing.providers.add(result.providerId);
			const best = result.score > existing.result.score ? result : existing.result;
			const snippet =
				result.snippet.length > existing.result.snippet.length
					? result.snippet
					: existing.result.snippet;
			existing.result = { ...best, snippet };
		}
		const ranked = [...merged.values()]
			.map(({ providers, result }) => ({
				...result,
				score: Math.min(1, result.score + Math.max(0, providers.size - 1) * 0.1),
			}))
			.toSorted((a, b) => b.score - a.score || a.url.localeCompare(b.url))
			.slice(0, MAX_RESULTS);
		this.#logger?.trace("results merged and ranked", {
			candidates: results.length,
			deduplicated: merged.size,
			duplicates: results.length - merged.size,
			returned: ranked.length,
			topScore: ranked[0] === undefined ? null : Number(ranked[0].score.toFixed(3)),
		});
		return ranked;
	}

	#limit(input: SearchRequest): number {
		return Math.min(input.maxResults, this.#policy.maxResults, MAX_RESULTS);
	}
}
