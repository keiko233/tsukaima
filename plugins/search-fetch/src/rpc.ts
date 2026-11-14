import type { PluginContext, PluginLogger, PluginRpcHandler } from "@elaina/sdk";
import { elapsedMs, errorSummary, previewText } from "./logging.ts";
import type { SearchFetchService } from "./service.ts";

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Method-aware, secret-safe summary of an RPC payload for the trace line. */
function describeInput(
	service: SearchFetchService,
	method: string,
	input: unknown,
): Record<string, unknown> {
	const payload = record(input);
	switch (method) {
		case "testQuery": {
			const query = typeof payload.query === "string" ? payload.query : "";
			const preview = service.redact(previewText(query));
			return {
				provider: typeof payload.provider === "string" ? payload.provider : "auto",
				query: typeof preview === "string" ? preview : previewText(query),
				queryChars: query.length,
			};
		}
		case "providers.update": {
			return {
				providerId: payload.id ?? payload.providerId ?? null,
				resetCooldown: payload.resetCooldown === true,
			};
		}
		case "policy.update": {
			return { fields: Object.keys(payload).toSorted().slice(0, 20) };
		}
		case "cache.clear": {
			return {
				conversationScoped:
					typeof payload.conversationId === "string" && payload.conversationId.length > 0,
			};
		}
		default: {
			return {};
		}
	}
}

/** Secret-free summary of an RPC result for the debug completion line. */
function describeResult(method: string, result: unknown): Record<string, unknown> {
	const payload = record(result);
	switch (method) {
		case "testQuery": {
			return {
				...(typeof payload.latencyMs === "number" ? { latencyMs: payload.latencyMs } : {}),
				...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
				resultCount: Array.isArray(payload.results) ? payload.results.length : 0,
				...(typeof payload.status === "string" ? { status: payload.status } : {}),
			};
		}
		case "providers.list": {
			return { providers: Array.isArray(payload.providers) ? payload.providers.length : 0 };
		}
		case "providers.update":
		case "overview": {
			return { providers: Array.isArray(payload.providers) ? payload.providers.length : 0 };
		}
		case "cache.clear": {
			return { removed: typeof payload.removed === "number" ? payload.removed : 0 };
		}
		case "cache.stats": {
			return { entries: typeof payload.entries === "number" ? payload.entries : 0 };
		}
		default: {
			return {};
		}
	}
}

function traced(
	logger: PluginLogger | undefined,
	service: SearchFetchService,
	method: string,
	handler: PluginRpcHandler,
): PluginRpcHandler {
	return async (input) => {
		const startedAt = performance.now();
		logger?.trace("rpc invoked", { method, ...describeInput(service, method, input) });
		try {
			const result = await handler(input);
			logger?.debug("rpc completed", {
				durationMs: elapsedMs(startedAt),
				method,
				...describeResult(method, result),
			});
			return result;
		} catch (error) {
			const redacted = service.redact(errorSummary(error));
			logger?.warn("rpc failed", {
				durationMs: elapsedMs(startedAt),
				error: typeof redacted === "string" ? redacted : errorSummary(error),
				method,
			});
			throw error;
		}
	};
}

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerSearchFetchRpc(
	context: PluginContext,
	service: SearchFetchService,
	logger?: PluginLogger,
): void {
	const register = (method: string, handler: PluginRpcHandler): void => {
		context.rpc.register(method, traced(logger, service, method, handler));
	};

	register("overview", async () => service.redact(service.overview()));

	register("providers.list", async () => {
		const providers = service.providers();
		return {
			providers: service.redact(providers.providers),
		};
	});

	register("providers.update", async (input) =>
		service.redact(await service.updateProvider(input)),
	);

	register("policy.update", async (input) => {
		const policy = await service.updatePolicy(input);
		return service.redact({ cache: service.cacheStats(), policy });
	});

	register("cache.stats", async () => service.cacheStats());

	register("cache.clear", async (input) => {
		const removed = service.cacheClear(input);
		return { removed, stats: service.cacheStats() };
	});

	register("testQuery", async (input) => {
		const payload = record(input);
		if (typeof payload.query !== "string" || payload.query.trim().length === 0) {
			throw new Error("A query is required");
		}
		const result = await service.testQuery(payload);
		return service.redact(result);
	});
}
