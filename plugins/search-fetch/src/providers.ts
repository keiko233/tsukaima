import {
	normalizeProviderResults,
	type ProviderRateLimit,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
} from "./domain.ts";
import { decodeEntities, stripTags } from "./html.ts";

export interface ProviderTransport {
	readonly fetch: typeof fetch;
}

const DEFAULT_LIMITS: Record<string, ProviderRateLimit> = {
	brave: { perHour: 120, perMinute: 20 },
	chinese: { perHour: 90, perMinute: 12 },
	github: { perHour: 60, perMinute: 10 },
	keyless: { perHour: 120, perMinute: 20 },
	news: { perHour: 60, perMinute: 10 },
	serper: { perHour: 120, perMinute: 20 },
	tavily: { perHour: 120, perMinute: 20 },
	wikipedia: { perHour: 120, perMinute: 20 },
};

export function defaultRateLimit(providerId: string): ProviderRateLimit {
	return DEFAULT_LIMITS[providerId] ?? { perHour: 120, perMinute: 20 };
}

type ApiKeySource = string | (() => string);

function apiKeyReader(source: ApiKeySource): () => string {
	return typeof source === "function" ? () => source().trim() : () => source.trim();
}

async function fetchText(
	providerId: string,
	transport: ProviderTransport,
	url: string,
	init: RequestInit = {},
): Promise<string> {
	const response = await transport.fetch(url, init);
	if (!response.ok) {
		throw new Error(`${providerId} request failed with ${response.status}`);
	}
	return await response.text();
}

async function fetchJson(
	providerId: string,
	transport: ProviderTransport,
	url: string,
	init: RequestInit = {},
): Promise<Record<string, unknown>> {
	const text = await fetchText(providerId, transport, url, init);
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("not an object");
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(`${providerId} returned malformed JSON`);
	}
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is Record<string, unknown> =>
					typeof entry === "object" && entry !== null && !Array.isArray(entry),
			)
		: [];
}

function withLanguage(input: SearchRequest): { readonly language?: string } {
	return input.language === undefined ? {} : { language: input.language };
}

function decodeDuckDuckGoHref(href: string): string {
	const trimmed = decodeEntities(href).trim();
	const absolute = trimmed.startsWith("//")
		? `https:${trimmed}`
		: trimmed.startsWith("/")
			? `https://duckduckgo.com${trimmed}`
			: trimmed;
	try {
		const url = new URL(absolute);
		const redirected = url.searchParams.get("uddg");
		if (redirected !== null) return decodeURIComponent(redirected);
		return url.toString();
	} catch {
		return trimmed;
	}
}

/**
 * Parse DuckDuckGo's HTML/Lite markup. A document with no anchors at all is treated as
 * malformed, while a valid "no results" page yields an empty list.
 */
export function parseDuckDuckGoHtml(html: string, providerId = "keyless"): SearchResult[] {
	const anchors = [
		...html.matchAll(
			/<a\b[^>]*class\s*=\s*"[^"]*result__a[^"]*"[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
		),
	];
	const snippets = [
		...html.matchAll(
			/<(a|div)\b[^>]*class\s*=\s*"[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/\1\s*>/giu,
		),
	].map((match) => stripTags(match[2] ?? ""));
	if (anchors.length === 0) {
		if (/<a\b/iu.test(html) || /no results/iu.test(html)) return [];
		throw new Error(`${providerId} returned malformed HTML`);
	}
	const rows = anchors.map((anchor, index) => ({
		score: Math.max(0.1, 1 - index / Math.max(1, anchors.length)),
		snippet: snippets[index] ?? "",
		title: stripTags(anchor[2] ?? ""),
		url: decodeDuckDuckGoHref(anchor[1] ?? ""),
	}));
	return normalizeProviderResults(rows, {
		maxResults: Math.max(1, anchors.length),
		providerId,
	});
}

function duckDuckGoUrl(query: string): string {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);
	return url.toString();
}

