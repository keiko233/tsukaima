import { fileURLToPath } from "node:url";
import type { PluginContext, TsukaimaPlugin } from "@tsukaima/sdk";
import { mcpManifest } from "./manifest.ts";
import { registerMcpRpc } from "./rpc.ts";
import { McpManager } from "./service.ts";

export { MCP_PLUGIN_ID, MCP_RPC_PREFIX, MCP_SERVERS_STORAGE_KEY, mcpManifest } from "./manifest.ts";
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
	context.ui.setStatus({
		code: servers.length === 0 ? "no_servers" : errored > 0 ? "degraded" : "ready",
		level: servers.length === 0 ? "warning" : errored > 0 ? "error" : "ok",
		metrics: { connected, servers: servers.length, tools },
		summary:
			servers.length === 0
				? "No MCP servers configured"
				: `${connected}/${servers.length} MCP servers connected`,
	});
}

async function openManager(context: PluginContext): Promise<McpRuntime> {
	const manager = new McpManager({
		...(context.audit === undefined ? {} : { audit: context.audit }),
		clientName: "tsukaima",
		logger: context.logger,
		registerTool: (tool) => context.tools.register(tool),
		storage: context.storage,
		unregisterTool: (name) => context.tools.unregister(name),
	});
	await manager.start();
	const refresh = () => summarize(context, manager);
	registerMcpRpc(context, manager, { onChanged: refresh });
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
