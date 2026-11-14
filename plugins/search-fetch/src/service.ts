import { randomUUID } from "node:crypto";
import type { PluginAuditApi, PluginLogger } from "@elaina/sdk";
import { SnapshotCache } from "./cache.ts";
import {
	MAX_RESULTS,
	clampInteger,
	normalizeText,
	recordValue,
	type SearchInput,
	type SearchRequest,
	type SearchResult,
	searchInputSchema,
	truncate,
} from "./domain.ts";
import { SearchEngine, type SearchAttempt, type SearchOutcome } from "./engine.ts";
import { DEFAULT_FETCH_POLICY, SafeFetcher, type FetchPolicy } from "./fetch.ts";
import { ProviderGovernor, type ProviderRuntimeStatus } from "./governor.ts";
import { elapsedMs, errorSummary, hostOf, sanitizedUrl } from "./logging.ts";
import { normalizeSearchPolicy, type SearchPolicy } from "./policy.ts";
import { redactSecretText, redactSecrets } from "./redaction.ts";
import { SafeFetchError } from "./url-policy.ts";

export interface ProviderRow {
	readonly capabilities: readonly string[];
	readonly configured: boolean;
	readonly enabled: boolean;
	readonly id: string;
	readonly label: string;
	readonly priority: number;
	readonly rateLimit: { readonly perHour: number; readonly perMinute: number };
	readonly status: ProviderRuntimeStatus;
}

export interface SearchFetchOverview {
	readonly cache: ReturnType<SnapshotCache["stats"]>;
	readonly policy: SearchPolicy;
	readonly providers: readonly ProviderRow[];
}

export interface TestQueryResult {
	readonly error?: string;
	readonly latencyMs: number;
	readonly provider: string;
	readonly resultCount: number;
	readonly results: readonly SearchResult[];
	readonly status: SearchOutcome["status"];
}

export interface SearchFetchServiceOptions {
	readonly audit?: PluginAuditApi;
	readonly cache: SnapshotCache;
	readonly engine: SearchEngine;
	readonly fetcher: SafeFetcher;
	readonly governor: ProviderGovernor;
	readonly logger?: PluginLogger;
	readonly now?: () => number;
	readonly onPolicyChange?: (policy: SearchPolicy) => Promise<void> | void;
	readonly policy: SearchPolicy;
	readonly secrets: readonly string[];
}

function safeHost(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function normalizeRequest(raw: unknown, policy: SearchPolicy): SearchRequest {
	const parsed = searchInputSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new Error(issue?.message ?? "Invalid search input");
	}
	return {
		...parsed.data,
		maxResults: Math.min(
			parsed.data.maxResults ?? policy.maxResults,
			policy.maxResults,
			MAX_RESULTS,
		),
	};
}

function redactOutcome(outcome: SearchOutcome, secrets: readonly string[]): SearchOutcome {
	const attempts: SearchAttempt[] = outcome.attempts.map((attempt) => ({
		...attempt,
		...(attempt.reason === undefined ? {} : { reason: redactSecretText(attempt.reason, secrets) }),
	}));
	return {
		...outcome,
		attempts,
		...(outcome.error === undefined ? {} : { error: redactSecretText(outcome.error, secrets) }),
	};
}

function redactResults(
	results: readonly SearchResult[],
	secrets: readonly string[],
): readonly SearchResult[] {
	return results.map((result) => ({
		...result,
		snippet: redactSecretText(result.snippet, secrets),
		title: redactSecretText(result.title, secrets),
		url: redactSecretText(result.url, secrets),
	}));
}

/** Coordinates providers, fetch safety, caching, audit, and admin mutations. */
export class SearchFetchService {
	readonly #audit: PluginAuditApi | undefined;
	readonly #cache: SnapshotCache;
	readonly #engine: SearchEngine;
	readonly #fetcher: SafeFetcher;
	readonly #governor: ProviderGovernor;
	readonly #logger: PluginLogger | undefined;
	readonly #now: () => number;
	readonly #onPolicyChange: ((policy: SearchPolicy) => Promise<void> | void) | undefined;
	#policy: SearchPolicy;
	#secrets: readonly string[];

	constructor(options: SearchFetchServiceOptions) {
		this.#audit = options.audit;
		this.#cache = options.cache;
		this.#engine = options.engine;
		this.#fetcher = options.fetcher;
		this.#governor = options.governor;
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
		this.#onPolicyChange = options.onPolicyChange;
		this.#policy = options.policy;
		this.#secrets = options.secrets;
		this.#applyRedactor();
		this.#applyRuntimePolicy();
	}