function wikipediaUrl(language: string | undefined, query: string, limit: number): string {
	const wiki = language?.toLowerCase().startsWith("zh") ? "zh" : "en";
	const url = new URL(`https://${wiki}.wikipedia.org/w/api.php`);
	url.searchParams.set("action", "query");
	url.searchParams.set("list", "search");
	url.searchParams.set("srsearch", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("srlimit", String(Math.min(limit, 20)));
	return url.toString();
}

function parseWikipediaPayload(
	payload: Record<string, unknown>,
	providerId: string,
	language: string | undefined,
	maxResults: number,
): SearchResult[] {
	const query = asRecordArray([payload.query])[0];
	const rows = asRecordArray(query?.search);
	if (!Array.isArray(query?.search)) {
		throw new Error(`${providerId} returned malformed payload`);
	}
	const wiki = language?.toLowerCase().startsWith("zh") ? "zh" : "en";
	return normalizeProviderResults(
		rows.map((row, index) => {
			const title = stripTags(String(row.title ?? ""));
			return {
				...(language === undefined ? {} : { language }),
				...(typeof row.timestamp === "string" ? { publishedAt: row.timestamp } : {}),
				score: Math.max(0.1, 1 - index / Math.max(1, rows.length)),
				snippet: stripTags(String(row.snippet ?? "")),
				title,
				url: `https://${wiki}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /gu, "_"))}`,
			};
		}),
		{ maxResults, providerId },
	);
}

export function createKeylessProvider(transport: ProviderTransport): SearchProvider {
	return {
		capabilities: ["web", "domain", "time-range"],
		id: "keyless",
		label: "DuckDuckGo + Wikipedia (keyless)",
		rateLimit: defaultRateLimit("keyless"),
		async search(input) {
			const [ddg, wikipedia] = await Promise.allSettled([
				fetchText("keyless", transport, duckDuckGoUrl(input.query), {
					headers: { accept: "text/html" },
				}).then((html) => parseDuckDuckGoHtml(html, "keyless")),
				fetchText(
					"keyless",
					transport,
					wikipediaUrl(input.language, input.query, input.maxResults),
					{
						headers: { accept: "application/json" },
					},
				).then((text) => {
					let payload: Record<string, unknown>;
					try {
						payload = JSON.parse(text) as Record<string, unknown>;
					} catch {
						throw new Error("keyless returned malformed JSON");
					}
					return parseWikipediaPayload(payload, "keyless", input.language, input.maxResults);
				}),
			]);
			const results = [
				...((ddg.status === "fulfilled" ? ddg.value : []) as SearchResult[]),
				...((wikipedia.status === "fulfilled" ? wikipedia.value : []) as SearchResult[]),
			];
			if (results.length === 0) {
				if (ddg.status === "rejected" && wikipedia.status === "rejected") {
					throw ddg.reason instanceof Error ? ddg.reason : new Error(String(ddg.reason));
				}
				return [];
			}
			return results.slice(0, input.maxResults);
		},
	};
}

const CHINESE_TARGET_DOMAINS = [
	"zhihu.com",
	"bilibili.com",
	"baidu.com",
	"moegirl.org.cn",
	"douban.com",
] as const;

export function createChineseProvider(transport: ProviderTransport): SearchProvider {
	return {
		capabilities: ["web", "domain", "platform", "time-range"],
		id: "chinese",
		label: "Chinese and slang sites",
		languages: ["zh", "zh-cn", "zh-hans"],
		rateLimit: defaultRateLimit("chinese"),
		async search(input) {
			const hints = CHINESE_TARGET_DOMAINS.map((domain) => `site:${domain}`).join(" OR ");
			const query = `${input.query} (${hints})`;
			const html = await fetchText("chinese", transport, duckDuckGoUrl(query), {
				headers: { accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" },
			});
			const parsed = parseDuckDuckGoHtml(html, "chinese");
			const targets = (input.allowedDomains ?? CHINESE_TARGET_DOMAINS).map((domain) =>
				domain.toLowerCase(),
			);
			const filtered = parsed.filter((result) =>
				targets.some((domain) => result.domain === domain || result.domain.endsWith(`.${domain}`)),
			);
			return filtered.slice(0, input.maxResults).map((result) => ({
				...result,
				...withLanguage(input),
			}));
		},
	};
}

export function createWikipediaProvider(transport: ProviderTransport): SearchProvider {
	return {
		capabilities: ["web", "platform", "domain"],
		id: "wikipedia",
		label: "Wikipedia",
		rateLimit: defaultRateLimit("wikipedia"),
		async search(input) {
			const text = await fetchText(
				"wikipedia",
				transport,
				wikipediaUrl(input.language, input.query, input.maxResults),
				{
					headers: { accept: "application/json" },
				},
			);
			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(text) as Record<string, unknown>;
			} catch {
				throw new Error("wikipedia returned malformed JSON");
			}
			return parseWikipediaPayload(payload, "wikipedia", input.language, input.maxResults);
		},
	};
}

export function createGithubProvider(transport: ProviderTransport): SearchProvider {
	return {
		capabilities: ["platform", "web", "domain"],
		id: "github",
		label: "GitHub",
		rateLimit: defaultRateLimit("github"),
		async search(input) {
			const url = new URL("https://api.github.com/search/repositories");
			url.searchParams.set("q", input.query);
			url.searchParams.set("per_page", String(Math.min(input.maxResults, 20)));
			url.searchParams.set("sort", "stars");
			const payload = await fetchJson("github", transport, url.toString(), {
				headers: { accept: "application/vnd.github+json" },
			});
			if (!Array.isArray(payload.items)) {
				throw new Error("github returned malformed payload");
			}
			const items = asRecordArray(payload.items);
			return normalizeProviderResults(
				items.map((row, index) => ({
					...(input.language === undefined ? {} : { language: input.language }),
					score: Math.max(0.1, 1 - index / Math.max(1, items.length)),
					snippet: stripTags(String(row.description ?? "")),
					title: stripTags(String(row.full_name ?? "")),
					url: String(row.html_url ?? ""),
				})),
				{ maxResults: input.maxResults, providerId: "github" },
			);
		},
	};
}

function parseRssDate(value: string): string | undefined {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function parseRssResults(xml: string, providerId: string): SearchResult[] {
	const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/giu)].map(
		(match) => match[1] ?? "",
	);
	if (items.length === 0 && !/<rss\b/iu.test(xml)) {
		throw new Error(`${providerId} returned malformed RSS`);
	}
	const rows = items.map((item, index) => {
		const title = stripTags(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(item)?.[1] ?? "");
		const link = stripTags(/<link\b[^>]*>([\s\S]*?)<\/link\s*>/iu.exec(item)?.[1] ?? "");
		const description = stripTags(
			/<description\b[^>]*>([\s\S]*?)<\/description\s*>/iu.exec(item)?.[1] ?? "",
		);
		const pubDate = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate\s*>/iu.exec(item)?.[1]?.trim();
		const publishedAt = pubDate === undefined ? undefined : parseRssDate(pubDate);
		return {
			...(publishedAt === undefined ? {} : { publishedAt }),
			score: Math.max(0.1, 1 - index / Math.max(1, items.length)),
			snippet: description,
			title,
			url: link.trim(),
		};
	});
	return normalizeProviderResults(rows, { maxResults: rows.length, providerId });
}

