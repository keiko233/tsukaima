import { fileURLToPath } from "node:url";
import type { PluginContext, TsukaimaPlugin } from "@tsukaima/sdk";
import { mcpManifest } from "./manifest.ts";
import { MCP_OAUTH_HOST_BINDING, type McpOAuthHost } from "./oauth.ts";
import { registerMcpTools } from "./tools.ts";
import { registerMcpRpc } from "./rpc.ts";
import { McpManager } from "./service.ts";

export {
	MCP_CLEAR_OAUTH_MODEL_NAME,
	MCP_CLEAR_OAUTH_TOOL,
	MCP_COMPLETE_OAUTH_MODEL_NAME,
	MCP_COMPLETE_OAUTH_TOOL,
	MCP_INSTALL_SERVER_MODEL_NAME,
	MCP_INSTALL_SERVER_TOOL,
	MCP_LIST_SERVERS_MODEL_NAME,
	MCP_LIST_SERVERS_TOOL,
	MCP_PLUGIN_ID,
	MCP_RECONNECT_SERVER_MODEL_NAME,
	MCP_RECONNECT_SERVER_TOOL,
	MCP_REMOVE_SERVER_MODEL_NAME,
	MCP_REMOVE_SERVER_TOOL,
	MCP_RPC_PREFIX,
	MCP_SERVERS_STORAGE_KEY,
	MCP_START_OAUTH_MODEL_NAME,
	MCP_START_OAUTH_TOOL,
	MCP_TOGGLE_SERVER_MODEL_NAME,
	MCP_TOGGLE_SERVER_TOOL,
	MCP_UPDATE_SERVER_MODEL_NAME,
	MCP_UPDATE_SERVER_TOOL,
	mcpManifest,
} from "./manifest.ts";
export {
	MCP_OAUTH_CALLBACK_PATH,
	MCP_OAUTH_HOST_BINDING,
	MCP_OAUTH_STORAGE_KEY,
	type McpOAuthCallbackOutcome,
	type McpOAuthCallbackParams,
	type McpOAuthHost,
} from "./oauth.ts";
export {
	MCP_ADMIN_TOOL_NAMES,
	createMcpTools,
	isAdminMcpCaller,
	registerMcpTools,
} from "./tools.ts";
export { registerMcpRpc } from "./rpc.ts";
export {
	McpManager,
	type McpManagerOptions,
	type McpToolCallResult,
	type McpToolContent,
} from "./service.ts";

interface McpRuntime {
	readonly manager: McpManager;
}

const runtimes = new WeakMap<PluginContext, McpRuntime>();

function summarize(context: PluginContext, manager: McpManager): void {
	const servers = manager.list();
	const connected = servers.filter((server) => server.state === "connected").length;
	const tools = servers.reduce((total, server) => total + server.tools.length, 0);
	const errored = servers.filter((server) => server.state === "error").length;
	const authRequired = servers.filter((server) => server.state === "auth_required").length;
	context.ui.setStatus({
		code:
			servers.length === 0
				? "no_servers"
				: errored > 0
					? "degraded"
					: authRequired > 0
						? "auth_required"
						: "ready",
		level: servers.length === 0 || authRequired > 0 ? "warning" : errored > 0 ? "error" : "ok",
		metrics: { authRequired, connected, servers: servers.length, tools },
		summary:
			servers.length === 0
				? "No MCP servers configured"
				: authRequired > 0
					? `${connected}/${servers.length} MCP servers connected (${authRequired} awaiting OAuth)`
					: `${connected}/${servers.length} MCP servers connected`,
	});
}

async function openManager(context: PluginContext): Promise<McpRuntime> {
	const oauthHost = context.dependencies?.get<McpOAuthHost>(MCP_OAUTH_HOST_BINDING);
	let currentManager: McpManager | undefined;
	const refresh = () => {
		if (currentManager !== undefined) summarize(context, currentManager);
	};
	const manager = new McpManager({
		...(context.audit === undefined ? {} : { audit: context.audit }),
		clientName: "tsukaima",
		logger: context.logger,
		...(oauthHost === undefined ? {} : { oauthHost }),
		onChanged: refresh,
		registerTool: (tool) => context.tools.register(tool),
		storage: context.storage,
		unregisterTool: (name) => context.tools.unregister(name),
	});
	currentManager = manager;
	await manager.start();
	registerMcpRpc(context, manager, { onChanged: refresh });
	registerMcpTools(context, manager, { onChanged: refresh });
	const runtime: McpRuntime = { manager };
	runtimes.set(context, runtime);
	refresh();
	return runtime;
}

export const mcpPlugin: TsukaimaPlugin = {
	manifest: mcpManifest,
	rootDir: fileURLToPath(new URL("../", import.meta.url)),
	async setup(context) {
		try {
			await openManager(context);
		} catch (error) {
			// MCP is optional; a broken transport must not stop the server or other plugins.
			context.logger.warn("MCP plugin setup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			context.ui.setStatus({
				code: "setup_failed",
				level: "error",
				summary: "MCP plugin could not start",
			});
		}
	},
	async teardown(context) {
		const runtime = runtimes.get(context);
		if (runtime === undefined) return;
		runtimes.delete(context);
		await runtime.manager.stop();
		context.ui.setStatus(null);
	},
};

export default mcpPlugin;
