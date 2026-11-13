import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { auditLog } from "@elaina/db";
import { resolveToolPolicyAccess } from "@elaina/sdk";
import {
	SEARCH_FETCH_TRANSPORT_BINDING,
	type SearchFetchTransportBinding,
} from "@elaina-plugin/search-fetch";
import { createApp } from "../src/app.ts";

const directories: string[] = [];
const BRAVE_SECRET = "brave-secret-key-value";

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

const DDG_HTML = `<html><body>
<a class="result__a" href="https://example.com/elaina">Elaina result</a>
<a class="result__snippet">A useful snippet</a>
</body></html>`;
const WIKI_JSON = JSON.stringify({
	query: { search: [{ snippet: "Witch", title: "Elaina", timestamp: "2024-01-01T00:00:00Z" }] },
});
const PAGE_HTML = `<html lang="en"><head><title>Safe page</title></head><body>
<script>script-secret-body()</script><nav>Menu</nav><p>TOPSECRET PAGE BODY</p></body></html>`;

function createTransport(): SearchFetchTransportBinding {
	return {
		fetch: (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.hostname === "html.duckduckgo.com") {
				return new Response(DDG_HTML, { headers: { "content-type": "text/html" } });
			}
			if (url.hostname.endsWith(".wikipedia.org")) {
				return new Response(WIKI_JSON, { headers: { "content-type": "application/json" } });
			}
			if (url.hostname === "example.com" && url.pathname === "/page") {
				return new Response(PAGE_HTML, { headers: { "content-type": "text/html" } });
			}
			if (url.hostname === "redirect.example.com") {
				return new Response(null, {
					headers: { location: "http://169.254.169.254/latest/meta-data" },
					status: 302,
				});
			}
			throw new Error(`Unexpected network request in test: ${url.hostname}`);
		}) as unknown as typeof fetch,
		resolve: async () => ["93.184.216.34"],
	};
}

async function createLifecycle(env: Record<string, string | undefined> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "elaina-search-fetch-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			ELAINA_DATA_DIR: directory,
			ELAINA_PORT: "7420",
			...env,
		},
		{
			pluginBindings: new Map([[SEARCH_FETCH_TRANSPORT_BINDING, createTransport()]]),
		},
	);
	await lifecycle.start();
	return lifecycle;
}

const decodeTool = (result: {
	readonly result: { readonly content: readonly { text: string }[] };
}) => JSON.parse(result.result.content[0]?.text ?? "{}") as Record<string, unknown>;

