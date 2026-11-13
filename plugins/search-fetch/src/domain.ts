import { z } from "zod";

export const SEARCH_CAPABILITIES = [
	"web",
	"news",
	"time-range",
	"domain",
	"platform",
	"multi",
] as const;

export type SearchCapability = (typeof SEARCH_CAPABILITIES)[number];

export const TIME_RANGES = ["day", "week", "month", "year"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export const MAX_QUERY_LENGTH = 256;
export const MAX_RESULTS = 20;
export const MAX_FETCH_URL_LENGTH = 2_048;
export const MAX_SNAPSHOT_CHARS = 40_000;

export const timeRangeSchema = z.enum(TIME_RANGES);

export const searchResultSchema = z.object({
	cacheRef: z.string().trim().min(1).max(128).optional(),
	domain: z.string().trim().min(1).max(253),
	language: z.string().trim().min(1).max(32).optional(),
	providerId: z.string().trim().min(1).max(64),
	publishedAt: z.string().trim().min(1).max(64).optional(),
	score: z.number().min(0).max(1),
	snippet: z.string().trim().max(4_000),
	title: z.string().trim().min(1).max(500),
	url: z.string().trim().url().max(4_096),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchInputSchema = z.object({
	allowedDomains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
	language: z.string().trim().min(2).max(32).optional(),
	maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
	providers: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
	query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
	timeRange: timeRangeSchema.optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export interface SearchRequest extends SearchInput {
	readonly maxResults: number;
}

export interface ProviderRateLimit {
	readonly perMinute: number;
	readonly perHour: number;
}

export interface SearchProviderContext {
	readonly fetch: typeof fetch;
	readonly signal?: AbortSignal;
	readonly now: () => number;
}

export interface SearchProvider {
	readonly id: string;
	readonly label: string;
	readonly capabilities: readonly SearchCapability[];
	readonly rateLimit: ProviderRateLimit;
	/** Optional language filter; undefined means the provider is language agnostic. */
	readonly languages?: readonly string[];
	/** False when an optional provider has no usable credentials yet. */
	readonly configured?: boolean;
	search(input: SearchRequest, context: SearchProviderContext): Promise<SearchResult[]>;
}

export class ProviderOutputError extends Error {
	readonly providerId: string;
	constructor(providerId: string, message: string) {
		super(message);
		this.name = "ProviderOutputError";
		this.providerId = providerId;
	}
}

export const recordValue = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export const normalizeText = (value: unknown, fallback = ""): string =>
	typeof value === "string" ? value.trim() : fallback;

export const clampInteger = (
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number => {
	const numeric =
		typeof value === "number" && Number.isFinite(value)
			? Math.floor(value)
			: typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))
				? Math.floor(Number(value))
				: fallback;
	return Math.min(max, Math.max(min, numeric));
};

const TRACKING_PARAMS = /^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|spm)$/iu;

/**
 * Stable dedupe key for a result URL: lower-case origin, `www.` stripped, tracking
 * parameters removed, fragment dropped, and query parameters sorted.
 */
export function normalizeUrlForDedupe(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return input.trim();
	}
	const host = url.hostname
		.toLowerCase()
		.replace(/^www\./u, "")
		.replace(/\.$/u, "");
	const port = url.port.length === 0 ? "" : `:${url.port}`;
	const params = [...url.searchParams.entries()]
		.filter(([key]) => !TRACKING_PARAMS.test(key))
		.toSorted(([a], [b]) => a.localeCompare(b));
	const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
	const path = url.pathname.replace(/\/+$/u, "") || "/";
	return `${url.protocol}//${host}${port}${path}${query}`;
}

export function domainFromUrl(input: string): string | undefined {
	try {
		const hostname = new URL(input).hostname
			.toLowerCase()
			.replace(/^www\./u, "")
			.replace(/\.$/u, "");
		return hostname.length === 0 ? undefined : hostname;
	} catch {
		return undefined;
	}
}

export function clampScore(value: unknown, fallback = 0.5): number {
	const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(1, Math.max(0, numeric));
}

/** Normalize one provider row, or return undefined when it cannot be safely shown. */
export function normalizeSearchResult(raw: unknown, providerId: string): SearchResult | undefined {
	const record = recordValue(raw);
	const title = normalizeText(record.title);
	const url = normalizeText(record.url);
	if (title.length === 0 || url.length === 0) return undefined;
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return undefined;
	} catch {
		return undefined;
	}
	const domain = normalizeText(record.domain) || domainFromUrl(url);
	if (domain === undefined || domain.length === 0) return undefined;
	const language = normalizeText(record.language);
	const publishedAt = normalizeText(record.publishedAt);
	const cacheRef = normalizeText(record.cacheRef);
	const parsed = searchResultSchema.safeParse({
		...(cacheRef.length === 0 ? {} : { cacheRef }),
		domain,
		...(language.length === 0 ? {} : { language }),
		providerId,
		...(publishedAt.length === 0 ? {} : { publishedAt }),
		score: clampScore(record.score),
		snippet: normalizeText(record.snippet).slice(0, 4_000),
		title: title.slice(0, 500),
		url,
	});
	return parsed.success ? parsed.data : undefined;
}

export interface NormalizeOptions {
	readonly maxResults: number;
	readonly providerId: string;
}

/**
 * Validate a provider payload. Malformed rows are dropped individually, but a payload that
 * only contains malformed rows is rejected so callers never mistake garbage for "no results".
 */
export function normalizeProviderResults(
	raw: readonly unknown[],
	options: NormalizeOptions,
): SearchResult[] {
	const results: SearchResult[] = [];
	for (const entry of raw) {
		const normalized = normalizeSearchResult(entry, options.providerId);
		if (normalized !== undefined) results.push(normalized);
	}
	if (raw.length > 0 && results.length === 0) {
		throw new ProviderOutputError(options.providerId, "Provider returned malformed results");
	}
	return results.slice(0, options.maxResults);
}

export function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) return { text: value, truncated: false };
	return { text: value.slice(0, maxChars), truncated: true };
}
