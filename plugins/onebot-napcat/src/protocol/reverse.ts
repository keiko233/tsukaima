import type { ServerWebSocket } from "bun";
import type {
	OneBotReverseConnectionInfo,
	OneBotReverseServer,
	OneBotReverseServerFactory,
	OneBotReverseServerOptions,
	OneBotTransport,
	OneBotTransportEvents,
} from "./types.ts";

/** Extract a token from `Authorization: Bearer ...` or the `access_token` query parameter. */
export function extractReverseAccessToken(
	headers: Headers | Record<string, string | undefined>,
	url: string | URL,
): string | undefined {
	const headerValue =
		headers instanceof Headers
			? headers.get("authorization")
			: (headers.authorization ?? headers.Authorization);
	if (typeof headerValue === "string") {
		const match = /^Bearer\s+(.+)$/iu.exec(headerValue.trim());
		if (match?.[1] !== undefined && match[1].length > 0) return match[1];
	}
	try {
		const parsed = typeof url === "string" ? new URL(url) : url;
		const queryToken = parsed.searchParams.get("access_token");
		if (queryToken !== null && queryToken.length > 0) return queryToken;
	} catch {}
	return undefined;
}

export function isReverseAccessAllowed(
	headers: Headers | Record<string, string | undefined>,
	url: string | URL,
	accessToken: string | undefined,
): boolean {
	if (accessToken === undefined || accessToken.length === 0) return true;
	return extractReverseAccessToken(headers, url) === accessToken;
}

type ReverseTransport = OneBotTransport & { notifyClose: () => void };

type SocketData = {
	readonly info: OneBotReverseConnectionInfo;
	transport: ReverseTransport | undefined;
};

/**
 * Production `ws-reverse` listener. NapCat dials into Elaina, so the token is verified during
 * the HTTP upgrade and rejected with 401 before a WebSocket is created.
 */
export const bunReverseServerFactory: OneBotReverseServerFactory = (
	options: OneBotReverseServerOptions,
): OneBotReverseServer => {
	let server: ReturnType<typeof Bun.serve<SocketData>> | undefined;
	const path = options.path;
	const listeningSockets = new Set<ServerWebSocket<SocketData>>();

	return {
		get port() {
			return server?.port ?? options.port;
		},
		async start() {
			server = Bun.serve<SocketData>({
				fetch(request, bunServer) {
					const url = new URL(request.url);
					const remoteAddress =
						request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
						bunServer.requestIP(request)?.address;
					const origin = request.headers.get("origin");
					const info: OneBotReverseConnectionInfo = {
						...(origin === null ? {} : { origin }),
						...(remoteAddress === undefined ? {} : { remoteAddress }),
					};
					if (path !== undefined && url.pathname !== path) {
						return new Response("Not found", { status: 404 });
					}
					if (!isReverseAccessAllowed(request.headers, url, options.accessToken)) {
						options.onRejected?.({ ...info, reason: "unauthorized" });
						return new Response("Unauthorized", {
							headers: { "content-type": "text/plain; charset=utf-8" },
							status: 401,
						});
					}
					if (bunServer.upgrade(request, { data: { info, transport: undefined } })) {
						return undefined;
					}
					options.onRejected?.({ ...info, reason: "upgrade-failed" });
					return new Response("Upgrade required", { status: 426 });
				},
				hostname: options.host,
				port: options.port,
				websocket: {
					close(socket) {
						listeningSockets.delete(socket);
						socket.data.transport?.notifyClose();
					},
					message(socket, message) {
						socket.data.transport?.send(String(message));
					},
					open(socket) {
						const listeners: Partial<Record<keyof OneBotTransportEvents, unknown>> = {};
						const transport: ReverseTransport = {
							close: () => socket.close(),
							notifyClose: () => {
								const closeListener = listeners.close;
								if (typeof closeListener === "function") closeListener();
							},
							on: (name, listener) => {
								listeners[name] = listener;
							},
							send: (data) => {
								if (socket.readyState === 1) socket.send(data);
							},
						};
						socket.data.transport = transport;
						listeningSockets.add(socket);
						options.onConnection(transport, socket.data.info);
						const openListener = listeners.open;
						if (typeof openListener === "function") openListener();
					},
				},
			});
			return { port: server.port ?? options.port };
		},
		async stop() {
			for (const socket of listeningSockets) {
				try {
					socket.close();
				} catch {}
			}
			listeningSockets.clear();
			server?.stop(true);
			server = undefined;
		},
	};
};
