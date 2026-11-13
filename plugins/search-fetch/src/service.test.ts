import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@tsukaima/sdk";
import { SnapshotCache } from "./cache.ts";
import { domainFromUrl, type SearchProvider, type SearchResult } from "./domain.ts";
import { SearchEngine } from "./engine.ts";
import { DEFAULT_FETCH_POLICY, SafeFetcher } from "./fetch.ts";
import { ProviderGovernor } from "./governor.ts";
import { normalizeSearchPolicy } from "./policy.ts";
import { redactSecretText, redactSecrets } from "./redaction.ts";
import { SearchFetchService } from "./service.ts";

const SECRET = "brave-super-secret-key";
const PUBLIC = "93.184.216.34";

const result = (url: string, providerId: string): SearchResult => ({
	domain: domainFromUrl(url) ?? "example.com",
	providerId,
	score: 0.5,
	snippet: "Snippet with " + SECRET,
	title: "Result",
	url,
});

function createService(
	provider: SearchProvider,
	audits: AuditEntry[],
	fetchImpl?: typeof fetch,
): SearchFetchService {
	const fetchValue = (fetchImpl ??
		(async () =>
			new Response(
				"<html><head><title>Page</title></head><body><p>TOPSECRETPAGEBODY</p></body></html>",
				{
					headers: { "content-type": "text/html" },
				},
			))) as unknown as typeof fetch;
	const governor = new ProviderGovernor({ cooldownMs: 1_000, failureThreshold: 2 });
	const policy = normalizeSearchPolicy({
		cache: { maxBytes: 100_000, maxEntries: 5, ttlMs: 10_000 },
		languagePools: { en: [provider.id] },
		priority: [provider.id],
	});
	const engine = new SearchEngine({
		fetch: fetchValue,
		governor,
		policy,
		providers: [provider],
	});
	const transport = { fetch: fetchValue, resolve: async () => [PUBLIC] };
	const fetcher = new SafeFetcher({ policy: DEFAULT_FETCH_POLICY, transport });
	return new SearchFetchService({
		audit: { record: async (entry) => void audits.push(entry) },
		cache: new SnapshotCache(policy.cache),
		engine,
		fetcher,
		governor,
		policy,
		secrets: [SECRET],
	});
}

describe("search-fetch service", () => {
	test("writes audits without page bodies, query text, or API keys", async () => {
		const audits: AuditEntry[] = [];
		const provider: SearchProvider = {
			capabilities: ["web"],
			id: "p",
			label: "p",
			rateLimit: { perHour: 10, perMinute: 10 },
			search: async () => [result("https://example.com/a", "p")],
		};
		const service = createService(provider, audits);
		const outcome = await service.search({ language: "en", query: "private query text" });
		expect(outcome.status).toBe("ok");
		const fetched = await service.fetchPage("https://example.com/page", "conversation-a");
		expect(fetched.text).toContain("TOPSECRETPAGEBODY");
		const serialized = JSON.stringify(audits);
		expect(serialized).not.toContain("private query text");
		expect(serialized).not.toContain("TOPSECRETPAGEBODY");
		expect(serialized).not.toContain(SECRET);
		expect(audits.map((entry) => entry.action)).toEqual([
			"search-fetch.search",
			"search-fetch.fetch",
		]);
		expect(audits[1]?.payload).toMatchObject({ host: "example.com" });
	});

	test("keeps conversation-scoped snapshots isolated", async () => {
		const audits: AuditEntry[] = [];
		const provider: SearchProvider = {
			capabilities: ["web"],
			id: "p",
			label: "p",
			rateLimit: { perHour: 10, perMinute: 10 },
			search: async () => [],
		};
		const service = createService(provider, audits);
		const fetched = await service.fetchPage("https://example.com/page", "conversation-a");
		expect(
			service.snapshot({ fetchId: fetched.fetchId, maxChars: 100 }, "conversation-b"),
		).toBeUndefined();
		const own = service.snapshot({ fetchId: fetched.fetchId, maxChars: 100 }, "conversation-a");
		expect(own?.text).toContain("TOPSECRETPAGEBODY");
		expect(service.cacheClear({ conversationId: "conversation-a" })).toBe(1);
		expect(service.snapshot({ fetchId: fetched.fetchId }, "conversation-a")).toBeUndefined();
	});

	test("redacts provider secrets from errors and results", async () => {
		const audits: AuditEntry[] = [];
		const provider: SearchProvider = {
			capabilities: ["web"],
			id: "p",
			label: "p",
			rateLimit: { perHour: 10, perMinute: 10 },
			search: async (input) => {
				if (input.query === "fail") throw new Error(`upstream rejected ${SECRET}`);
				return [result("https://example.com/a", "p")];
			},
		};
		const service = createService(provider, audits);
		const tested = await service.testQuery({ provider: "p", query: "fail" });
		expect(tested.status).toBe("error");
		expect(tested.error).toContain("[REDACTED]");
		expect(JSON.stringify(tested)).not.toContain(SECRET);
		const successful = await service.testQuery({ provider: "p", query: "ok" });
		expect(successful.results[0]?.snippet).toContain("[REDACTED]");
	});

	test("redacts sensitive keys and values recursively", () => {
		expect(redactSecretText(`token=${SECRET}`, [SECRET])).toBe("token=[REDACTED]");
		expect(
			redactSecrets({ apiKey: SECRET, nested: { note: SECRET, safe: "ok" } }, [SECRET]),
		).toEqual({ apiKey: "[REDACTED]", nested: { note: "[REDACTED]", safe: "ok" } });
	});
});