	get policy(): SearchPolicy {
		return this.#policy;
	}

	get cache(): SnapshotCache {
		return this.#cache;
	}

	updateSecrets(secrets: readonly string[]): void {
		this.#secrets = [...secrets];
		this.#applyRedactor();
		this.#logger?.debug("search-fetch secrets updated", { configuredKeyCount: secrets.length });
	}

	async search(
		raw: unknown,
		options: { readonly multi?: boolean; readonly providers?: readonly string[] } = {},
	): Promise<SearchOutcome> {
		const startedAt = performance.now();
		const input = normalizeRequest(raw, this.#policy);
		const outcome = redactOutcome(
			await this.#engine.search(input, {
				...(options.providers === undefined ? {} : { providers: options.providers }),
				...(options.multi === undefined ? {} : { multi: options.multi }),
			}),
			this.#secrets,
		);
		await this.#recordSearch(input, options, outcome);
		this.#logger?.debug("search completed", {
			attemptCount: outcome.attempts.length,
			durationMs: elapsedMs(startedAt),
			...(outcome.error === undefined ? {} : { error: outcome.error }),
			maxResults: input.maxResults ?? null,
			mode: options.multi === true ? "multi" : "fallback",
			providerIds: outcome.providerIds,
			queryChars: input.query.length,
			resultCount: outcome.results.length,
			status: outcome.status,
		});
		return outcome;
	}

	async fetchPage(
		rawUrl: unknown,
		conversationId?: string,
	): Promise<{ readonly fetchId: string } & Awaited<ReturnType<SafeFetcher["fetch"]>>> {
		const startedAt = performance.now();
		const url = normalizeText(rawUrl);
		const host = hostOf(url);
		try {
			const result = await this.#fetcher.fetch(url);
			const fetchId = `snap_${randomUUID()}`;
			this.#cache.set(
				{
					contentType: result.contentType,
					...(result.description === undefined ? {} : { description: result.description }),
					fetchId,
					fetchedAtMs: result.fetchedAtMs,
					finalUrl: result.finalUrl,
					...(result.language === undefined ? {} : { language: result.language }),
					status: result.httpStatus,
					text: result.text,
					title: result.title,
					url: result.url,
				},
				conversationId,
			);
			await this.#audit?.record({
				action: "search-fetch.fetch",
				actorKind: "agent",
				payload: {
					bytes: result.bytes,
					contentType: result.contentType,
					fetchId,
					host: safeHost(result.finalUrl),
					truncated: result.truncated,
				},
				result: "ok",
				targetId: fetchId,
				targetKind: "web-page",
			});
			this.#logger?.debug("page fetched", {
				bytes: result.bytes,
				chars: result.text.length,
				contentType: result.contentType,
				durationMs: elapsedMs(startedAt),
				fetchId,
				finalHost: safeHost(result.finalUrl),
				host,
				httpStatus: result.httpStatus,
				scoped: conversationId !== undefined,
				truncated: result.truncated,
			});
			return { ...result, fetchId };
		} catch (error) {
			const code = error instanceof SafeFetchError ? error.code : "network_error";
			await this.#audit?.record({
				action: "search-fetch.fetch",
				actorKind: "agent",
				payload: { code, host: safeHost(url) },
				reason: code,
				result: "failed",
				targetId: safeHost(url),
				targetKind: "web-page",
			});
			this.#logger?.debug("page fetch failed", {
				code,
				durationMs: elapsedMs(startedAt),
				error: redactSecretText(errorSummary(error), this.#secrets),
				host,
				target: sanitizedUrl(url),
			});
			throw error;
		}
	}

	snapshot(
		raw: unknown,
		conversationId?: string,
	):
		| {
				readonly fetchId: string;
				readonly finalUrl: string;
				readonly offset: number;
				readonly text: string;
				readonly title: string;
				readonly totalChars: number;
				readonly truncated: boolean;
				readonly url: string;
		  }
		| undefined {
		const record = recordValue(raw);
		const fetchId = normalizeText(record.fetchId);
		if (fetchId.length === 0) return undefined;
		const cached = this.#cache.get(fetchId, conversationId);
		if (cached === undefined) {
			this.#logger?.debug("snapshot miss", {
				conversationScoped: conversationId !== undefined,
				fetchId,
			});
			return undefined;
		}
		const offset = clampInteger(record.offset, 0, cached.text.length, 0);
		const maxChars = clampInteger(record.maxChars, 1, 8_000, 4_000);
		const { text, truncated } = truncate(cached.text.slice(offset), maxChars);
		const result = {
			fetchId,
			finalUrl: cached.finalUrl,
			offset,
			text: redactSecretText(text, this.#secrets),
			title: redactSecretText(cached.title, this.#secrets),
			totalChars: cached.text.length,
			truncated: truncated || offset + text.length < cached.text.length,
			url: cached.url,
		};
		this.#logger?.debug("snapshot served", {
			chars: result.text.length,
			conversationScoped: cached.conversationId !== undefined,
			fetchId,
			offset,
			totalChars: result.totalChars,
			truncated: result.truncated,
		});
		return result;
	}

	overview(): SearchFetchOverview {
		return {
			cache: this.#cache.stats(),
			policy: this.#policy,
			providers: this.providers().providers,
		};
	}

	providers(): { readonly providers: readonly ProviderRow[] } {
		const disabled = new Set(this.#policy.disabledProviders);
		const allowed = new Set(this.#policy.allowedProviders);
		const priority = [...this.#policy.priority];
		return {
			providers: this.#engine.listProviders().map((provider, index) => {
				const position = priority.indexOf(provider.id);
				return {
					capabilities: provider.capabilities,
					configured: provider.configured !== false,
					enabled:
						!disabled.has(provider.id) &&
						provider.configured !== false &&
						(allowed.size === 0 || allowed.has(provider.id)),
					id: provider.id,
					label: provider.label,
					priority: position === -1 ? priority.length + index : position,
					rateLimit: this.#governor.getLimit(provider.id),
					status: this.#governor.status(provider.id),
				};
			}),
		};
	}

	async updateProvider(raw: unknown): Promise<SearchFetchOverview> {
		const record = recordValue(raw);
		const providerId = normalizeText(record.id ?? record.providerId);
		const provider = this.#engine.provider(providerId);
		if (provider === undefined) throw new Error("Unknown search provider");
		const disabled = new Set(this.#policy.disabledProviders);
		const allowed = new Set(this.#policy.allowedProviders);
		if (typeof record.enabled === "boolean") {
			if (record.enabled) {
				disabled.delete(providerId);
				if (allowed.size > 0) allowed.add(providerId);
			} else {
				disabled.add(providerId);
			}
		}
		let nextPriority = [...this.#policy.priority].filter((id) => id !== providerId);
		if (typeof record.priority === "number" && Number.isFinite(record.priority)) {
			const index = clampInteger(record.priority, 0, nextPriority.length, nextPriority.length);
			nextPriority.splice(index, 0, providerId);
		} else {
			nextPriority = [providerId, ...nextPriority];
		}
		if (Array.isArray(record.fallbacks)) {
			const fallbacks = record.fallbacks
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0 && entry !== providerId);
			nextPriority = [
				providerId,
				...fallbacks,
				...nextPriority.filter((id) => id !== providerId && !fallbacks.includes(id)),
			];
		}
		const languagePools =
			record.languagePools === undefined
				? this.#policy.languagePools
				: { ...this.#policy.languagePools, ...recordValue(record.languagePools) };
		if (record.resetCooldown === true) this.#governor.reset(providerId);
		await this.#commitPolicy(
			normalizeSearchPolicy({
				...this.#policy,
				allowedProviders: [...allowed],
				disabledProviders: [...disabled],
				languagePools,
				priority: nextPriority,
			}),
		);
		this.#logger?.debug("provider updated", {
			configured: provider.configured !== false,
			enabled: !disabled.has(providerId),
			providerId,
			resetCooldown: record.resetCooldown === true,
			priority: nextPriority.indexOf(providerId),
		});
		return this.overview();
	}

	async updatePolicy(raw: unknown): Promise<SearchPolicy> {
		const record = recordValue(raw);
		if (record.clearCooldowns === true) this.#governor.reset();
		const patch: Record<string, unknown> = {};
		for (const key of [
			"allowDomains",
			"allowedProviders",
			"blockDomains",
			"cooldownMs",
			"disabledProviders",
			"failureThreshold",
			"maxProviders",
			"maxResults",
			"priority",
			"searchTimeoutMs",
		] as const) {
			if (record[key] !== undefined) patch[key] = record[key];
		}
		if (record.cache !== undefined) {
			patch.cache = { ...this.#policy.cache, ...recordValue(record.cache) };
		}
		if (record.rateLimits !== undefined) {
			patch.rateLimits = { ...this.#policy.rateLimits, ...recordValue(record.rateLimits) };
		}
		if (record.languagePools !== undefined) {
			patch.languagePools = { ...this.#policy.languagePools, ...recordValue(record.languagePools) };
		}
		await this.#commitPolicy(normalizeSearchPolicy({ ...this.#policy, ...patch }));
		this.#logger?.debug("search policy updated", {
			changedKeys: Object.keys(patch).toSorted(),
			clearCooldowns: record.clearCooldowns === true,
		});
		return this.#policy;
	}

	cacheStats(): ReturnType<SnapshotCache["stats"]> {
		return this.#cache.stats();
	}

	cacheClear(raw: unknown): number {
		const conversationId = normalizeText(recordValue(raw).conversationId);
		const removed = this.#cache.clear(conversationId.length === 0 ? undefined : conversationId);
		this.#logger?.debug("snapshot cache cleared", {
			conversationScoped: conversationId.length > 0,
			removed,
		});
		return removed;
	}

	async testQuery(raw: unknown): Promise<TestQueryResult> {
		const record = recordValue(raw);
		const providerId = normalizeText(record.provider ?? record.engine);
		const startedAt = this.#now();
		const outcome = await this.search(
			{
				language: record.language,
				maxResults: record.maxResults,
				query: record.query,
			},
			providerId.length === 0 || providerId === "auto" ? {} : { providers: [providerId] },
		);
		const result: TestQueryResult = {
			...(outcome.error === undefined ? {} : { error: outcome.error }),
			latencyMs: this.#now() - startedAt,
			provider: providerId.length === 0 || providerId === "auto" ? "auto" : providerId,
			resultCount: outcome.results.length,
			results: redactResults(outcome.results, this.#secrets),
			status: outcome.status,
		};
		this.#logger?.debug("test query completed", {
			latencyMs: result.latencyMs,
			provider: result.provider,
			resultCount: result.resultCount,
			status: result.status,
		});
		return result;
	}

	redact(value: unknown): unknown {
		return redactSecrets(value, this.#secrets);
	}

	async #commitPolicy(policy: SearchPolicy): Promise<void> {
		this.#policy = policy;
		this.#applyRuntimePolicy();
		this.#logger?.debug("search policy committed", {
			allowDomains: policy.allowDomains.length,
			allowedProviders: policy.allowedProviders.length,
			blockDomains: policy.blockDomains.length,
			cache: policy.cache,
			cooldownMs: policy.cooldownMs,
			disabledProviders: policy.disabledProviders.length,
			failureThreshold: policy.failureThreshold,
			maxProviders: policy.maxProviders,
			maxResults: policy.maxResults,
			priority: [...policy.priority],
			searchTimeoutMs: policy.searchTimeoutMs,
		});
		await this.#onPolicyChange?.(policy);
	}

	#applyRedactor(): void {
		this.#engine.setRedactor((value) => redactSecretText(value, this.#secrets));
	}

	#applyRuntimePolicy(): void {
		this.#engine.setPolicy(this.#policy);
		const fetchPolicy: FetchPolicy = {
			...DEFAULT_FETCH_POLICY,
			allowDomains: this.#policy.allowDomains,
			blockDomains: this.#policy.blockDomains,
		};
		this.#fetcher.setPolicy(fetchPolicy);
		this.#cache.configure(this.#policy.cache);
	}

	async #recordSearch(
		input: SearchInput,
		options: { readonly multi?: boolean; readonly providers?: readonly string[] },
		outcome: SearchOutcome,
	): Promise<void> {
		await this.#audit?.record({
			action: "search-fetch.search",
			actorKind: "agent",
			payload: {
				attempts: outcome.attempts.map((attempt) => ({
					count: attempt.count,
					providerId: attempt.providerId,
					status: attempt.status,
				})),
				language: input.language ?? null,
				maxResults: input.maxResults ?? null,
				multi: options.multi === true,
				queryLength: input.query.length,
				resultCount: outcome.results.length,
				timeRange: input.timeRange ?? null,
			},
			...(outcome.error === undefined
				? {}
				: { reason: redactSecretText(outcome.error, this.#secrets) }),
			result: outcome.status === "error" ? "failed" : "ok",
			targetKind: "search",
		});
	}
}