export function createNewsProvider(transport: ProviderTransport): SearchProvider {
	return {
		capabilities: ["news", "time-range", "platform"],
		id: "news",
		label: "News RSS",
		rateLimit: defaultRateLimit("news"),
		async search(input) {
			const url = new URL("https://news.google.com/rss/search");
			url.searchParams.set("q", input.query);
			url.searchParams.set("hl", input.language?.startsWith("zh") ? "zh-CN" : "en-US");
			url.searchParams.set("gl", input.language?.startsWith("zh") ? "CN" : "US");
			url.searchParams.set("ceid", input.language?.startsWith("zh") ? "CN:zh-Hans" : "US:en");
			const xml = await fetchText("news", transport, url.toString(), {
				headers: { accept: "application/rss+xml, application/xml, text/xml" },
			});
			return parseRssResults(xml, "news").slice(0, input.maxResults);
		},
	};
}

export function createBraveProvider(
	transport: ProviderTransport,
	apiKeySource: ApiKeySource,
): SearchProvider {
	const apiKey = apiKeyReader(apiKeySource);
	return {
		capabilities: ["web", "news", "time-range", "domain"],
		get configured() {
			return apiKey().length > 0;
		},
		id: "brave",
		label: "Brave Search",
		rateLimit: defaultRateLimit("brave"),
		async search(input) {
			if (apiKey().length === 0) return [];
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", input.query);
			url.searchParams.set("count", String(Math.min(input.maxResults, 20)));
			if (input.language !== undefined) url.searchParams.set("search_lang", input.language);
			const payload = await fetchJson("brave", transport, url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey(),
				},
			});
			const web =
				typeof payload.web === "object" && payload.web !== null
					? (payload.web as Record<string, unknown>)
					: undefined;
			if (web === undefined || !Array.isArray(web.results)) {
				throw new Error("brave returned malformed payload");
			}
			return normalizeProviderResults(
				asRecordArray(web.results).map((row, index) => ({
					...(input.language === undefined ? {} : { language: input.language }),
					score: Math.max(0.1, 1 - index / Math.max(1, asRecordArray(web.results).length)),
					snippet: stripTags(String(row.description ?? "")),
					title: stripTags(String(row.title ?? "")),
					url: String(row.url ?? ""),
				})),
				{ maxResults: input.maxResults, providerId: "brave" },
			);
		},
	};
}

