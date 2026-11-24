import {
	mcpOAuthCompleteInputSchema,
	mcpOAuthStartInputSchema,
	mcpServerCreateSchema,
	mcpServerIdInputSchema,
	mcpServerToggleInputSchema,
	mcpServerUpdateSchema,
} from "@tsukaima/contracts";
import type { PluginContext, PluginRpcHandler } from "@tsukaima/sdk";
import type { McpManager } from "./service.ts";

export interface McpRpcOptions {
	readonly onChanged?: () => Promise<void> | void;
}

/** WebUI procedures exposed by the plugin page; every input is validated at the boundary. */
export function registerMcpRpc(
	context: PluginContext,
	manager: McpManager,
	options: McpRpcOptions = {},
): void {
	const register = (method: string, handler: PluginRpcHandler): void => {
		context.rpc.register(method, handler);
	};
	const changed = async <T>(operation: () => Promise<T>): Promise<T> => {
		const result = await operation();
		await options.onChanged?.();
		return result;
	};

	register("list", async () => ({ servers: manager.list() }));

	register("create", async (input) =>
		changed(() => manager.create(mcpServerCreateSchema.parse(input))),
	);

	register("update", async (input) =>
		changed(() => manager.update(mcpServerUpdateSchema.parse(input))),
	);

	register("delete", async (input) =>
		changed(() => manager.delete(mcpServerIdInputSchema.parse(input).id)),
	);

	register("reconnect", async (input) =>
		changed(() => manager.reconnect(mcpServerIdInputSchema.parse(input).id)),
	);

	register("toggle", async (input) => {
		const parsed = mcpServerToggleInputSchema.parse(input);
		return changed(() => manager.toggle(parsed.id, parsed.enabled));
	});

	register("startOAuth", async (input) => {
		const parsed = mcpOAuthStartInputSchema.parse(input);
		return changed(() => manager.startOAuth(parsed.id, parsed.callbackOrigin));
	});

	register("completeOAuth", async (input) => {
		const parsed = mcpOAuthCompleteInputSchema.parse(input);
		return changed(() => manager.completeOAuth(parsed));
	});

	register("clearOAuth", async (input) =>
		changed(() => manager.clearOAuth(mcpServerIdInputSchema.parse(input).id)),
	);
}
