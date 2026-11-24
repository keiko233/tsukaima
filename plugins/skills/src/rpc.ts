import {
	skillNameInputSchema,
	skillsTurnContextInputSchema,
	skillsTurnContextResultSchema,
} from "@tsukaima/contracts";
import type { PluginContext, PluginRpcHandler } from "@tsukaima/sdk";
import type { SkillCatalog } from "./catalog.ts";

/**
 * Registers the in-memory WebUI procedures. Every handler returns a contract-shaped value, and
 * invalid turn-context input degrades to an empty result instead of failing a model run.
 */
export function registerSkillsRpc(context: PluginContext, catalog: SkillCatalog): void {
	const register = (method: string, handler: PluginRpcHandler): void => {
		context.rpc.register(method, handler);
	};

	register("snapshot", async () => await catalog.current());

	register("rescan", async () => await catalog.rescan());

	register("get", async (input) => {
		const parsed = skillNameInputSchema.safeParse(input);
		if (!parsed.success) return {};
		return (await catalog.loadDetail(parsed.data.name)) ?? {};
	});

	register("turnContext", async (input) => {
		const parsed = skillsTurnContextInputSchema.safeParse(input);
		if (!parsed.success) return {};
		const text = catalog.renderTurnContext(parsed.data.surface, parsed.data.isAdmin);
		return skillsTurnContextResultSchema.parse(text === undefined ? {} : { text });
	});
}
