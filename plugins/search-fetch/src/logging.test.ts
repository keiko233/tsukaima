import { describe, expect, test } from "bun:test";
import type {
	PluginContext,
	PluginLogger,
	PluginRpcHandler,
	PluginTool,
	ToolInvocationContext,
} from "@elaina/sdk";
import { SnapshotCache } from "./cache.ts";
import { domainFromUrl, type SearchProvider, type SearchResult } from "./domain.ts";
import { SearchEngine } from "./engine.ts";
import { DEFAULT_FETCH_POLICY, SafeFetcher } from "./fetch.ts";
import { ProviderGovernor } from "./governor.ts";
import { normalizeSearchPolicy } from "./policy.ts";
import { redactSecretText } from "./redaction.ts";
import { registerSearchFetchRpc } from "./rpc.ts";
import { SearchFetchService } from "./service.ts";
import { registerSearchFetchTools } from "./tools.ts";

const SECRET = "brave-super-secret-key";
const PUBLIC = "93.184.216.34";

type Level = "debug" | "error" | "info" | "trace" | "warn";

interface LogLine {
	readonly details: Record<string, unknown> | undefined;
	readonly level: Level;
	readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createLogger(): { lines: LogLine[]; logger: PluginLogger } {
	const lines: LogLine[] = [];
	const record =
		(level: Level, target?: string) =>
		(message: string, details?: unknown): void => {
			const merged: Record<string, unknown> = {
				...(target === undefined ? {} : { logger: target }),
				...(isRecord(details) ? details : details === undefined ? {} : { details }),
			};
			lines.push({ details: merged, level, message });
		};
	const make = (target?: string): PluginLogger => ({
		debug: record("debug", target),
		error: record("error", target),
		info: record("info", target),
		trace: record("trace", target),
		warn: record("warn", target),
		child: (nested) => make(target === undefined ? nested : `${target}.${nested}`),
	});
	return { lines, logger: make() };
}

function result(url: string, providerId: string, snippet = "snippet"): SearchResult {
	return {
		domain: domainFromUrl(url) ?? "example.com",
		providerId,
		score: 0.5,
		snippet,
		title: "Result",
		url,
	};
}

function provider(id: string, search: SearchProvider["search"]): SearchProvider {
	return {
		capabilities: ["web"],
		id,
		label: id,
		rateLimit: { perHour: 100, perMinute: 10 },
		search,
	};
}

function cacheEntry(fetchId: string, text = "hello") {
	return {
		contentType: "text/plain",
		fetchId,
		fetchedAtMs: 0,
		finalUrl: `https://example.com/${fetchId}`,
		status: 200,
		text,
		title: fetchId,
		url: `https://example.com/${fetchId}`,
	};
}

function pageResponse(): Response {
	return new Response(
		"<html><head><title>Page</title></head><body><p>BODY TEXT</p></body></html>",
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

function jsonOf(lines: readonly LogLine[]): string {
	return JSON.stringify(lines);
}

function findLine(lines: readonly LogLine[], level: Level, message: string): LogLine | undefined {
	return lines.find((line) => line.level === level && line.message === message);
}

describe("search-fetch logging", () => {
	test("engine logs routing, attempts, and fallback with redacted failures", async () => {
		const { lines, logger } = createLogger();
		const failing = provider("failing", async () => {
			throw new Error(`upstream rejected ${SECRET}`);
		});
		const healthy = provider("healthy", async () => [result("https://example.com/a", "healthy")]);
		const governor = new ProviderGovernor({
			cooldownMs: 1_000,
			failureThreshold: 1,
			logger,
			now: () => 0,
		});
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor,
			logger,
			now: () => 0,
			policy: normalizeSearchPolicy({ priority: ["failing", "healthy"] }),
			providers: [failing, healthy],
			redact: (value) => redactSecretText(value, [SECRET]),
		});

		const outcome = await engine.search({ maxResults: 5, query: "private user query" });
		expect(outcome.status).toBe("ok");

		const failed = findLine(lines, "debug", "provider attempt failed");
		expect(failed?.details).toMatchObject({ providerId: "failing" });
		expect(String(failed?.details?.error)).toContain("[REDACTED]");
		expect(findLine(lines, "debug", "search falling back")?.details).toMatchObject({
			fromProviderId: "failing",
			toProviderId: "healthy",
		});
		expect(findLine(lines, "debug", "search routed")?.details).toMatchObject({
			mode: "fallback",
			resultCount: 1,
			status: "ok",
		});
		expect(findLine(lines, "trace", "search routing")?.details).toMatchObject({
			queryChars: "private user query".length,
		});
		expect(findLine(lines, "warn", "provider circuit opened")?.details).toMatchObject({
			providerId: "failing",
		});
		const serialized = jsonOf(lines);
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("private user query");
	});

	test("engine traces dedupe and domain filtering for multi searches", async () => {
		const { lines, logger } = createLogger();
		const first = provider("first", async () => [
			result("https://example.com/x?utm_source=a", "first"),
			result("https://blocked.example/y", "first"),
		]);
		const second = provider("second", async () => [
			result("https://www.example.com/x", "second"),
			result("https://blocked.example/y", "second"),
		]);
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			logger,
			policy: normalizeSearchPolicy({
				blockDomains: ["blocked.example"],
				priority: ["first", "second"],
			}),
			providers: [first, second],
		});

		await engine.search({ maxResults: 5, query: "dedupe" }, { multi: true });

		expect(findLine(lines, "trace", "results merged and ranked")?.details).toMatchObject({
			candidates: 4,
			deduplicated: 2,
			duplicates: 2,
			returned: 2,
		});
		expect(findLine(lines, "trace", "results filtered")?.details).toMatchObject({
			dropped: 1,
			kept: 1,
			reason: "domain_policy",
		});
	});

