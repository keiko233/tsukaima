import { describe, expect, test } from "bun:test";
import {
	domainFromUrl,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
} from "./domain.ts";
import { SearchEngine } from "./engine.ts";
import { ProviderGovernor } from "./governor.ts";
import { normalizeSearchPolicy } from "./policy.ts";

const result = (url: string, providerId: string, score = 0.5): SearchResult => ({
	domain: domainFromUrl(url) ?? "example.com",
	providerId,
	score,
	snippet: "",
	title: `${providerId} result`,
	url,
});

function provider(
	id: string,
	search: SearchProvider["search"],
	overrides: Partial<SearchProvider> = {},
): SearchProvider {
	return {
		capabilities: ["web"],
		id,
		label: id,
		rateLimit: { perHour: 100, perMinute: 10 },
		search,
		...overrides,
	};
}

const request = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
	maxResults: 5,
	query: "elaina",
	...overrides,
});

describe("search engine routing", () => {
	test("falls back to the next provider and opens a cooldown after failures", async () => {
		let now = 0;
		const a = provider("a", async () => {
			throw new Error("upstream down");
		});
		const b = provider("b", async () => [result("https://example.com/b", "b")]);
		const governor = new ProviderGovernor({
			cooldownMs: 1_000,
			failureThreshold: 1,
			now: () => now,
		});
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor,
			now: () => now,
			policy: normalizeSearchPolicy({ priority: ["a", "b"] }),
			providers: [a, b],
		});
		const first = await engine.search(request());
		expect(first.status).toBe("ok");
		expect(first.providerIds).toEqual(["b"]);
		expect(first.attempts.map((attempt) => [attempt.providerId, attempt.status])).toEqual([
			["a", "error"],
			["b", "ok"],
		]);
		now = 10;
		const second = await engine.search(request());
		expect(second.status).toBe("ok");
		expect(second.attempts[0]).toMatchObject({
			providerId: "a",
			reason: "cooldown",
			status: "skipped",
		});
		now = 2_000;
		const third = await engine.search(request());
		expect(third.attempts[0]?.status).toBe("error");
	});

	test("honours provider allow and deny lists", async () => {
		const a = provider("a", async () => [result("https://example.com/a", "a")]);
		const b = provider("b", async () => [result("https://example.com/b", "b")]);
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			policy: normalizeSearchPolicy({
				allowedProviders: ["b"],
				disabledProviders: ["b"],
				priority: ["a", "b"],
			}),
			providers: [a, b],
		});
		const outcome = await engine.search(request());
		expect(outcome.status).toBe("error");
		expect(outcome.attempts).toEqual([]);

		const allowedOnly = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			policy: normalizeSearchPolicy({ allowedProviders: ["b"], priority: ["a", "b"] }),
			providers: [a, b],
		});
		expect((await allowedOnly.search(request())).providerIds).toEqual(["b"]);
	});

	test("enforces per-minute rate limits without retry storms", async () => {
		const a = provider("a", async () => [result("https://example.com/a", "a")]);
		const governor = new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 });
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor,
			policy: normalizeSearchPolicy({
				priority: ["a"],
				rateLimits: { a: { perHour: 100, perMinute: 1 } },
			}),
			providers: [a],
		});
		expect((await engine.search(request())).status).toBe("ok");
		const limited = await engine.search(request());
		expect(limited.status).toBe("error");
		expect(limited.error).toContain("rate limited");
		expect(limited.attempts[0]).toMatchObject({ reason: "rate_limited", status: "skipped" });
	});

	test("applies language pools and time-range capability matching", async () => {
		const a = provider("a", async () => [result("https://example.com/a", "a")]);
		const b = provider("b", async () => [result("https://example.com/b", "b")], {
			capabilities: ["web", "time-range"],
		});
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			policy: normalizeSearchPolicy({
				languagePools: { en: ["a"], zh: ["b"] },
				priority: ["a", "b"],
			}),
			providers: [a, b],
		});
		const zh = await engine.search(request({ language: "zh", timeRange: "week" }));
		expect(zh.providerIds).toEqual(["b"]);
		const en = await engine.search(request({ language: "en", timeRange: "week" }));
		expect(en.status).toBe("error");
		expect(en.attempts).toEqual([]);
	});

	test("merges multi-provider results, dedupes normalized URLs, and blends scores", async () => {
		const c = provider("c", async () => [
			result("https://example.com/x?utm_source=c", "c", 0.5),
			result("https://example.com/only-c", "c", 0.4),
		]);
		const d = provider("d", async () => [
			result("https://www.example.com/x", "d", 0.6),
			result("https://example.com/only-d", "d", 0.3),
		]);
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			policy: normalizeSearchPolicy({ priority: ["c", "d"] }),
			providers: [c, d],
		});
		const outcome = await engine.search(request(), { multi: true });
		expect(outcome.status).toBe("ok");
		expect(outcome.results).toHaveLength(3);
		const merged = outcome.results.find((entry) => entry.url.includes("/x"));
		expect(merged).toMatchObject({ domain: "example.com", score: 0.7 });
		expect(outcome.providerIds.toSorted()).toEqual(["c", "d"]);
		expect(
			new Set(outcome.results.map((entry) => entry.url.replace(/^https:\/\/www\./u, "https://")))
				.size,
		).toBe(3);
	});

	test("returns explicit not-found and malformed-output errors", async () => {
		const empty = provider("empty", async () => []);
		const engine = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			policy: normalizeSearchPolicy({ priority: ["empty"] }),
			providers: [empty],
		});
		expect((await engine.search(request())).status).toBe("not_found");

		const malformed = provider("bad", async () => null as unknown as SearchResult[]);
		const broken = new SearchEngine({
			fetch: (async () => new Response()) as unknown as typeof fetch,
			governor: new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 }),
			policy: normalizeSearchPolicy({ priority: ["bad"] }),
			providers: [malformed],
		});
		const outcome = await broken.search(request());
		expect(outcome.status).toBe("error");
		expect(outcome.error).toContain("malformed results");
	});
});
