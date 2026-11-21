import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const MCP_PLUGIN_ID = "mcp";
export const MCP_RPC_PREFIX = `${MCP_PLUGIN_ID}.`;
export const MCP_SERVERS_STORAGE_KEY = "servers";

export const mcpManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configSchema: {
		properties: {},
		type: "object",
	},
	hooks: [],
	kind: "builtin",
	name: MCP_PLUGIN_ID,
	permissions: ["ui.panel", "tools", "audit.write", "storage.global"],
	tools: [],
	ui: [],
	version: "0.1.0",
});