	test("fetcher logs completion and warns on policy blocks without leaking query secrets", async () => {
		const { lines, logger } = createLogger();
		const page = new SafeFetcher({
			logger,
			policy: DEFAULT_FETCH_POLICY,
			transport: {
				fetch: (async () => pageResponse()) as unknown as typeof fetch,
				resolve: async () => [PUBLIC],
			},
		});

		const fetched = await page.fetch(`https://example.com/page?token=${SECRET}`);
		expect(fetched.httpStatus).toBe(200);
		expect(findLine(lines, "debug", "fetch completed")?.details).toMatchObject({
			contentType: "text/html",
			finalHost: "example.com",
			httpStatus: 200,
		});
		expect(typeof findLine(lines, "debug", "fetch completed")?.details?.durationMs).toBe("number");
		expect(jsonOf(lines)).not.toContain(SECRET);

		const blocked = new SafeFetcher({
			logger,
			policy: { ...DEFAULT_FETCH_POLICY, blockDomains: ["blocked.example"] },
			transport: {
				fetch: (async () => pageResponse()) as unknown as typeof fetch,
				resolve: async () => [PUBLIC],
			},
		});
		await expect(blocked.fetch("https://blocked.example/a")).rejects.toMatchObject({
			code: "blocked_domain",
		});
		expect(findLine(lines, "warn", "fetch blocked or timed out")?.details).toMatchObject({
			code: "blocked_domain",
		});

		const slow = new SafeFetcher({
			logger,
			policy: { ...DEFAULT_FETCH_POLICY, timeoutMs: 20 },
			transport: {
				fetch: (async () => new Promise<Response>(() => {})) as unknown as typeof fetch,
				resolve: async () => [PUBLIC],
			},
		});
		await expect(slow.fetch("https://example.com/slow")).rejects.toMatchObject({
			code: "timeout",
		});
		const warnings = lines.filter((line) => line.level === "warn");
		expect(warnings.some((line) => line.details?.code === "timeout")).toBe(true);
	});

