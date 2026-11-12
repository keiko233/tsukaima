import { Elysia } from "elysia";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import type { OneBotTransportFactory } from "@tsukaima/onebot";
import type { TsukaimaPlugin } from "@tsukaima/sdk";
import { appRouter } from "./rpc/index.ts";
import type { TsukaimaApiContext } from "./rpc/base.ts";
import { loadConfig } from "./config.ts";
import { TsukaimaLifecycle } from "./lifecycle.ts";
import { encodeSseEvent, type LogBuffer } from "./logging.ts";
import { AuthService, readSessionToken } from "./services/auth.ts";

export interface CreateAppOptions {
	readonly onebotTransportFactory?: OneBotTransportFactory;
	/** Overrides the built-in plugin set (tests and future plugin sources). */
	readonly plugins?: readonly TsukaimaPlugin[];
}

/**
 * The oRPC handler shared by the server and tests. `ResponseHeadersPlugin` is what lets the auth
 * procedures attach the session cookie (and the cleared cookie on logout) to their responses.
 */
export function createRpcHandler(): RPCHandler<TsukaimaApiContext> {
	return new RPCHandler(appRouter, { plugins: [new ResponseHeadersPlugin()] });
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
	const lifecycle = new TsukaimaLifecycle(config, { ...options, env });
	const httpLog = lifecycle.logger.child("tsukaima::server::http");
	const auth = new AuthService({
		credential: {
			password: config.adminPassword,
			username: config.adminUsername,
		},
		database: () => lifecycle.domainDatabase,
		logger: lifecycle.logger.child("tsukaima::server::auth"),
	});
	auth.start();
	const handler = createRpcHandler();

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
					const sessionToken = readSessionToken(request.headers.get("cookie"));
					const { matched, response } = await handler.handle(request, {
						context: {
							auth,
							lifecycle,
							...(sessionToken === undefined ? {} : { sessionToken }),
						},
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

	return { app, auth, config, lifecycle };
}
