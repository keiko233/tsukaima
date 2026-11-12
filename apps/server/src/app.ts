import { Elysia } from "elysia";
import { RPCHandler } from "@orpc/server/fetch";
import type { OneBotTransportFactory } from "@elaina/onebot";
import { appRouter } from "./rpc/index.ts";
import { loadConfig } from "./config.ts";
import { ElainaLifecycle } from "./lifecycle.ts";

export interface CreateAppOptions {
	readonly onebotTransportFactory?: OneBotTransportFactory;
}

export function createApp(
	env: Record<string, string | undefined> = process.env,
	options?: CreateAppOptions,
) {
	const config = loadConfig(env);
	const lifecycle = new ElainaLifecycle(config, options);
	const handler = new RPCHandler(appRouter);

	const app = new Elysia({ name: "elaina-chatbot" })
		.get("/healthz", ({ status }) => {
			const state = lifecycle.state;
			const statusCode = state.state === "failed" || state.state === "maintenance" ? 503 : 200;
			return status(statusCode, state);
		})
		.get("/readyz", ({ status }) => {
			return status(lifecycle.ready ? 204 : 503, undefined);
		})
		.all(
			"/rpc/*",
			async ({ request }: { request: Request }) => {
				try {
					const { matched, response } = await handler.handle(request, {
						context: { lifecycle },
						prefix: "/rpc",
					});
					return matched
						? (response ?? new Response("No RPC response", { status: 500 }))
						: new Response("Not found", { status: 404 });
				} catch (error) {
					console.error(
						JSON.stringify({
							level: "error",
							message: error instanceof Error ? error.message : String(error),
							path: new URL(request.url).pathname,
							stage: "rpc",
							timestamp: new Date().toISOString(),
						}),
					);
					return new Response(JSON.stringify({ message: "Internal server error" }), {
						headers: { "content-type": "application/json" },
						status: 500,
					});
				}
			},
			{ parse: "none" },
		);

	return { app, config, lifecycle };
}
