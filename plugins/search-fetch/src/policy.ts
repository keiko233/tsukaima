import { MAX_RESULTS, clampInteger, recordValue, type ProviderRateLimit } from "./domain.ts";

export interface CachePolicy {
	readonly maxBytes: number;
	readonly maxEntries: number;
	readonly ttlMs: number;
}

export interface SearchPolicy {
	readonly allowDomains: readonly string[];
	readonly allowedProviders: readonly string[];
	readonly blockDomains: readonly string[];
	readonly cache: CachePolicy;
	readonly cooldownMs: number;
	readonly disabledProviders: readonly string[];
	readonly failureThreshold: number;
	readonly languagePools: Record<string, readonly string[]>;
	readonly maxProviders: number;
	readonly maxResults: number;
	readonly priority: readonly string[];
	readonly rateLimits: Record<string, ProviderRateLimit>;
	readonly searchTimeoutMs: number;
}

export const DEFAULT_PRIORITY = [
	"keyless",
	"chinese",
	"wikipedia",
	"github",
	"news",
	"brave",
	"tavily",
	"serper",
] as const;

export const DEFAULT_LANGUAGE_POOLS: Record<string, readonly string[]> = {
	en: ["keyless", "wikipedia", "github", "news", "brave", "tavily", "serper"],
	zh: ["chinese", "keyless", "wikipedia", "brave", "tavily", "serper"],
	"zh-cn": ["chinese", "keyless", "wikipedia", "brave", "tavily", "serper"],
	"zh-hans": ["chinese", "keyless", "wikipedia", "brave", "tavily", "serper"],
};

export const DEFAULT_SEARCH_POLICY: SearchPolicy = Object.freeze({
	allowDomains: [],
	allowedProviders: [],
	blockDomains: [],
	cache: { maxBytes: 2_000_000, maxEntries: 64, ttlMs: 10 * 60_000 },
	cooldownMs: 60_000,
	disabledProviders: [],
	failureThreshold: 2,
	languagePools: DEFAULT_LANGUAGE_POOLS,
	maxProviders: 5,
	maxResults: 8,
	priority: DEFAULT_PRIORITY,
	rateLimits: {},
	searchTimeoutMs: 10_000,
});

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
	if (!Array.isArray(value)) return fallback;
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.slice(0, 200);
}

function rateLimit(value: unknown, fallback: ProviderRateLimit): ProviderRateLimit {
	const record = recordValue(value);
	return {
		perHour: clampInteger(record.perHour, 1, 100_000, fallback.perHour),
		perMinute: clampInteger(record.perMinute, 1, 10_000, fallback.perMinute),
	};
}

function languagePools(value: unknown): Record<string, readonly string[]> {
	const record = recordValue(value);
	const pools: Record<string, readonly string[]> = {};
	for (const [language, providers] of Object.entries(record)) {
		if (!Array.isArray(providers)) continue;
		const key = language.trim().toLowerCase();
		if (key.length === 0) continue;
		pools[key] = stringList(providers, []);
	}
	return Object.keys(pools).length === 0 ? DEFAULT_LANGUAGE_POOLS : pools;
}

/** Merge stored/admin policy over the immutable defaults, clamping every numeric field. */
export function normalizeSearchPolicy(raw: unknown, base = DEFAULT_SEARCH_POLICY): SearchPolicy {
	const record = recordValue(raw);
	const cache = recordValue(record.cache);
	const rateLimits: Record<string, ProviderRateLimit> = {};
	for (const [providerId, value] of Object.entries(recordValue(record.rateLimits))) {
		rateLimits[providerId] = rateLimit(value, { perHour: 120, perMinute: 20 });
	}
	return {
		allowDomains: stringList(record.allowDomains, base.allowDomains),
		allowedProviders: stringList(
			record.allowedProviders ?? record.allowProviders,
			base.allowedProviders,
		),
		blockDomains: stringList(record.blockDomains, base.blockDomains),
		cache: {
			maxBytes: clampInteger(cache.maxBytes, 1_024, 100_000_000, base.cache.maxBytes),
			maxEntries: clampInteger(cache.maxEntries, 1, 1_000, base.cache.maxEntries),
			ttlMs: clampInteger(cache.ttlMs, 1_000, 7 * 24 * 60 * 60_000, base.cache.ttlMs),
		},
		cooldownMs: clampInteger(record.cooldownMs, 1_000, 60 * 60_000, base.cooldownMs),
		disabledProviders: stringList(record.disabledProviders, base.disabledProviders),
		failureThreshold: clampInteger(record.failureThreshold, 1, 20, base.failureThreshold),
		languagePools: languagePools(record.languagePools),
		maxProviders: clampInteger(record.maxProviders, 1, 8, base.maxProviders),
		maxResults: clampInteger(record.maxResults, 1, MAX_RESULTS, base.maxResults),
		priority: stringList(record.priority, base.priority),
		rateLimits: { ...base.rateLimits, ...rateLimits },
		searchTimeoutMs: clampInteger(record.searchTimeoutMs, 1_000, 60_000, base.searchTimeoutMs),
	};
}
