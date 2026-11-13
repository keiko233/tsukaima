import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk";

export const SEARCH_FETCH_PLUGIN_ID = "search-fetch";
export const SEARCH_FETCH_RPC_PREFIX = `${SEARCH_FETCH_PLUGIN_ID}.`;
/** Host binding used by tests/embedders to inject an offline fetch and DNS resolver. */
export const SEARCH_FETCH_TRANSPORT_BINDING = "@tsukaima-plugin/search-fetch/transport";

export const searchFetchManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		braveApiKey: "TSUKAIMA_SEARCH_BRAVE_API_KEY",
		serperApiKey: "TSUKAIMA_SEARCH_SERPER_API_KEY",
		tavilyApiKey: "TSUKAIMA_SEARCH_TAVILY_API_KEY",
	},
	configSchema: {
		properties: {
			allowDomains: { items: { type: "string" }, type: "array" },
			allowedProviders: { items: { type: "string" }, type: "array" },
			blockDomains: { items: { type: "string" }, type: "array" },
			braveApiKey: { type: "string" },
			cache: {
				properties: {
					maxBytes: { type: "integer" },
					maxEntries: { type: "integer" },
					ttlMs: { type: "integer" },
				},
				type: "object",
			},
			cooldownMs: { type: "integer" },
			disabledProviders: { items: { type: "string" }, type: "array" },
			failureThreshold: { type: "integer" },
			languagePools: { type: "object" },
			maxProviders: { type: "integer" },
			maxResults: { type: "integer" },
			priority: { items: { type: "string" }, type: "array" },
			rateLimits: { type: "object" },
			searchTimeoutMs: { type: "integer" },
			serperApiKey: { type: "string" },
			tavilyApiKey: { type: "string" },
		},
		type: "object",
	},
	hooks: [],
	kind: "builtin",
	migrations: [],
	name: SEARCH_FETCH_PLUGIN_ID,
	permissions: [
		"ui.panel",
		"tools",
		"audit.write",
		"network.search",
		"network.fetch",
		"conversation.read",
		"storage.global",
	],
	secretKeys: ["braveApiKey", "serperApiKey", "tavilyApiKey"],
	tools: [],
	ui: [],
	version: "0.1.0",
});
