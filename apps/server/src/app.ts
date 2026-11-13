import { Elysia } from "elysia";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import type { ElainaPlugin } from "@elaina/sdk";
import { appRouter } from "./rpc/index.ts";
import type { ElainaApiContext } from "./rpc/base.ts";
import { loadConfig } from "./config.ts";
import { ElainaLifecycle, type LifecycleOptions } from "./lifecycle.ts";
import { AuthService } from "./services/auth.ts";
import {
	createLiveEventStream,
	createLogEventStream,
	eventAuthResponse,
} from "./services/event-stream.ts";

export interface CreateAppOptions {
	/** Optional scheduled backup/restore drill; disabled unless an interval is configured. */
	readonly backupDrill?: LifecycleOptions["backupDrill"] | undefined;
	/** Test seam; production should keep SSE authenticated. */
	readonly eventHeartbeatMs?: number;
	/** Opaque host bindings consumed by built-in plugins in tests or embedders. */
	readonly pluginBindings?: ReadonlyMap<string, unknown>;
	/** Overrides the built-in plugin set (tests and future plugin sources). */
	readonly plugins?: readonly ElainaPlugin[];
	/** Reply chunking, quote behavior, and pending-delivery reconciliation timing. */
	readonly reply?: {
		readonly pendingGraceMs?: number;
		readonly reconcileIntervalMs?: number;
		readonly reconcileLookbackMs?: number;
		readonly replyAsQuote?: boolean;
		readonly splitMaxChars?: number;
	};
	/** Disable only in isolated tests; production must keep event streams authenticated. */
	readonly requireAuthForEvents?: boolean;
}

/**
 * The oRPC handler shared by the server and tests. `ResponseHeadersPlugin` is what lets the auth
 * procedures attach the session cookie (and the cleared cookie on logout) to their responses.
 */
export function createRpcHandler(): RPCHandler<ElainaApiContext> {
	return new RPCHandler(appRouter, { plugins: [new ResponseHeadersPlugin()] });
}

export function createApp(
	env: Record<string, string | undefined> = process.env,
	options?: CreateAppOptions,
) {
	const config = loadConfig(env);
	const lifecycle = new ElainaLifecycle(config, { ...options, env });
	const httpLog = lifecycle.logger.child("elaina::server::http");
	const auth = new AuthService({
		audit: (entry) => lifecycle.writeAudit(entry),
		baseUrl: config.publicUrl,
		credential: {
			email: config.adminEmail,
			password: config.adminPassword,
			username: config.adminUsername,
		},
		database: () => lifecycle.domainDatabase,
		logger: lifecycle.logger.child("elaina::server::auth"),
		secret: config.authSecret,
		secureCookies: config.secureCookies,
		trustedOrigins: config.trustedOrigins,
		trustedProxies: config.trustedProxies,
	});
	auth.start();
	lifecycle.onStop(() => auth.stop());
	const handler = createRpcHandler();
	const requireAuthForEvents = options?.requireAuthForEvents ?? true;
	const eventStreamOptions = {
		...(options?.eventHeartbeatMs === undefined ? {} : { heartbeatMs: options.eventHeartbeatMs }),
		logger: lifecycle.logger,
	};

	const app = new Elysia({ name: "elaina-chatbot" })
		.get("/healthz", ({ status }) => {
			const state = lifecycle.state;
			const statusCode = state.state === "failed" || state.state === "maintenance" ? 503 : 200;
			return status(statusCode, state);
		})
		.get("/readyz", ({ status }) => {
			return status(lifecycle.ready ? 204 : 503, undefined);
		})
		.get("/events/logs", async ({ request }) => {
			if (requireAuthForEvents) {
				const denied = await eventAuthResponse(auth, request);
				if (denied !== undefined) return denied;
			}
			return createLogEventStream(lifecycle.logs, request, eventStreamOptions);
		})
		.get("/events/stream", async ({ request }) => {
			if (requireAuthForEvents) {
				const denied = await eventAuthResponse(auth, request);
				if (denied !== undefined) return denied;
			}
			return createLiveEventStream(lifecycle, request, eventStreamOptions);
		})
		.all(
			"/api/auth/*",
			async ({ request, server }: { request: Request; server: unknown }) => {
				const address = (
					server as { requestIP?: (request: Request) => { address: string } | null } | null
				)?.requestIP?.(request);
				return auth.handle(request, address?.address);
			},
			{ parse: "none" },
		)
		.all(
			"/rpc/*",
			async ({ request }: { request: Request }) => {
				const startedAt = performance.now();
				const path = new URL(request.url).pathname;
				const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
				try {
					const { matched, response } = await handler.handle(request, {
						context: {
							auth,
							headers: request.headers,
							lifecycle,
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
