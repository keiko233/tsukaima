import type { PluginContext, ToolResult } from "@tsukaima/sdk";
import {
	MAX_FETCH_URL_LENGTH,
	MAX_QUERY_LENGTH,
	MAX_RESULTS,
	MAX_SNAPSHOT_CHARS,
} from "./domain.ts";
import type { SearchOutcome } from "./engine.ts";
import type { SearchFetchService } from "./service.ts";
import { SafeFetchError } from "./url-policy.ts";

const MAX_TOOL_TEXT_CHARS = 8_000;

const text = (value: unknown): ToolResult => ({
	content: [{ text: JSON.stringify(value), type: "text" }],
});

const asString = (input: Record<string, unknown>, key: string): string | undefined => {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const asStringList = (input: Record<string, unknown>, key: string): string[] | undefined => {
	const value = input[key];
	if (typeof value === "string") {
		return value
			.split(/[,，]/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	if (!Array.isArray(value)) return undefined;
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
};

const asNumber = (input: Record<string, unknown>, key: string): number | undefined => {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const asTimeRange = (input: Record<string, unknown>): string | undefined => {
	const value = input.timeRange ?? input.recency;
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
};

function errorText(service: SearchFetchService, error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const redacted = service.redact(raw);
	return typeof redacted === "string" ? redacted : raw;
}

function modelResults(outcome: SearchOutcome) {
	return outcome.results.map((result) => ({
		...(result.cacheRef === undefined ? {} : { cacheRef: result.cacheRef }),
		domain: result.domain,
		...(result.language === undefined ? {} : { language: result.language }),
		...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
		providerId: result.providerId,
		score: Number(result.score.toFixed(3)),
		snippet: result.snippet.slice(0, 500),
		title: result.title,
		url: result.url,
	}));
}

function searchOutput(outcome: SearchOutcome) {
	return {
		...(outcome.error === undefined ? {} : { error: outcome.error }),
		count: outcome.results.length,
		notFound: outcome.status === "not_found",
		providers: outcome.providerIds,
		results: modelResults(outcome),
		status: outcome.status,
	};
}

/** Registers model-visible search and fetch tools with hard input and payload bounds. */
export function registerSearchFetchTools(
	context: PluginContext,
	service: SearchFetchService,
): void {
	context.tools.register({
		description:
			"Search the web through the policy-routed provider with normalized citations. Returns concise results or an explicit not-found error.",
		async execute(input) {
			try {
				const engine = asString(input, "engine");
				const outcome = await service.search(
					{
						language: asString(input, "language"),
						maxResults: asNumber(input, "maxResults"),
						query: asString(input, "query"),
						timeRange: asTimeRange(input),
					},
					engine === undefined || engine === "auto" ? {} : { providers: [engine] },
				);
				return text(searchOutput(outcome));
			} catch (error) {
				return text({
					count: 0,
					error: errorText(service, error),
					notFound: false,
					results: [],
					status: "error",
				});
			}
		},
		name: "search-fetch.web",
		parameters: {
			properties: {
				engine: { type: "string" },
				language: { type: "string" },
				maxResults: { maximum: MAX_RESULTS, minimum: 1, type: "integer" },
				query: { maxLength: MAX_QUERY_LENGTH, type: "string" },
				timeRange: { enum: ["day", "week", "month", "year"], type: "string" },
			},
			required: ["query"],
			type: "object",
		},
		policy: {
			maxConcurrent: 2,
			maxPayloadBytes: 2_048,
			timeoutMs: 15_000,
			visibility: "model",
		},
		requiredPermissions: ["network.search"],
	});
	context.tools.register({
		description:
			"Query multiple eligible search providers concurrently, merge duplicate URLs, and rank blended results.",
		async execute(input) {
			try {
				const providers = asStringList(input, "providers");
				const outcome = await service.search(
					{
						language: asString(input, "language"),
						maxResults: asNumber(input, "maxResults"),
						query: asString(input, "query"),
						timeRange: asTimeRange(input),
					},
					{
						multi: true,
						...(providers === undefined ? {} : { providers }),
					},
				);
				return text(searchOutput(outcome));
			} catch (error) {
				return text({
					count: 0,
					error: errorText(service, error),
					notFound: false,
					results: [],
					status: "error",
				});
			}
		},
		name: "search-fetch.multi",
		parameters: {
			properties: {
				language: { type: "string" },
				maxResults: { maximum: MAX_RESULTS, minimum: 1, type: "integer" },
				providers: { items: { type: "string" }, type: "array" },
				query: { maxLength: MAX_QUERY_LENGTH, type: "string" },
				timeRange: { enum: ["day", "week", "month", "year"], type: "string" },
			},
			required: ["query"],
			type: "object",
		},
		policy: {
			maxConcurrent: 2,
			maxPayloadBytes: 4_096,
			timeoutMs: 20_000,
			visibility: "model",
		},
		requiredPermissions: ["network.search"],
	});
	context.tools.register({
		description:
			"Search only within allowed domains, optionally using recency. Returns normalized, domain-filtered citations.",
		async execute(input) {
			const allowedDomains = asStringList(input, "allowedDomains");
			if (allowedDomains === undefined || allowedDomains.length === 0) {
				return text({
					count: 0,
					error: "At least one allowed domain is required",
					notFound: false,
					results: [],
					status: "error",
				});
			}
			try {
				const outcome = await service.search({
					allowedDomains,
					language: asString(input, "language"),
					maxResults: asNumber(input, "maxResults"),
					query: asString(input, "query"),
					timeRange: asTimeRange(input),
				});
				return text(searchOutput(outcome));
			} catch (error) {
				return text({
					count: 0,
					error: errorText(service, error),
					notFound: false,
					results: [],
					status: "error",
				});
			}
		},
		name: "search-fetch.domain",
		parameters: {
			properties: {
				allowedDomains: { items: { type: "string" }, type: "array" },
				language: { type: "string" },
				maxResults: { maximum: MAX_RESULTS, minimum: 1, type: "integer" },
				query: { maxLength: MAX_QUERY_LENGTH, type: "string" },
				recency: { enum: ["day", "week", "month", "year"], type: "string" },
				timeRange: { enum: ["day", "week", "month", "year"], type: "string" },
			},
			required: ["query", "allowedDomains"],
			type: "object",
		},
		policy: {
			maxConcurrent: 2,
			maxPayloadBytes: 4_096,
			timeoutMs: 15_000,
			visibility: "model",
		},
		requiredPermissions: ["network.search"],
	});
	context.tools.register({
		description:
			"Fetch one public HTTP(S) page with SSRF, redirect, MIME, size, and timeout protections. Returns extracted text and a cache reference for snapshots.",
		async execute(input, invocation) {
			const url = asString(input, "url");
			if (url === undefined || url.length > MAX_FETCH_URL_LENGTH) {
				return text({
					error: "A valid http(s) URL is required",
					notFound: false,
					status: "error",
				});
			}
			try {
				const result = await service.fetchPage(url, invocation.conversationId);
				return text({
					bytes: result.bytes,
					contentType: result.contentType,
					...(result.description === undefined ? {} : { description: result.description }),
					fetchId: result.fetchId,
					finalUrl: result.finalUrl,
					httpStatus: result.httpStatus,
					...(result.language === undefined ? {} : { language: result.language }),
					text: result.text.slice(0, MAX_TOOL_TEXT_CHARS),
					title: result.title,
					truncated: result.truncated || result.text.length > MAX_TOOL_TEXT_CHARS,
					url: result.url,
				});
			} catch (error) {
				const code = error instanceof SafeFetchError ? error.code : "network_error";
				return text({
					code,
					error: errorText(service, error),
					notFound: false,
					status: "error",
				});
			}
		},
		name: "search-fetch.fetch",
		parameters: {
			properties: {
				url: { maxLength: MAX_FETCH_URL_LENGTH, type: "string" },
			},
			required: ["url"],
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			maxConcurrent: 2,
			maxPayloadBytes: 4_096,
			timeoutMs: 20_000,
			visibility: "model",
		},
		requiredPermissions: ["network.fetch", "conversation.read"],
	});
	context.tools.register({
		description:
			"Read a bounded slice of a previously fetched snapshot. Snapshots are conversation-scoped and expire.",
		async execute(input, invocation) {
			const fetchId = asString(input, "fetchId");
			if (fetchId === undefined) {
				return text({ error: "fetchId is required", found: false, notFound: true });
			}
			const snapshot = service.snapshot(
				{
					fetchId,
					maxChars: Math.min(asNumber(input, "maxChars") ?? 4_000, MAX_TOOL_TEXT_CHARS),
					offset: asNumber(input, "offset"),
				},
				invocation.conversationId,
			);
			if (snapshot === undefined) {
				return text({
					error: "Snapshot not found or expired",
					fetchId,
					found: false,
					notFound: true,
				});
			}
			return text({
				fetchId: snapshot.fetchId,
				finalUrl: snapshot.finalUrl,
				found: true,
				offset: snapshot.offset,
				text: snapshot.text.slice(0, Math.min(MAX_SNAPSHOT_CHARS, MAX_TOOL_TEXT_CHARS)),
				title: snapshot.title,
				totalChars: snapshot.totalChars,
				truncated: snapshot.truncated,
				url: snapshot.url,
			});
		},
		name: "search-fetch.snapshot",
		parameters: {
			properties: {
				fetchId: { type: "string" },
				maxChars: { maximum: MAX_TOOL_TEXT_CHARS, minimum: 1, type: "integer" },
				offset: { minimum: 0, type: "integer" },
			},
			required: ["fetchId"],
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			maxConcurrent: 4,
			maxPayloadBytes: 1_024,
			timeoutMs: 10_000,
			visibility: "model",
		},
		requiredPermissions: ["network.fetch", "conversation.read"],
	});
}