	test("cache traces hits, misses, and evictions", () => {
		const { lines, logger } = createLogger();
		let now = 0;
		const cache = new SnapshotCache({
			logger,
			maxBytes: 10_000,
			maxEntries: 1,
			now: () => now,
			ttlMs: 500,
		});
		cache.set(cacheEntry("a"));
		expect(cache.get("a")).toBeDefined();
		expect(cache.get("missing")).toBeUndefined();

		now = 501;
		expect(cache.get("a")).toBeUndefined();

		cache.set(cacheEntry("b"));
		cache.set(cacheEntry("c"));
		expect(cache.get("b")).toBeUndefined();

		expect(findLine(lines, "trace", "snapshot cache hit")?.details).toMatchObject({
			fetchId: "a",
		});
		expect(
			lines.some(
				(line) => line.message === "snapshot cache miss" && line.details?.reason === "missing",
			),
		).toBe(true);
		expect(
			lines.some(
				(line) => line.message === "snapshot cache miss" && line.details?.reason === "expired",
			),
		).toBe(true);
		expect(
			lines.some(
				(line) => line.message === "snapshot evicted" && line.details?.reason === "lru_limit",
			),
		).toBe(true);
	});

	test("governor traces rate-limit waits and warns when a circuit opens", () => {
		const { lines, logger } = createLogger();
		let now = 0;
		const governor = new ProviderGovernor({
			cooldownMs: 1_000,
			failureThreshold: 1,
			logger,
			now: () => now,
		});
		governor.setLimit("p", { perHour: 100, perMinute: 1 });
		expect(governor.tryConsume("p").ok).toBe(true);
		expect(governor.tryConsume("p")).toMatchObject({ reason: "rate_limited" });
		expect(findLine(lines, "trace", "provider rate limit wait")?.details).toMatchObject({
			providerId: "p",
			window: "minute",
		});

		governor.recordFailure("p", new Error(`boom ${SECRET}`));
		const opened = findLine(lines, "warn", "provider circuit opened");
		expect(opened?.details).toMatchObject({ failures: 1, providerId: "p" });
		expect(jsonOf(lines)).not.toContain(SECRET);

		now = 5;
		expect(governor.tryConsume("p")).toMatchObject({ reason: "cooldown" });
		expect(findLine(lines, "trace", "provider cooldown wait")?.details).toMatchObject({
			providerId: "p",
			skipReason: "cooldown",
		});
	});

