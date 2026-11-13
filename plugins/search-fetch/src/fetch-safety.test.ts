import { describe, expect, test } from "bun:test";
import {
	DEFAULT_FETCH_POLICY,
	SafeFetcher,
	type FetchPolicy,
	type FetchTransport,
} from "./fetch.ts";

const PUBLIC = "93.184.216.34";

function fetcher(
	fetchImpl: typeof fetch,
	overrides: Partial<FetchPolicy> = {},
	resolve: FetchTransport["resolve"] = async () => [PUBLIC],
): SafeFetcher {
	return new SafeFetcher({
		now: () => 1_000,
		policy: { ...DEFAULT_FETCH_POLICY, ...overrides },
		transport: { fetch: fetchImpl, resolve },
	});
}

const htmlResponse = (html: string): Response =>
	new Response(html, { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 });

describe("SSRF-hardened fetcher", () => {
	test("extracts safe HTML text and returns bounded metadata", async () => {
		let requested = "";
		const page = fetcher((async (input: string | URL | Request) => {
			requested = String(input);
			return htmlResponse(
				`<html lang="en"><head><title>Safe page</title><meta name="description" content="Summary"></head><body>
				<script>secretScript()</script><style>.hidden{}</style><nav>Menu</nav>
				<p>Hello&nbsp;&amp; welcome</p><footer>Footer</footer></body></html>`,
			);
		}) as unknown as typeof fetch);
		const result = await page.fetch("https://user:pass@example.com/page");
		expect(requested).toBe("https://example.com/page");
		expect(result).toMatchObject({
			contentType: "text/html",
			description: "Summary",
			finalUrl: "https://example.com/page",
			httpStatus: 200,
			language: "en",
			title: "Safe page",
			truncated: false,
			url: "https://example.com/page",
		});
		expect(result.text).toContain("Hello & welcome");
		for (const forbidden of ["secretScript", ".hidden", "Menu", "Footer"]) {
			expect(result.text).not.toContain(forbidden);
		}
	});

	test("rejects disallowed MIME types and HTTP errors", async () => {
		const image = fetcher(
			(async () =>
				new Response("png", {
					headers: { "content-type": "image/png" },
				})) as unknown as typeof fetch,
		);
		await expect(image.fetch("https://example.com/a.png")).rejects.toMatchObject({
			code: "unsupported_content_type",
		});

		const missing = fetcher((async () => new Response("no type")) as unknown as typeof fetch);
		await expect(missing.fetch("https://example.com/a")).rejects.toMatchObject({
			code: "unsupported_content_type",
		});

		const failure = fetcher(
			(async () =>
				new Response("oops", {
					headers: { "content-type": "text/plain" },
					status: 500,
				})) as unknown as typeof fetch,
		);
		await expect(failure.fetch("https://example.com/a")).rejects.toMatchObject({
			code: "http_error",
		});
	});

	test("aborts oversized streamed bodies before buffering them", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(64)));
				controller.close();
			},
		});
		const large = fetcher(
			(async () =>
				new Response(body, {
					headers: { "content-type": "text/html" },
				})) as unknown as typeof fetch,
			{ maxBytes: 10 },
		);
		await expect(large.fetch("https://example.com/large")).rejects.toMatchObject({
			code: "response_too_large",
		});
	});

	test("rejects redirects to internal destinations and bounds redirect hops", async () => {
		let calls = 0;
		const redirectInternal = fetcher((async () => {
			calls += 1;
			return new Response(null, {
				headers: { location: "http://169.254.169.254/latest/meta-data" },
				status: 302,
			});
		}) as unknown as typeof fetch);
		await expect(redirectInternal.fetch("https://example.com/redirect")).rejects.toMatchObject({
			code: "blocked_ip",
		});
		expect(calls).toBe(1);

		const loop = fetcher(
			(async () =>
				new Response(null, {
					headers: { location: "https://example.com/loop" },
					status: 302,
				})) as unknown as typeof fetch,
			{ maxRedirects: 1 },
		);
		await expect(loop.fetch("https://example.com/loop")).rejects.toMatchObject({
			code: "redirect_limit",
		});
	});

	test("revalidates every external redirect target", async () => {
		const seen: string[] = [];
		const redirected = fetcher((async (input: string | URL | Request) => {
			seen.push(String(input));
			if (String(input).includes("example.com/start")) {
				return new Response(null, {
					headers: { location: "https://cdn.example.com/final" },
					status: 301,
				});
			}
			return htmlResponse("<title>Final</title><p>done</p>");
		}) as unknown as typeof fetch);
		const result = await redirected.fetch("https://example.com/start");
		expect(result.finalUrl).toBe("https://cdn.example.com/final");
		expect(seen).toEqual(["https://example.com/start", "https://cdn.example.com/final"]);
	});

	test("detects DNS rebinding and non-public resolver answers", async () => {
		let calls = 0;
		const rebinding = fetcher(
			(async () => htmlResponse("<p>never</p>")) as unknown as typeof fetch,
			{},
			async () => {
				calls += 1;
				return calls === 1 ? [PUBLIC] : ["93.184.216.35"];
			},
		);
		await expect(rebinding.fetch("https://example.com/rebind")).rejects.toMatchObject({
			code: "dns_rebinding",
		});
		expect(calls).toBe(2);

		const privateDns = fetcher(
			(async () => htmlResponse("<p>never</p>")) as unknown as typeof fetch,
			{},
			async () => ["10.0.0.5"],
		);
		await expect(privateDns.fetch("https://example.com/private")).rejects.toMatchObject({
			code: "blocked_ip",
		});
	});

	test("enforces domain block/allow lists and request timeouts", async () => {
		const blocked = fetcher((async () => htmlResponse("<p>x</p>")) as unknown as typeof fetch, {
			blockDomains: ["blocked.example"],
		});
		await expect(blocked.fetch("https://blocked.example/a")).rejects.toMatchObject({
			code: "blocked_domain",
		});

		const notAllowed = fetcher((async () => htmlResponse("<p>x</p>")) as unknown as typeof fetch, {
			allowDomains: ["example.com"],
		});
		await expect(notAllowed.fetch("https://other.example/a")).rejects.toMatchObject({
			code: "blocked_domain",
		});

		const timeout = fetcher(
			(async () => new Promise<Response>(() => {})) as unknown as typeof fetch,
			{ timeoutMs: 20 },
		);
		await expect(timeout.fetch("https://example.com/slow")).rejects.toMatchObject({
			code: "timeout",
		});
	});

	test("rejects empty bodies and non-http URLs", async () => {
		const empty = fetcher(
			(async () =>
				new Response("", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch,
		);
		await expect(empty.fetch("https://example.com/empty")).rejects.toMatchObject({
			code: "empty_response",
		});
		await expect(empty.fetch("file:///etc/passwd")).rejects.toMatchObject({
			code: "blocked_scheme",
		});
	});
});
