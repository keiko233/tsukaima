import { Elysia } from "elysia";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { media } from "@elaina/db";
import type { ElainaPlugin } from "@elaina/sdk";
import { eq } from "drizzle-orm";
import { appRouter } from "./rpc/index.ts";
import type { ElainaApiContext } from "./rpc/base.ts";
import { loadConfig, type ElainaConfig } from "./config.ts";
import { ElainaLifecycle, type LifecycleOptions } from "./lifecycle.ts";
import { AuthService } from "./services/auth.ts";
import {
	createLiveEventStream,
	createLogEventStream,
	eventAuthResponse,
} from "./services/event-stream.ts";

/**
 * Bind exclusively so a duplicate or hung process holding the port fails fast
 * with `EADDRINUSE` instead of sharing `SO_REUSEPORT` traffic on Linux.
 */
export function listenOptions(config: Pick<ElainaConfig, "host" | "port">) {
	return {
		hostname: config.host,
		port: config.port,
		reusePort: false,
	} as const;
}

export interface CreateAppOptions {
	/** Optional scheduled backup/restore drill; disabled unless an interval is configured. */
	readonly backupDrill?: LifecycleOptions["backupDrill"] | undefined;
	/** Test seam; production should keep SSE authenticated. */
	readonly eventHeartbeatMs?: number;
	/** Test or embedding override for the model catalog and provider. */
	readonly model?: LifecycleOptions["model"] | undefined;
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
				if (denied !== undefined) {
					httpLog.debug("log event stream unauthorized");
					return denied;
				}
			}
			httpLog.debug("log event stream opened");
			return createLogEventStream(lifecycle.logs, request, eventStreamOptions);
		})
		.get("/events/stream", async ({ request }) => {
			if (requireAuthForEvents) {
				const denied = await eventAuthResponse(auth, request);
				if (denied !== undefined) {
					httpLog.debug("live event stream unauthorized");
					return denied;
				}
			}
			httpLog.debug("live event stream opened");
			return createLiveEventStream(lifecycle, request, eventStreamOptions);
		})
		.get("/media/:mediaId", async ({ params, request, status }) => {
			if (requireAuthForEvents) {
				const denied = await eventAuthResponse(auth, request);
				if (denied !== undefined) return denied;
			}
			const database = lifecycle.domainDatabase;
			if (database === undefined) return status(503, "Database is not ready");
			const [row] = database
				.select({ mimeType: media.mimeType, sha256: media.sha256 })
				.from(media)
				.where(eq(media.id, params.mediaId))
				.limit(1)
				.all();
			if (row === undefined) {
				httpLog.debug("media metadata not found", { mediaId: params.mediaId });
				return status(404, "Media not found");
			}
			let bytes: Uint8Array;
			try {
				bytes = await lifecycle.media.readBytes(row.sha256);
			} catch {
				// The row survived but its bytes are gone; the transcript falls back to the
				// placeholder instead of showing a broken image.
				httpLog.warn("media blob missing from disk", {
					mediaId: params.mediaId,
					sha256: row.sha256,
				});
				return status(404, "Media bytes not found");
			}
			httpLog.trace("media served", {
				bytes: bytes.byteLength,
				mediaId: params.mediaId,
				mimeType: row.mimeType,
			});
			return new Response(bytes, {
				headers: {
					"cache-control": "private, max-age=31536000, immutable",
					"content-length": String(bytes.byteLength),
					"content-type": row.mimeType,
				},
			});
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
					const durationMs = Math.round(performance.now() - startedAt);
					const fields = {
						durationMs,
						method: request.method,
						path,
						requestId,
						status: result.status,
					};
					const isPollingPath =
						result.status < 400 &&
						(path.startsWith("/rpc/admin/diagnostics") ||
							path === "/rpc/admin/overview" ||
							path === "/rpc/health" ||
							path === "/rpc/plugins/list");
					if (isPollingPath) {
						httpLog.trace("RPC request completed", fields);
					} else {
						httpLog.debug("RPC request completed", fields);
					}
					return result;
				} catch (error) {
					httpLog.error("RPC request failed", {
						durationMs: Math.round(performance.now() - startedAt),
						error,
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
