import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@elaina/contracts";
import type {
	ChannelAdapter,
	ChannelCapability,
	ChannelDiagnostics,
	ChannelHistoryItem,
	ChannelHistoryOptions,
	ChannelRequestDecision,
	OutboundTarget,
	PluginLogger,
	SendOptions,
	SendResult,
} from "@elaina/sdk";
import { OneBotChannel } from "./protocol/channel.ts";
import type {
	OneBotConfig,
	OneBotReverseServerFactory,
	OneBotTransportFactory,
} from "./protocol/types.ts";
import { createSafeLogger, safeEndpoint, scopedLogger } from "./logging.ts";

export const ONEBOT_CHANNEL_KIND = "onebot-v11";

/**
 * Granular capabilities are the machine-readable contract. Legacy values stay advertised for
 * the compatibility window so existing action descriptors keep working.
 */
const CAPABILITIES: readonly ChannelCapability[] = [
	"send.text",
	"send.image",
	"send.audio",
	"send.video",
	"send.file",
	"send.forward",
	"reply.quote",
	"interact.poke",
	"interact.react",
	"interact.typing",
	"manage.group",
	"manage.friend",
	"manage.self",
	"read.history",
	"fetch.media",
	"send",
	"interact",
	"group-manage",
	"read-info",
	"read-media",
	"upload",
	"raw",
];

export interface OneBotChannelAdapterOptions {
	readonly channelId: string;
	readonly config: OneBotConfig;
	readonly logger: PluginLogger;
	readonly reverseServerFactory?: OneBotReverseServerFactory;
	readonly transportFactory?: OneBotTransportFactory;
	readonly onStateChange?: (state: "connected" | "disconnected") => void;
}

const toSendResult = (result: unknown): SendResult => {
	if (typeof result !== "object" || result === null || !("message_id" in result)) {
		return {};
	}
	const value = result.message_id;
	if (typeof value !== "string" && typeof value !== "number") {
		return {};
	}
	return { platformMessageId: String(value) };
};

/**
 * Adapts the OneBot protocol channel to the host's channel contract. It owns the
 * WebSocket lifecycle; the host owns ingestion, the request inbox, and audit.
 */
export class OneBotChannelAdapter implements ChannelAdapter {
	readonly id: string;
	readonly kind = ONEBOT_CHANNEL_KIND;
	readonly #config: OneBotConfig;
	readonly #logger: PluginLogger;
	readonly #onStateChange: ((state: "connected" | "disconnected") => void) | undefined;
	readonly #reverseServerFactory: OneBotReverseServerFactory | undefined;
	readonly #transportFactory: OneBotTransportFactory | undefined;
	#channel: OneBotChannel | undefined;
	#envelopeHandler: ((envelope: MessageEnvelope) => void) | undefined;
	#noticeHandler: ((notice: ChannelNotice) => void) | undefined;
	#requestHandler: ((request: ChannelRequest) => void) | undefined;
	#restartRequired = false;

	constructor(options: OneBotChannelAdapterOptions) {
		this.id = options.channelId;
		this.#config = options.config;
		this.#logger = createSafeLogger(options.logger);
		this.#reverseServerFactory = options.reverseServerFactory;
		this.#transportFactory = options.transportFactory;
		this.#onStateChange = options.onStateChange;
	}

	get channel(): OneBotChannel | undefined {
		return this.#channel;
	}

	get config(): OneBotConfig {
		return this.#config;
	}

	capabilities(): readonly ChannelCapability[] {
		return CAPABILITIES;
	}

	diagnostics(): ChannelDiagnostics {
		const base = this.#channel?.diagnostics;
		return {
			configured: true,
			connected: base?.connected ?? false,
			eventCount: base?.eventCount ?? 0,
			lastErrorClass: base?.lastErrorClass,
			...(base?.lastEventAtMs === undefined ? {} : { lastEventAtMs: base.lastEventAtMs }),
			mode: base?.mode ?? this.#config.mode ?? "forward",
			...(base?.origin === undefined ? {} : { origin: base.origin }),
			reconnectAttempts: base?.reconnectAttempts ?? 0,
			...(base?.remoteAddress === undefined ? {} : { remoteAddress: base.remoteAddress }),
			restartRequired: this.#restartRequired,
			state: this.#restartRequired ? "closed" : (base?.state ?? "closed"),
		};
	}

	onEnvelope(handler: (envelope: MessageEnvelope) => void): void {
		this.#envelopeHandler = handler;
	}

	onNotice(handler: (notice: ChannelNotice) => void): void {
		this.#noticeHandler = handler;
	}

	onRequest(handler: (request: ChannelRequest) => void): void {
		this.#requestHandler = handler;
	}

