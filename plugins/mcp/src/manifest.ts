import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const MCP_PLUGIN_ID = "mcp";
export const MCP_RPC_PREFIX = `${MCP_PLUGIN_ID}.`;
export const MCP_SERVERS_STORAGE_KEY = "servers";
export const MCP_LIST_SERVERS_TOOL = `${MCP_PLUGIN_ID}.list_servers`;
export const MCP_INSTALL_SERVER_TOOL = `${MCP_PLUGIN_ID}.install_server`;
export const MCP_UPDATE_SERVER_TOOL = `${MCP_PLUGIN_ID}.update_server`;
export const MCP_TOGGLE_SERVER_TOOL = `${MCP_PLUGIN_ID}.toggle_server`;
export const MCP_RECONNECT_SERVER_TOOL = `${MCP_PLUGIN_ID}.reconnect_server`;
export const MCP_REMOVE_SERVER_TOOL = `${MCP_PLUGIN_ID}.remove_server`;
export const MCP_START_OAUTH_TOOL = `${MCP_PLUGIN_ID}.start_oauth`;
export const MCP_COMPLETE_OAUTH_TOOL = `${MCP_PLUGIN_ID}.complete_oauth`;
export const MCP_CLEAR_OAUTH_TOOL = `${MCP_PLUGIN_ID}.clear_oauth`;
export const MCP_LIST_SERVERS_MODEL_NAME = "mcp_list";
export const MCP_INSTALL_SERVER_MODEL_NAME = "mcp_install";
export const MCP_UPDATE_SERVER_MODEL_NAME = "mcp_update";
export const MCP_TOGGLE_SERVER_MODEL_NAME = "mcp_toggle";
export const MCP_RECONNECT_SERVER_MODEL_NAME = "mcp_reconnect";
export const MCP_REMOVE_SERVER_MODEL_NAME = "mcp_remove";
export const MCP_START_OAUTH_MODEL_NAME = "mcp_start_oauth";
export const MCP_COMPLETE_OAUTH_MODEL_NAME = "mcp_complete_oauth";
export const MCP_CLEAR_OAUTH_MODEL_NAME = "mcp_clear_oauth";

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
