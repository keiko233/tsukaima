import { Elysia } from "elysia";
import { RPCHandler } from "@orpc/server/fetch";
import type { OneBotTransportFactory } from "@tsukaima/onebot";
import { appRouter } from "./rpc/index.ts";
import { loadConfig } from "./config.ts";
import { TsukaimaLifecycle } from "./lifecycle.ts";
import { encodeSseEvent, type LogBuffer } from "./logging.ts";

export interface CreateAppOptions {
	readonly onebotTransportFactory?: OneBotTransportFactory;
}

const LOG_HEARTBEAT_MS = 15_000;

function createLogEventStream(logs: LogBuffer, request: Request): Response {
	const encoder = new TextEncoder();
	let cleanup: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
				} catch {
					cleanup?.();
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				unsubscribe();
				clearInterval(heartbeat);
				request.signal.removeEventListener("abort", close);
				try {
					controller.close();
				} catch {}
			};
			const heartbeat = setInterval(() => send("heartbeat", {}), LOG_HEARTBEAT_MS);
			heartbeat.unref?.();
			const unsubscribe = logs.subscribe((entry) => send("log", entry));
			cleanup = close;
			request.signal.addEventListener("abort", close, { once: true });
			send("snapshot", logs.snapshot());
		},
		cancel() {
			cleanup?.();
		},
	});
	return new Response(body, {
		headers: {
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"content-type": "text/event-stream; charset=utf-8",
			"x-accel-buffering": "no",
		},
	});
}

export function createApp(
	env: Record<string, string | undefined> = process.env,
	options?: CreateAppOptions,
) {
	const config = loadConfig(env);
	const lifecycle = new TsukaimaLifecycle(config, options);
	const httpLog = lifecycle.logger.child("tsukaima::server::http");
	const handler = new RPCHandler(appRouter);

	const app = new Elysia({ name: "tsukaima-chatbot" })
		.get("/healthz", ({ status }) => {
			const state = lifecycle.state;
			const statusCode = state.state === "failed" || state.state === "maintenance" ? 503 : 200;
			return status(statusCode, state);
		})
		.get("/readyz", ({ status }) => {
			return status(lifecycle.ready ? 204 : 503, undefined);
		})
		.get("/events/logs", ({ request }) => createLogEventStream(lifecycle.logs, request))
		.all(
			"/rpc/*",
			async ({ request }: { request: Request }) => {
				const startedAt = performance.now();
				const path = new URL(request.url).pathname;
				const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
				try {
					const { matched, response } = await handler.handle(request, {
						context: { lifecycle },
						prefix: "/rpc",
					});
					const result = matched
						? (response ?? new Response("No RPC response", { status: 500 }))
						: new Response("Not found", { status: 404 });
					httpLog.debug("RPC request completed", {
						durationMs: Math.round(performance.now() - startedAt),
						method: request.method,
						path,
						requestId,
						status: result.status,
					});
					return result;
				} catch (error) {
					httpLog.error("RPC request failed", {
						durationMs: Math.round(performance.now() - startedAt),
						error: error instanceof Error ? error.message : String(error),
						method: request.method,
						path,
						requestId,
					});
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