	/**
	 * Start the connection. Failure is recorded as `restartRequired` instead of throwing so
	 * a misconfigured channel degrades the server rather than failing startup.
	 */
	async start(): Promise<void> {
		const startedAtMs = Date.now();
		this.#logger.debug("OneBot adapter starting", {
			channelId: this.id,
			endpoint:
				this.#config.mode === "reverse"
					? `ws-reverse://${this.#config.host ?? "127.0.0.1"}:${this.#config.port ?? 3002}`
					: safeEndpoint(this.#config.url),
			mode: this.#config.mode ?? "forward",
		});
		try {
			const channel = new OneBotChannel(
				this.#config,
				this.#transportFactory,
				this.#reverseServerFactory,
				scopedLogger(this.#logger, "channel"),
			);
			channel.onMessage((envelope) => this.#envelopeHandler?.(envelope));
			channel.onNotice((notice) => this.#noticeHandler?.(notice));
			channel.onRequest((request) => this.#requestHandler?.(request));
			channel.onStateChange((state) => {
				if (state === "open") {
					this.#logger.info("OneBot adapter connected", { channelId: this.id });
					this.#onStateChange?.("connected");
				}
				if (state === "closed") {
					this.#logger.info("OneBot adapter disconnected", { channelId: this.id });
					this.#onStateChange?.("disconnected");
				}
			});
			this.#channel = channel;
			await channel.start();
			this.#restartRequired = false;
			this.#logger.debug("OneBot adapter started", {
				channelId: this.id,
				durationMs: Date.now() - startedAtMs,
				state: channel.diagnostics.state,
			});
		} catch (error) {
			this.#restartRequired = true;
			this.#logger.error("OneBot channel failed to start", {
				durationMs: Date.now() - startedAtMs,
				error: error instanceof Error ? error.message : String(error),
				mode: this.#config.mode ?? "forward",
				url: safeEndpoint(this.#config.url),
			});
		}
	}

	async stop(): Promise<void> {
		this.#logger.debug("OneBot adapter stopping", {
			channelId: this.id,
			inFlightActions: this.#channel?.inFlightActions ?? 0,
		});
		this.#channel?.stop();
		this.#channel = undefined;
	}

	async send(
		target: OutboundTarget,
		parts: readonly MessagePart[],
		options?: SendOptions,
	): Promise<SendResult> {
		const channel = this.#channel;
		if (channel === undefined || !channel.diagnostics.connected) {
			throw new Error(`Channel ${this.id} is not connected`);
		}
		const startedAtMs = Date.now();
		this.#logger.trace("OneBot adapter send started", {
			channelId: this.id,
			partCount: parts.length,
			peer: target.platformConversationId,
			targetKind: target.kind,
		});
		try {
			const result =
				target.kind === "group"
					? await channel.sendGroup(target.platformConversationId, parts, options)
					: await channel.sendPrivate(target.platformConversationId, parts, options);
			const sendResult = toSendResult(result);
			this.#logger.debug("OneBot adapter send completed", {
				durationMs: Date.now() - startedAtMs,
				partCount: parts.length,
				peer: target.platformConversationId,
				...(sendResult.platformMessageId === undefined
					? {}
					: { platformMessageId: sendResult.platformMessageId }),
				targetKind: target.kind,
			});
			return sendResult;
		} catch (error) {
			this.#logger.warn("OneBot adapter send failed", {
				durationMs: Date.now() - startedAtMs,
				error: error instanceof Error ? error.message : String(error),
				partCount: parts.length,
				peer: target.platformConversationId,
				targetKind: target.kind,
			});
			throw error;
		}
	}

	async sendTyping(target: OutboundTarget, typing: boolean): Promise<void> {
		const channel = this.#channel;
		if (channel === undefined || !channel.diagnostics.connected) return;
		if (target.kind !== "private") return;
		try {
			await channel.setTyping(target, typing);
		} catch (error) {
			this.#logger.debug("typing indicator unavailable", {
				error: error instanceof Error ? error.message : String(error),
				target: target.platformConversationId,
			});
		}
	}

	async lookupMessage(platformMessageId: string): Promise<ChannelHistoryItem | undefined> {
		const startedAtMs = Date.now();
		const item = await this.#channel?.lookupMessage(platformMessageId);
		this.#logger.debug("OneBot adapter message lookup completed", {
			durationMs: Date.now() - startedAtMs,
			found: item !== undefined,
			platformMessageId,
		});
		return item;
	}

	async readHistory(
		target: OutboundTarget,
		options?: ChannelHistoryOptions,
	): Promise<readonly ChannelHistoryItem[]> {
		const startedAtMs = Date.now();
		const items = (await this.#channel?.readHistory(target, options)) ?? [];
		this.#logger.debug("OneBot adapter history read completed", {
			durationMs: Date.now() - startedAtMs,
			items: items.length,
			limit: options?.limit,
			peer: target.platformConversationId,
			targetKind: target.kind,
		});
		return items;
	}

	async resolveRequest(request: ChannelRequest, decision: ChannelRequestDecision): Promise<void> {
		const channel = this.#channel;
		if (channel === undefined) {
			throw new Error(`Channel ${this.id} is not connected`);
		}
		const approve = decision.action === "approve";
		const startedAtMs = Date.now();
		this.#logger.debug("OneBot adapter request resolution started", {
			approve,
			channelId: this.id,
			requestKind: request.kind,
		});
		if (request.kind === "friend") {
			await channel.setFriendAddRequest(
				request.flag,
				approve,
				approve ? decision.reason : undefined,
			);
		} else {
			await channel.setGroupAddRequest(request.flag, request.subType, approve, decision.reason);
		}
		this.#logger.debug("OneBot adapter request resolution completed", {
			approve,
			durationMs: Date.now() - startedAtMs,
			requestKind: request.kind,
		});
	}
}
