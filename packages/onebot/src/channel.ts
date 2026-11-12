import type { MessageEnvelope, MessagePart } from "@elaina/contracts";
import type { WebSocket as BunWebSocket, WebSocketOptions } from "bun";
import { normalizeOneBotEvent } from "./normalize.ts";
import type {
	OneBotChannelDiagnostics,
	OneBotConfig,
	OneBotEvent,
	OneBotTransport,
	OneBotTransportFactory,
	OneBotTransportEvents,
} from "./types.ts";

type PendingAction = {
	reject: (error: Error) => void;
	resolve: (data: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
};

type ConnectionResult = {
	reject: (error: unknown) => void;
	resolve: () => void;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;

const actionTimeoutError = (action: string): Error => new Error(`OneBot action timeout: ${action}`);

const closeError = (): Error => new Error("OneBot connection closed");

const contentType = (part: MessagePart) => {
	switch (part.type) {
		case "image":
			return { data: { file: part.sha256 }, type: "image" } as const;
		case "sticker":
			return { data: { file: part.sha256 }, type: "face" } as const;
		case "text":
			return { data: { text: part.text }, type: "text" } as const;
	}
};

const headersFor = (accessToken: string | undefined): Record<string, string> => {
	return accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` };
};

const isWebSocketUrl = (value: string): boolean =>
	value.startsWith("ws://") || value.startsWith("wss://");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toSegments = (parts: readonly MessagePart[]) => parts.map((part) => contentType(part));

export class OneBotChannel {
	private attempts = 0;
	private config: OneBotConfig;
	private connectionResult: ConnectionResult | undefined;
	private connectionState: OneBotChannelDiagnostics["state"] = "closed";
	private eventCount = 0;
	private lastErrorClass: OneBotChannelDiagnostics["lastErrorClass"];
	private messageHandler: ((envelope: MessageEnvelope) => void) | undefined;
	private nextEchoId = 0;
	private pending = new Map<string, PendingAction>();
	private reconnecting = false;
	private stopped = false;
	private transport: OneBotTransport | undefined;
	private transportFactory: OneBotTransportFactory;

	constructor(config: OneBotConfig, transportFactory?: OneBotTransportFactory) {
		this.config = config;
		this.transportFactory =
			transportFactory ??
			((url, headers) => {
				const options: WebSocketOptions = { headers };
				const socket: BunWebSocket = new WebSocket(url, options);
				const listeners: Partial<Record<keyof OneBotTransportEvents, unknown>> = {};
				socket.addEventListener("open", () => {
					const listener = listeners.open;
					if (typeof listener === "function") listener();
				});
				socket.addEventListener("message", (event) => {
					const listener = listeners.message;
					if (typeof listener === "function") listener(String(event.data));
				});
				socket.addEventListener("close", () => {
					const listener = listeners.close;
					if (typeof listener === "function") listener();
				});
				socket.addEventListener("error", (event) => {
					const listener = listeners.error;
					if (typeof listener === "function") listener(event);
				});
				return {
					close: () => socket.close(),
					on: (name, listener) => {
						listeners[name] = listener;
					},
					send: (data) => socket.send(data),
				};
			});
	}

	get diagnostics(): OneBotChannelDiagnostics {
		return {
			eventCount: this.eventCount,
			lastErrorClass: this.lastErrorClass,
			reconnectAttempts: this.attempts,
			state: this.stopped ? "closed" : this.connectionState,
		};
	}

	get inFlightActions(): number {
		return this.pending.size;
	}

	onMessage(handler: (envelope: MessageEnvelope) => void): void {
		this.messageHandler = handler;
	}

	async sendGroup(groupId: string, parts: readonly MessagePart[]): Promise<unknown> {
		return this.action("send_group_msg", { group_id: groupId, message: toSegments(parts) });
	}

	async sendPrivate(userId: string, parts: readonly MessagePart[]): Promise<unknown> {
		return this.action("send_private_msg", { message: toSegments(parts), user_id: userId });
	}

	async start(): Promise<void> {
		this.stopped = false;
		if (!isWebSocketUrl(this.config.url)) {
			throw new Error("OneBot url must use ws:// or wss://");
		}
		await this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.transport?.close();
		this.failPending(closeError());
		this.connectionState = "closed";
	}

	private action(action: string, params: Record<string, unknown>): Promise<unknown> {
		const transport = this.transport;
		if (transport === undefined || this.stopped) {
			return Promise.reject(closeError());
		}
		const echo = `echo-${this.nextEchoId++}`;
		return new Promise((resolve, reject) => {
			const timeoutMs = this.config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				this.lastErrorClass = "action-timeout";
				reject(actionTimeoutError(action));
			}, timeoutMs);
			this.pending.set(echo, { reject, resolve, timer });
			transport.send(JSON.stringify({ action, echo, params }));
		});
	}

	private async connect(): Promise<void> {
		this.connectionState = "connecting";
		const connectionResult = new Promise<void>((resolve, reject) => {
			this.connectionResult = { reject, resolve };
		});
		void connectionResult;
		const transport = this.transportFactory(this.config.url, headersFor(this.config.accessToken));
		this.transport = transport;
		transport.on("open", () => {
			this.attempts = 0;
			this.connectionState = "open";
			this.connectionResult?.resolve();
			this.connectionResult = undefined;
		});
		transport.on("message", (data) => {
			this.handleMessage(data);
		});
		transport.on("error", () => {
			this.lastErrorClass = "connect";
		});
		transport.on("close", () => {
			this.transport = undefined;
			this.failPending(closeError());
			this.connectionResult?.reject(closeError());
			this.connectionResult = undefined;
			if (!this.stopped) {
				this.connectionState = "reconnecting";
				this.lastErrorClass = "disconnect";
				void this.reconnect();
			}
		});
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private handleMessage(data: string): void {
		const parsed: unknown = JSON.parse(data);
		if (this.handleResponse(parsed)) {
			return;
		}
		const envelope = normalizeOneBotEvent(parsed as OneBotEvent, this.config);
		if (envelope === undefined) {
			return;
		}
		this.eventCount += 1;
		this.messageHandler?.(envelope);
	}

	private handleResponse(parsed: unknown): boolean {
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("echo" in parsed) ||
			!("retcode" in parsed)
		) {
			return false;
		}
		const response = parsed as { data?: unknown; echo: unknown; retcode: unknown };
		const echo = typeof response.echo === "string" ? response.echo : undefined;
		if (echo === undefined) {
			return false;
		}
		const pending = this.pending.get(echo);
		if (pending === undefined) {
			return false;
		}
		clearTimeout(pending.timer);
		this.pending.delete(echo);
		if (response.retcode === 0) {
			pending.resolve(response.data);
		} else {
			pending.reject(new Error(`OneBot action failed: ${String(response.retcode)}`));
		}
		return true;
	}

	private reconnectDelay(): number {
		const base = Math.min(
			this.config.reconnect.maxDelayMs,
			this.config.reconnect.initialDelayMs * 2 ** this.attempts,
		);
		const jitter = base * this.config.reconnect.jitterRatio;
		return base - jitter + Math.random() * jitter * 2;
	}

	private async reconnect(): Promise<void> {
		if (this.reconnecting || this.stopped) {
			return;
		}
		this.reconnecting = true;
		try {
			this.attempts += 1;
			await sleep(this.reconnectDelay());
			if (!this.stopped) {
				await this.connect();
			}
		} finally {
			this.reconnecting = false;
		}
	}
}