export function createTavilyProvider(
	transport: ProviderTransport,
	apiKeySource: ApiKeySource,
): SearchProvider {
	const apiKey = apiKeyReader(apiKeySource);
	return {
		capabilities: ["web", "news", "time-range", "domain"],
		get configured() {
			return apiKey().length > 0;
		},
		id: "tavily",
		label: "Tavily",
		rateLimit: defaultRateLimit("tavily"),
		async search(input) {
			if (apiKey().length === 0) return [];
			const payload = await fetchJson("tavily", transport, "https://api.tavily.com/search", {
				body: JSON.stringify({
					include_answer: false,
					max_results: Math.min(input.maxResults, 20),
					query: input.query,
					search_depth: "basic",
					...(input.timeRange === undefined ? {} : { time_range: input.timeRange }),
				}),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${apiKey()}`,
					"content-type": "application/json",
				},
				method: "POST",
			});
			if (!Array.isArray(payload.results)) {
				throw new Error("tavily returned malformed payload");
			}
			return normalizeProviderResults(
				asRecordArray(payload.results).map((row) => ({
					...(input.language === undefined ? {} : { language: input.language }),
					...(typeof row.published_date === "string" ? { publishedAt: row.published_date } : {}),
					score: typeof row.score === "number" ? row.score : 0.5,
					snippet: stripTags(String(row.content ?? "")),
					title: stripTags(String(row.title ?? "")),
					url: String(row.url ?? ""),
				})),
				{ maxResults: input.maxResults, providerId: "tavily" },
			);
		},
	};
}

export function createSerperProvider(
	transport: ProviderTransport,
	apiKeySource: ApiKeySource,
): SearchProvider {
	const apiKey = apiKeyReader(apiKeySource);
	return {
		capabilities: ["web", "news", "time-range", "domain"],
		get configured() {
			return apiKey().length > 0;
		},
		id: "serper",
		label: "Serper",
		rateLimit: defaultRateLimit("serper"),
		async search(input) {
			if (apiKey().length === 0) return [];
			const payload = await fetchJson("serper", transport, "https://google.serper.dev/search", {
				body: JSON.stringify({
					num: Math.min(input.maxResults, 20),
					q: input.query,
					...(input.timeRange === undefined ? {} : { tbs: `qdr:${input.timeRange[0]}` }),
				}),
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-api-key": apiKey(),
				},
				method: "POST",
			});
			if (!Array.isArray(payload.organic)) {
				throw new Error("serper returned malformed payload");
			}
			return normalizeProviderResults(
				asRecordArray(payload.organic).map((row, index) => ({
					...(input.language === undefined ? {} : { language: input.language }),
					...(typeof row.date === "string" ? { publishedAt: row.date } : {}),
					score: Math.max(0.1, 1 - index / Math.max(1, asRecordArray(payload.organic).length)),
					snippet: stripTags(String(row.snippet ?? "")),
					title: stripTags(String(row.title ?? "")),
					url: String(row.link ?? ""),
				})),
				{ maxResults: input.maxResults, providerId: "serper" },
			);
		},
	};
}
