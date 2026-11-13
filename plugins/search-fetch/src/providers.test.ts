import { describe, expect, test } from "bun:test";
import { normalizeProviderResults } from "./domain.ts";
import {
	createBraveProvider,
	createGithubProvider,
	createKeylessProvider,
	parseDuckDuckGoHtml,
	parseRssResults,
} from "./providers.ts";

const response = (body: string, contentType = "text/html"): Response =>
	new Response(body, { headers: { "content-type": contentType }, status: 200 });

describe("provider normalization", () => {
	test("parses DuckDuckGo HTML, decodes redirects, and strips snippet markup", () => {
		const html = `<html><body>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example &amp; page</a>
<a class="result__snippet">A <b>useful</b> snippet &amp; more</a>
<a class="result__a" href="https://docs.example.com/guide">Guide</a>
<a class="result__snippet">Second snippet</a>
</body></html>`;
		const results = parseDuckDuckGoHtml(html);
		expect(results).toEqual([
			expect.objectContaining({
				domain: "example.com",
				snippet: "A useful snippet & more",
				title: "Example & page",
				url: "https://example.com/page",
			}),
			expect.objectContaining({
				domain: "docs.example.com",
				snippet: "Second snippet",
				title: "Guide",
				url: "https://docs.example.com/guide",
			}),
		]);
	});

	test("returns no results for a valid empty page and rejects malformed markup", () => {
		expect(
			parseDuckDuckGoHtml("<html><body><a href='/'>home</a> No results</body></html>"),
		).toEqual([]);
		expect(() => parseDuckDuckGoHtml("<html><body>broken")).toThrow("malformed HTML");
		expect(() => parseDuckDuckGoHtml('<a class="result__a" href="not a url">Bad</a>')).toThrow(
			"malformed results",
		);
	});

	test("rejects a payload that contains only malformed rows", () => {
		expect(() =>
			normalizeProviderResults([{ title: "", url: "" }], {
				maxResults: 5,
				providerId: "test",
			}),
		).toThrow("malformed results");
		expect(
			normalizeProviderResults(
				[
					{ title: "Bad", url: "not a url" },
					{ title: "Good", url: "https://example.com/ok", score: 0.4 },
				],
				{ maxResults: 5, providerId: "test" },
			),
		).toEqual([expect.objectContaining({ domain: "example.com", url: "https://example.com/ok" })]);
	});

	test("parses RSS items and rejects malformed RSS", () => {
		const xml = `<rss><channel><item>
<title>News &amp; views</title><link>https://news.example.com/a</link>
<description><![CDATA[<p>Summary</p>]]></description>
<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
</item></channel></rss>`;
		expect(parseRssResults(xml, "news")).toEqual([
			expect.objectContaining({
				publishedAt: "2024-01-01T00:00:00.000Z",
				snippet: "Summary",
				title: "News & views",
				url: "https://news.example.com/a",
			}),
		]);
		expect(() => parseRssResults("<html>not rss</html>", "news")).toThrow("malformed RSS");
	});
});

describe("keyless and optional providers", () => {
	test("queries keyless sources and merges their normalized results", async () => {
		const requested: string[] = [];
		const transport = {
			fetch: (async (input: string | URL | Request) => {
				const url = String(input);
				requested.push(url);
				if (url.includes("duckduckgo.com")) {
					return response(
						'<a class="result__a" href="https://example.com/ddg">DDG</a><a class="result__snippet">Snippet</a>',
					);
				}
				return response(
					JSON.stringify({
						query: {
							search: [
								{
									snippet: "<b>Witch</b>",
									timestamp: "2024-01-01T00:00:00Z",
									title: "Elaina",
								},
							],
						},
					}),
					"application/json",
				);
			}) as unknown as typeof fetch,
		};
		const provider = createKeylessProvider(transport);
		const results = await provider.search(
			{ maxResults: 5, query: "elaina" },
			{ fetch: transport.fetch, now: () => 0 },
		);
		expect(requested).toHaveLength(2);
		expect(results.map((entry) => entry.providerId)).toEqual(["keyless", "keyless"]);
		expect(results[1]).toMatchObject({
			domain: "en.wikipedia.org",
			snippet: "Witch",
			title: "Elaina",
		});
	});

	test("rejects malformed keyless output when every source fails", async () => {
		const transport = {
			fetch: (async () => response("not html or json", "text/plain")) as unknown as typeof fetch,
		};
		const provider = createKeylessProvider(transport);
		await expect(
			provider.search({ maxResults: 5, query: "elaina" }, { fetch: transport.fetch, now: () => 0 }),
		).rejects.toThrow();
	});

	test("skips keyed providers cleanly when no key is configured", async () => {
		let calls = 0;
		const transport = {
			fetch: (async () => {
				calls += 1;
				return response("{}", "application/json");
			}) as unknown as typeof fetch,
		};
		const brave = createBraveProvider(transport, "");
		expect(brave.configured).toBe(false);
		expect(
			await brave.search({ maxResults: 5, query: "x" }, { fetch: transport.fetch, now: () => 0 }),
		).toEqual([]);
		expect(calls).toBe(0);
	});

	test("rejects malformed GitHub payloads", async () => {
		const transport = {
			fetch: (async () =>
				response(
					JSON.stringify({ message: "rate limited" }),
					"application/json",
				)) as unknown as typeof fetch,
		};
		const github = createGithubProvider(transport);
		await expect(
			github.search({ maxResults: 5, query: "x" }, { fetch: transport.fetch, now: () => 0 }),
		).rejects.toThrow("malformed payload");
	});
});
