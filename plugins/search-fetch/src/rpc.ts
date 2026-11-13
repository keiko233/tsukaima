import type { PluginContext } from "@tsukaima/sdk";
import type { SearchFetchService } from "./service.ts";

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerSearchFetchRpc(context: PluginContext, service: SearchFetchService): void {
	context.rpc.register("overview", async () => service.redact(service.overview()));

	context.rpc.register("providers.list", async () => {
		const providers = service.providers();
		return {
			providers: service.redact(providers.providers),
		};
	});

	context.rpc.register("providers.update", async (input) =>
		service.redact(await service.updateProvider(input)),
	);

	context.rpc.register("policy.update", async (input) => {
		const policy = await service.updatePolicy(input);
		return service.redact({ cache: service.cacheStats(), policy });
	});

	context.rpc.register("cache.stats", async () => service.cacheStats());

	context.rpc.register("cache.clear", async (input) => {
		const removed = service.cacheClear(input);
		return { removed, stats: service.cacheStats() };
	});

	context.rpc.register("testQuery", async (input) => {
		const payload = record(input);
		if (typeof payload.query !== "string" || payload.query.trim().length === 0) {
			throw new Error("A query is required");
		}
		const result = await service.testQuery(payload);
		return service.redact(result);
	});
}