	test("service logs search, fetch, snapshots, and policy changes without secrets", async () => {
		const { lines, logger } = createLogger();
		const searchProvider = provider("p", async () => [
			result("https://example.com/a", "p", `snippet with ${SECRET}`),
		]);
		const governor = new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 });
		const policy = normalizeSearchPolicy({ priority: ["p"] });
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor,
			policy,
			providers: [searchProvider],
		});
		const fetcher = new SafeFetcher({
			policy: DEFAULT_FETCH_POLICY,
			transport: {
				fetch: (async () => pageResponse()) as unknown as typeof fetch,
				resolve: async () => [PUBLIC],
			},
		});
		const service = new SearchFetchService({
			cache: new SnapshotCache(policy.cache),
			engine,
			fetcher,
			governor,
			logger,
			policy,
			secrets: [SECRET],
		});

		const outcome = await service.search({ query: `find ${SECRET}` });
		expect(outcome.status).toBe("ok");
		expect(findLine(lines, "debug", "search completed")?.details).toMatchObject({
			mode: "fallback",
			resultCount: 1,
			status: "ok",
		});
		expect(typeof findLine(lines, "debug", "search completed")?.details?.durationMs).toBe("number");

		const fetched = await service.fetchPage("https://example.com/page", "conversation-a");
		expect(findLine(lines, "debug", "page fetched")?.details).toMatchObject({
			chars: expect.any(Number),
			host: "example.com",
			httpStatus: 200,
			scoped: true,
		});

		expect(service.snapshot({ fetchId: fetched.fetchId }, "conversation-a")).toBeDefined();
		expect(service.snapshot({ fetchId: "snap_missing" }, "conversation-a")).toBeUndefined();
		expect(findLine(lines, "debug", "snapshot served")?.details).toMatchObject({
			conversationScoped: true,
			totalChars: expect.any(Number),
		});
		expect(findLine(lines, "debug", "snapshot miss")?.details).toMatchObject({
			fetchId: "snap_missing",
		});

		await service.updatePolicy({ maxResults: 3 });
		expect(findLine(lines, "debug", "search policy updated")?.details).toMatchObject({
			changedKeys: ["maxResults"],
		});
		service.updateSecrets([SECRET]);
		expect(findLine(lines, "debug", "search-fetch secrets updated")?.details).toMatchObject({
			configuredKeyCount: 1,
		});

		const serialized = jsonOf(lines);
		expect(serialized).not.toContain(SECRET);
	});

	test("tools and rpc log invocations and completions with redacted input", async () => {
		const { lines, logger } = createLogger();
		const searchProvider = provider("p", async () => [result("https://example.com/a", "p")]);
		const governor = new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 });
		const policy = normalizeSearchPolicy({ priority: ["p"] });
		const service = new SearchFetchService({
			cache: new SnapshotCache(policy.cache),
			engine: new SearchEngine({
				fetch: (async () => new Response()) as unknown as typeof fetch,
				governor,
				policy,
				providers: [searchProvider],
			}),
			fetcher: new SafeFetcher({
				policy: DEFAULT_FETCH_POLICY,
				transport: {
					fetch: (async () => pageResponse()) as unknown as typeof fetch,
					resolve: async () => [PUBLIC],
				},
			}),
			governor,
			policy,
			secrets: [SECRET],
		});

		const tools: PluginTool[] = [];
		registerSearchFetchTools(
			{
				tools: { register: (tool: PluginTool) => void tools.push(tool) },
			} as unknown as PluginContext,
			service,
			logger,
		);
		const web = tools.find((tool) => tool.name === "search-fetch.web");
		if (web === undefined) throw new Error("web tool missing");
		const toolResult = await web.execute({ query: `look up ${SECRET}` }, {
			conversationId: "conversation-a",
		} satisfies ToolInvocationContext);
		expect(toolResult.content[0]?.text).toContain('"status":"ok"');
		const invoked = findLine(lines, "trace", "tool invoked");
		expect(invoked?.details).toMatchObject({ tool: "search-fetch.web" });
		expect(String(invoked?.details?.query)).toContain("[REDACTED]");
		expect(findLine(lines, "debug", "tool completed")?.details).toMatchObject({
			resultCount: 1,
			status: "ok",
			tool: "search-fetch.web",
		});
		expect(typeof findLine(lines, "debug", "tool completed")?.details?.durationMs).toBe("number");

		const handlers = new Map<string, PluginRpcHandler>();
		registerSearchFetchRpc(
			{
				rpc: {
					register: (method: string, handler: PluginRpcHandler) => {
						handlers.set(method, handler);
						return () => undefined;
					},
				},
			} as unknown as PluginContext,
			service,
			logger,
		);
		await handlers.get("testQuery")?.({ provider: "p", query: `ask ${SECRET}` });
		expect(findLine(lines, "trace", "rpc invoked")?.details).toMatchObject({
			method: "testQuery",
			provider: "p",
		});
		expect(findLine(lines, "debug", "rpc completed")?.details).toMatchObject({
			method: "testQuery",
			resultCount: 1,
		});
		expect(findLine(lines, "trace", "rpc invoked")?.details?.query).toContain("[REDACTED]");

		await expect(handlers.get("testQuery")?.({ query: "   " })).rejects.toThrow(
			"A query is required",
		);
		expect(findLine(lines, "warn", "rpc failed")?.details).toMatchObject({
			method: "testQuery",
		});

		const serialized = jsonOf(lines);
		expect(serialized).not.toContain(SECRET);
	});
});
