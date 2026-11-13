import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@tsukaima/contracts";
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
} from "@tsukaima/sdk";
import { OneBotChannel } from "./protocol/channel.ts";
import type {
	OneBotConfig,
	OneBotReverseServerFactory,
	OneBotTransportFactory,
} from "./protocol/types.ts";

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
		this.#logger = options.logger;
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
		try {
			const channel = new OneBotChannel(
				this.#config,
				this.#transportFactory,
				this.#reverseServerFactory,
			);
			channel.onMessage((envelope) => this.#envelopeHandler?.(envelope));
			channel.onNotice((notice) => this.#noticeHandler?.(notice));
			channel.onRequest((request) => this.#requestHandler?.(request));
			channel.onStateChange((state) => {
				if (state === "open") this.#onStateChange?.("connected");
				if (state === "closed") this.#onStateChange?.("disconnected");
			});
			this.#channel = channel;
			await channel.start();
			this.#restartRequired = false;
		} catch (error) {
			this.#restartRequired = true;
			this.#logger.error("OneBot channel failed to start", {
				error: error instanceof Error ? error.message : String(error),
				mode: this.#config.mode ?? "forward",
				url: this.#config.url,
			});
		}
	}

	async stop(): Promise<void> {
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
		const result =
			target.kind === "group"
				? await channel.sendGroup(target.platformConversationId, parts, options)
				: await channel.sendPrivate(target.platformConversationId, parts, options);
		return toSendResult(result);
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
		return this.#channel?.lookupMessage(platformMessageId);
	}

	async readHistory(
		target: OutboundTarget,
		options?: ChannelHistoryOptions,
	): Promise<readonly ChannelHistoryItem[]> {
		return (await this.#channel?.readHistory(target, options)) ?? [];
	}

	async resolveRequest(request: ChannelRequest, decision: ChannelRequestDecision): Promise<void> {
		const channel = this.#channel;
		if (channel === undefined) {
			throw new Error(`Channel ${this.id} is not connected`);
		}
		const approve = decision.action === "approve";
		if (request.kind === "friend") {
			await channel.setFriendAddRequest(
				request.flag,
				approve,
				approve ? decision.reason : undefined,
			);
			return;
		}
		await channel.setGroupAddRequest(request.flag, request.subType, approve, decision.reason);
	}
}