describe("search-fetch host integration", () => {
	test("registers tools and RPCs, redacts secrets, and runs offline searches", async () => {
		const lifecycle = await createLifecycle({
			ELAINA_SEARCH_BRAVE_API_KEY: BRAVE_SECRET,
		});
		try {
			const entry = (await lifecycle.pluginHost.list()).find(
				(plugin) => plugin.id === "search-fetch",
			);
			expect(entry).toBeDefined();
			expect(entry?.secretKeys).toEqual(["braveApiKey", "serperApiKey", "tavilyApiKey"]);
			expect(entry?.secretsSet).toContain("braveApiKey");
			expect(JSON.stringify(entry?.config)).not.toContain(BRAVE_SECRET);
			expect(entry?.tools).toEqual([
				"search-fetch.web",
				"search-fetch.multi",
				"search-fetch.domain",
				"search-fetch.fetch",
				"search-fetch.snapshot",
			]);
			expect(entry?.rpcMethods).toEqual(
				expect.arrayContaining([
					"search-fetch.overview",
					"search-fetch.providers.list",
					"search-fetch.providers.update",
					"search-fetch.policy.update",
					"search-fetch.cache.stats",
					"search-fetch.cache.clear",
					"search-fetch.testQuery",
				]),
			);

			const overview = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.overview",
				{},
				"search-fetch",
			)) as {
				providers: readonly { configured: boolean; id: string }[];
			};
			expect(overview.providers.find((row) => row.id === "brave")?.configured).toBe(true);
			expect(JSON.stringify(overview)).not.toContain(BRAVE_SECRET);

			const web = await lifecycle.pluginHost.invokeTool("search-fetch.web", {
				language: "en",
				query: "elaina",
			});
			expect(web.ok).toBe(true);
			if (!web.ok) throw new Error("tool failed");
			const webResult = decodeTool(web);
			expect(webResult).toMatchObject({ count: 2, notFound: false, status: "ok" });
			expect(JSON.stringify(webResult)).not.toContain(BRAVE_SECRET);

			const testQuery = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.testQuery",
				{ provider: "auto", query: "elaina" },
				"search-fetch",
			)) as {
				latencyMs: number;
				resultCount: number;
				results: readonly { domain: string }[];
				status: string;
			};
			expect(testQuery.status).toBe("ok");
			expect(testQuery.resultCount).toBeGreaterThan(0);
			expect(testQuery.latencyMs).toBeGreaterThanOrEqual(0);
			expect(JSON.stringify(testQuery)).not.toContain(BRAVE_SECRET);
		} finally {
			await lifecycle.stop();
		}
	});

	test("fetches safely, scopes snapshots, and audits without bodies or secrets", async () => {
		const lifecycle = await createLifecycle({
			ELAINA_SEARCH_BRAVE_API_KEY: BRAVE_SECRET,
		});
		try {
			const fetched = await lifecycle.pluginHost.invokeTool(
				"search-fetch.fetch",
				{ url: "https://example.com/page" },
				{ conversationId: "conv-a" },
			);
			expect(fetched.ok).toBe(true);
			if (!fetched.ok) throw new Error("fetch tool failed");
			const page = decodeTool(fetched);
			expect(page.text).toContain("TOPSECRET PAGE BODY");
			expect(page.text).not.toContain("script-secret-body");
			expect(page.text).not.toContain("Menu");
			expect(page.fetchId).toMatch(/^snap_/u);

			const sameScope = await lifecycle.pluginHost.invokeTool(
				"search-fetch.snapshot",
				{ fetchId: page.fetchId },
				{ conversationId: "conv-a" },
			);
			if (!sameScope.ok) throw new Error("snapshot tool failed");
			expect(decodeTool(sameScope)).toMatchObject({ found: true });
			const otherScope = await lifecycle.pluginHost.invokeTool(
				"search-fetch.snapshot",
				{ fetchId: page.fetchId },
				{ conversationId: "conv-b" },
			);
			if (!otherScope.ok) throw new Error("snapshot tool failed");
			expect(decodeTool(otherScope)).toMatchObject({ found: false, notFound: true });

			const denied = await lifecycle.pluginHost.invokeTool(
				"search-fetch.fetch",
				{ url: "http://127.0.0.1/" },
				{ conversationId: "conv-a" },
			);
			if (!denied.ok) throw new Error("denied fetch tool failed");
			expect(decodeTool(denied)).toMatchObject({ code: "blocked_ip", status: "error" });

			const redirect = await lifecycle.pluginHost.invokeTool(
				"search-fetch.fetch",
				{ url: "https://redirect.example.com/start" },
				{ conversationId: "conv-a" },
			);
			if (!redirect.ok) throw new Error("redirect fetch tool failed");
			expect(decodeTool(redirect)).toMatchObject({ code: "blocked_ip", status: "error" });

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database unavailable");
			const audits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "search-fetch.fetch"));
			expect(audits.length).toBeGreaterThanOrEqual(2);
			const serialized = JSON.stringify(audits);
			expect(serialized).not.toContain("TOPSECRET PAGE BODY");
			expect(serialized).not.toContain("script-secret-body");
			expect(serialized).not.toContain(BRAVE_SECRET);
			expect(audits[0]?.payloadJson).toContain("example.com");

			const stats = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.cache.stats",
				{},
				"search-fetch",
			)) as { entries: number };
			expect(stats.entries).toBe(1);
			const cleared = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.cache.clear",
				{},
				"search-fetch",
			)) as { removed: number; stats: { entries: number } };
			expect(cleared.removed).toBe(1);
			expect(cleared.stats.entries).toBe(0);
		} finally {
			await lifecycle.stop();
		}
	});

	test("enforces tool policy, permissions, conversation allowlist, and admin mutations", async () => {
		const lifecycle = await createLifecycle();
		try {
			const context = lifecycle.pluginHost.context("search-fetch");
			if (context === undefined) throw new Error("plugin context unavailable");
			const fetchTool = context.tools.list().find((tool) => tool.name === "search-fetch.fetch");
			const snapshotTool = context.tools
				.list()
				.find((tool) => tool.name === "search-fetch.snapshot");
			if (fetchTool === undefined || snapshotTool === undefined) throw new Error("tools missing");
			expect(fetchTool.policy).toMatchObject({
				maxConcurrent: 2,
				maxPayloadBytes: 4_096,
				timeoutMs: 20_000,
				visibility: "model",
			});
			expect(
				resolveToolPolicyAccess(fetchTool, {
					grantedPermissions: ["network.search", "conversation.read"],
				}),
			).toMatchObject({ allowed: false, reason: "permission_denied:network.fetch" });
			expect(
				resolveToolPolicyAccess(fetchTool, {
					conversationId: "conv-a",
					conversationAllowedTools: [],
					grantedPermissions: ["network.fetch", "conversation.read"],
				}),
			).toMatchObject({ allowed: false, reason: "conversation_tool_denied" });

			const noConversation = await lifecycle.pluginHost.invokeTool("search-fetch.fetch", {
				url: "https://example.com/page",
			});
			expect(noConversation.ok).toBe(false);
			if (!noConversation.ok) expect(noConversation.reason).toBe("unauthorized");

			const oversized = await lifecycle.pluginHost.invokeTool(
				"search-fetch.snapshot",
				{ fetchId: "snap", padding: "a".repeat(5_000) },
				{ conversationId: "conv-a" },
			);
			expect(oversized.ok).toBe(false);
			if (!oversized.ok) expect(oversized.reason).toBe("payload_too_large");

			const providerUpdate = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.providers.update",
				{ enabled: false, id: "github" },
				"search-fetch",
			)) as { providers: readonly { enabled: boolean; id: string }[] };
			expect(providerUpdate.providers.find((row) => row.id === "github")?.enabled).toBe(false);
			const policyUpdate = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.policy.update",
				{ blockDomains: ["blocked.example"], cache: { ttlMs: 5_000 } },
				"search-fetch",
			)) as { policy: { blockDomains: readonly string[]; cache: { ttlMs: number } } };
			expect(policyUpdate.policy.blockDomains).toEqual(["blocked.example"]);
			expect(policyUpdate.policy.cache.ttlMs).toBe(5_000);

			const failedQuery = (await lifecycle.pluginHost.invokeRpc(
				"search-fetch.testQuery",
				{ provider: "news", query: "no network" },
				"search-fetch",
			)) as { error?: string; resultCount: number; status: string };
			expect(failedQuery.status).toBe("error");
			expect(failedQuery.resultCount).toBe(0);
			expect(failedQuery.error).toBeTruthy();
		} finally {
			await lifecycle.stop();
		}
	});
});
