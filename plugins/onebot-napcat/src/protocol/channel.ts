import {
	MESSAGE_QUOTE_EXCERPT_MAX_CHARS,
	type ChannelNotice,
	type ChannelRequest,
	type MessageEnvelope,
	type MessagePart,
	type MessageQuote,
} from "@tsukaima/contracts";
import type {
	ChannelHistoryItem,
	ChannelHistoryOptions,
	OutboundTarget,
	PluginLogger,
	SendOptions,
} from "@tsukaima/sdk";
import type { WebSocket as BunWebSocket, WebSocketOptions } from "bun";
import {
	createSafeLogger,
	safeEndpoint,
	segmentTypeCounts,
	singleLinePreview,
} from "../logging.ts";
import {
	MAX_QUOTE_LOOKUP_TIMEOUT_MS,
	normalizeOneBotEvent,
	normalizeOneBotEventAsync,
	normalizeOneBotNotice,
	normalizeOneBotRequest,
} from "./normalize.ts";
import {
	createOneBotMentionNameResolver,
	type OneBotMentionNameResolver,
} from "./mention-names.ts";
import { OneBotIntervalRateLimiter } from "./rate-limit.ts";
import { bunReverseServerFactory } from "./reverse.ts";
import type {
	OneBotChannelDiagnostics,
	OneBotConfig,
	OneBotEvent,
	OneBotReverseServer,
	OneBotReverseServerFactory,
	OneBotSegment,
	OneBotTransport,
	OneBotTransportEvents,
	OneBotTransportFactory,
} from "./types.ts";

type PendingAction = {
	action: string;
	reject: (error: Error) => void;
	resolve: (data: unknown) => void;
	startedAtMs: number;
	timer: ReturnType<typeof setTimeout>;
};

type NormalizeHookOptions = {
	readonly audioRateLimiter?: OneBotIntervalRateLimiter | undefined;
	readonly audioTranscribe?: OneBotConfig["audioTranscribe"] | undefined;
	readonly audioTranscribeMinIntervalMs?: number | undefined;
	readonly audioTranscribeTimeoutMs?: number | undefined;
	readonly extractVideoFrames?: OneBotConfig["extractVideoFrames"] | undefined;
	readonly fetchForward?: ((id: string) => Promise<unknown>) | undefined;
	readonly forwardMaxChars?: number | undefined;
	readonly forwardMaxNodes?: number | undefined;
	readonly forwardTimeoutMs?: number | undefined;
	readonly logger?: PluginLogger | undefined;
	readonly mentionNameTimeoutMs?: number | undefined;
	readonly resolveMentionName?: OneBotMentionNameResolver | undefined;
	readonly resolveQuotedMessage?:
		| ((messageId: string) => Promise<MessageQuote | undefined>)
		| undefined;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
/** Uploading sticker/media bytes can take much longer than a plain text send. */
const DEFAULT_MEDIA_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_REVERSE_HOST = "127.0.0.1";
const DEFAULT_REVERSE_PORT = 3002;
const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 40;

const actionTimeoutError = (action: string): Error => new Error(`OneBot action timeout: ${action}`);

const closeError = (): Error => new Error("OneBot connection closed");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_INBOUND_MEDIA_TIMEOUT_MS = 10_000;
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

const mediaFile = (part: MessagePart): string | undefined => {
	if (part.type === "text" || part.type === "channel-native") return undefined;
	return part.channelRef ?? part.sourceUrl ?? part.sha256 ?? part.mediaId;
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const stringOf = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/** Numeric ids are common in NapCat payloads; accept finite numbers as well as strings. */
const idStringOf = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0
		? value
		: typeof value === "number" && Number.isFinite(value)
			? String(value)
			: undefined;

const decodeBase64 = (value: string, bare: boolean): Uint8Array | undefined => {
	let text = value.trim();
	if (text.startsWith("base64://")) text = text.slice("base64://".length);
	else if (text.startsWith("data:")) {
		const separator = text.indexOf(",");
		if (separator < 0 || !text.slice(5, separator).includes(";base64")) return undefined;
		text = text.slice(separator + 1);
	} else if (!bare) {
		return undefined;
	}
	text = text.replace(/\s+/gu, "");
	if (text.length === 0) return undefined;
	const bytes = Buffer.from(text, "base64");
	return bytes.byteLength === 0 ? undefined : new Uint8Array(bytes);
};

/**
 * Decode the bytes NapCat returns for `get_image`/`get_file`. Both actions answer with media
 * metadata; only an inline `base64` (or an inline `base64://`/data URL) is usable here. A plain
 * CDN URL is deliberately ignored so the host's guarded HTTP path, not the plugin, handles it.
 */
export function inboundMediaBytes(raw: unknown): Uint8Array | undefined {
	const response = recordOf(raw);
	if (response === undefined) return undefined;
	const data = recordOf(response.data) ?? response;
	const inline = stringOf(data.base64);
	if (inline !== undefined) return decodeBase64(inline, true);
	for (const key of ["data", "file", "path"] as const) {
		const value = stringOf(data[key]);
		if (value === undefined) continue;
		const bytes = decodeBase64(value, false);
		if (bytes !== undefined) return bytes;
	}
	return undefined;
}

/** QQ renders an `image` segment as a native animated sticker when these fields are set. */
const NATIVE_STICKER_SUMMARY = "[动画表情]";

export interface OneBotSegmentOptions {
	/** Send sticker media as QQ native animated stickers instead of plain images. Default true. */
	readonly nativeSticker?: boolean | undefined;
}

const nativeStickerEnabled = (options?: OneBotSegmentOptions): boolean =>
	options?.nativeSticker !== false;

const hasRenderableMedia = (parts: readonly MessagePart[]): boolean =>
	parts.some((part) => part.type !== "text" && part.type !== "channel-native");

/**
 * Outbound sends carrying media get a longer default timeout because NapCat uploads the bytes
 * before answering. An explicit `actionTimeoutMs` always wins.
 */
export const outboundActionTimeoutMs = (
	config: OneBotConfig,
	parts: readonly MessagePart[],
): number =>
	config.actionTimeoutMs ??
	(hasRenderableMedia(parts) ? DEFAULT_MEDIA_ACTION_TIMEOUT_MS : DEFAULT_ACTION_TIMEOUT_MS);

/**
 * Serialize a core message part into OneBot v11 segments. `channel-native` parts degrade to
 * their safe summary because the remote platform cannot render an opaque local structure.
 */
export const toSegments = (
	parts: readonly MessagePart[],
	options?: OneBotSegmentOptions,
): OneBotSegment[] => {
	const segments: OneBotSegment[] = [];
	for (const part of parts) {
		switch (part.type) {
			case "text":
				segments.push({ data: { text: part.text }, type: "text" });
				break;
			case "image": {
				const file = mediaFile(part);
				if (file !== undefined) segments.push({ data: { file }, type: "image" });
				break;
			}
			case "sticker": {
				const face = /^face:(.+)$/u.exec(part.channelRef ?? "");
				if (face?.[1] !== undefined) {
					segments.push({ data: { id: face[1] }, type: "face" });
					break;
				}
				const file = mediaFile(part);
				if (file !== undefined) {
					// `sub_type: 1` is NapCat/QQ's collected animated sticker subtype; `summary`
					// keeps clients that ignore it from rendering an empty image.
					segments.push({
						data: nativeStickerEnabled(options)
							? { file, sub_type: 1, summary: NATIVE_STICKER_SUMMARY }
							: { file },
						type: "image",
					});
				}
				break;
			}
			case "audio": {
				const file = mediaFile(part);
				if (file !== undefined) {
					const data: Record<string, unknown> = { file };
					if (part.sourceUrl !== undefined) data.url = part.sourceUrl;
					if (part.durationMs !== undefined) data.duration = part.durationMs;
					segments.push({ data, type: "record" });
				}
				break;
			}
			case "video": {
				const file = mediaFile(part);
				if (file !== undefined) {
					const data: Record<string, unknown> = { file };
					if (part.sourceUrl !== undefined) data.url = part.sourceUrl;
					if (part.durationMs !== undefined) data.duration = part.durationMs;
					segments.push({ data, type: "video" });
				}
				break;
			}
			case "file": {
				const file = mediaFile(part);
				if (file !== undefined) {
					segments.push({
						data: {
							file,
							name: part.fileName,
							...(part.mimeType === undefined ? {} : { mime_type: part.mimeType }),
							...(part.sizeBytes === undefined ? {} : { size: part.sizeBytes }),
						},
						type: "file",
					});
				}
				break;
			}
			case "channel-native":
				if (part.summary !== undefined && part.summary.trim().length > 0) {
					segments.push({ data: { text: part.summary }, type: "text" });
				}
				break;
		}
	}
	return segments;
};

const headersFor = (accessToken: string | undefined): Record<string, string> => {
	return accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` };
};

const isWebSocketUrl = (value: string): boolean =>
	value.startsWith("ws://") || value.startsWith("wss://");

const defaultTransportFactory: OneBotTransportFactory = (url, headers) => {
	const options: WebSocketOptions = { headers };
	const socket: BunWebSocket = new WebSocket(url, options);
	const listeners: Partial<Record<keyof OneBotTransportEvents, unknown>> = {};
	const emit = (name: keyof OneBotTransportEvents, value?: unknown) => {
		const listener = listeners[name];
		if (typeof listener === "function") (listener as (value?: unknown) => void)(value);
	};
	socket.addEventListener("open", () => emit("open"));
	socket.addEventListener("message", (event) => emit("message", String(event.data)));
	socket.addEventListener("close", () => emit("close"));
	socket.addEventListener("error", (event) => emit("error", event));
	return {
		close: () => socket.close(),
		on: (name, listener) => {
			listeners[name] = listener;
		},
		send: (data) => socket.send(data),
	};
};

const textOfSegments = (segments: unknown): string => {
	if (!Array.isArray(segments)) return "";
	return segments
		.map((segment) => {
			if (typeof segment !== "object" || segment === null) return "";
			const record = segment as { data?: Record<string, unknown>; type?: unknown };
			if (record.type === "text" && typeof record.data?.text === "string") return record.data.text;
			if (record.type === "at" && record.data?.qq !== undefined)
				return `@${String(record.data.qq)}`;
			return typeof record.type === "string" ? `[${record.type}]` : "";
		})
		.join("")
		.trim();
};

/** Trace-scale inbound frame summary: post type, segment counts, and a bounded text preview. */
const inboundSummary = (event: OneBotEvent): Record<string, unknown> => {
	const segments = event.message ?? [];
	const textPreview = singleLinePreview(textOfSegments(segments));
	return {
		postType: event.post_type,
		...(event.message_type === undefined ? {} : { messageType: event.message_type }),
		...(event.notice_type === undefined ? {} : { noticeType: event.notice_type }),
		...(event.sub_type === undefined ? {} : { subType: event.sub_type }),
		...(event.request_type === undefined ? {} : { requestType: event.request_type }),
		...(event.message_id === undefined ? {} : { messageId: String(event.message_id) }),
		segmentCount: segments.length,
		...(segments.length === 0 ? {} : { segmentTypes: segmentTypeCounts(segments) }),
		...(textPreview === undefined ? {} : { textPreview }),
	};
};

const historyItem = (raw: unknown): ChannelHistoryItem | undefined => {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const messageId = record.message_id ?? record.messageId;
	if (typeof messageId !== "string" && typeof messageId !== "number") return undefined;
	const sender =
		typeof record.sender === "object" && record.sender !== null
			? (record.sender as Record<string, unknown>)
			: {};
	const time =
		typeof record.time === "number"
			? record.time * 1_000
			: typeof record.time === "string" && Number.isFinite(Number(record.time))
				? Number(record.time) * 1_000
				: undefined;
	const text = textOfSegments(record.message ?? record.content);
	const senderId = sender.user_id ?? record.user_id;
	return {
		platformMessageId: String(messageId),
		...(senderId === undefined ? {} : { senderId: String(senderId) }),
		...(text.length === 0 ? {} : { text }),
		...(time === undefined ? {} : { timestampMs: time }),
	};
};

const historyItems = (raw: unknown): ChannelHistoryItem[] => {
	if (typeof raw !== "object" || raw === null) return [];
	const record = raw as Record<string, unknown>;
	const messages = Array.isArray(record.messages) ? record.messages : [];
	return messages
		.map((entry) => historyItem(entry))
		.filter((entry): entry is ChannelHistoryItem => entry !== undefined);
};

/** Turn one `get_msg` response into the bounded quote the envelope contract accepts. */
const quotedMessage = (raw: unknown, botAccountId: string): MessageQuote | undefined => {
	const response = recordOf(raw);
	if (response === undefined) return undefined;
	const data = recordOf(response.data) ?? response;
	const sender = recordOf(data.sender) ?? {};
	const senderId = sender.user_id ?? data.user_id;
	const senderName =
		stringOf(sender.card)?.trim() || stringOf(sender.nickname)?.trim() || undefined;
	const excerpt = textOfSegments(data.message ?? data.content)
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, MESSAGE_QUOTE_EXCERPT_MAX_CHARS);
	const fromSelf = senderId !== undefined && String(senderId) === botAccountId;
	const quote: MessageQuote = {
		...(excerpt.length === 0 ? {} : { excerpt }),
		...(fromSelf ? { fromSelf: true } : {}),
		...(senderName === undefined || senderName.length === 0
			? {}
			: { senderDisplayName: senderName }),
		...(senderId === undefined ? {} : { senderPlatformId: String(senderId) }),
	};
	return Object.keys(quote).length === 0 ? undefined : quote;
};

export class OneBotChannel {
	private attempts = 0;
	private config: OneBotConfig;
	private connectionState: OneBotChannelDiagnostics["state"] = "closed";
	private eventCount = 0;
	private lastErrorClass: OneBotChannelDiagnostics["lastErrorClass"];
	private lastEventAtMs: number | undefined;
	private messageHandler: ((envelope: MessageEnvelope) => void) | undefined;
	private noticeHandler: ((notice: ChannelNotice) => void) | undefined;
	private requestHandler: ((request: ChannelRequest) => void) | undefined;
	private nextEchoId = 0;
	private origin: string | undefined;
	private pending = new Map<string, PendingAction>();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnecting = false;
	private remoteAddress: string | undefined;
	private reverseServer: OneBotReverseServer | undefined;
	private reverseServerFactory: OneBotReverseServerFactory;
	private stateHandler: ((state: OneBotChannelDiagnostics["state"]) => void) | undefined;
	private stopped = false;
	private transport: OneBotTransport | undefined;
	private transportFactory: OneBotTransportFactory;
	private readonly audioRateLimiter: OneBotIntervalRateLimiter | undefined;
	private readonly logger: PluginLogger;
	private readonly mentionNameResolver: OneBotMentionNameResolver | undefined;

	constructor(
		config: OneBotConfig,
		transportFactory?: OneBotTransportFactory,
		reverseServerFactory?: OneBotReverseServerFactory,
		logger?: PluginLogger,
	) {
		this.config = config;
		this.logger = createSafeLogger(logger);
		this.transportFactory = transportFactory ?? defaultTransportFactory;
		this.reverseServerFactory = reverseServerFactory ?? bunReverseServerFactory;
		this.mentionNameResolver =
			config.resolveMentionName ??
			(config.mentionNameStore === undefined
				? undefined
				: createOneBotMentionNameResolver({
						botAccountId: config.botAccountId,
						...(config.mentionNameCacheTtlMs === undefined
							? {}
							: { cacheTtlMs: config.mentionNameCacheTtlMs }),
						channelId: config.channelId,
						logger: this.logger,
						readAction: (action, params) => this.readAction(action, params),
						store: config.mentionNameStore,
					}));
		const interval =
			config.audioTranscribeMinIntervalMs ??
			(typeof config.pttToText === "object" ? config.pttToText.minIntervalMs : undefined) ??
			0;
		this.audioRateLimiter =
			config.audioTranscribe === undefined
				? undefined
				: new OneBotIntervalRateLimiter(interval, this.logger.child?.("rate-limit") ?? this.logger);
	}

	get diagnostics(): OneBotChannelDiagnostics {
		return {
			connected: this.connectionState === "open" && !this.stopped,
			eventCount: this.eventCount,
			lastErrorClass: this.lastErrorClass,
			...(this.lastEventAtMs === undefined ? {} : { lastEventAtMs: this.lastEventAtMs }),
			mode: this.mode,
			...(this.origin === undefined ? {} : { origin: this.origin }),
			reconnectAttempts: this.attempts,
			...(this.remoteAddress === undefined ? {} : { remoteAddress: this.remoteAddress }),
			state: this.stopped ? "closed" : this.connectionState,
		};
	}

	get inFlightActions(): number {
		return this.pending.size;
	}

	get mode(): "forward" | "reverse" {
		return this.config.mode ?? "forward";
	}

	onStateChange(handler: (state: OneBotChannelDiagnostics["state"]) => void): void {
		this.stateHandler = handler;
	}

	onMessage(handler: (envelope: MessageEnvelope) => void): void {
		this.messageHandler = handler;
	}

	onNotice(handler: (notice: ChannelNotice) => void): void {
		this.noticeHandler = handler;
	}

	onRequest(handler: (request: ChannelRequest) => void): void {
		this.requestHandler = handler;
	}

	async sendGroup(
		groupId: string,
		parts: readonly MessagePart[],
		options?: SendOptions,
	): Promise<unknown> {
		const segments = this.outboundSegments(parts, options);
		const resolved = segments instanceof Promise ? await segments : segments;
		this.logOutbound("send_group_msg", groupId, resolved);
		return this.action(
			"send_group_msg",
			{ group_id: groupId, message: resolved },
			outboundActionTimeoutMs(this.config, parts),
		);
	}

	async sendPrivate(
		userId: string,
		parts: readonly MessagePart[],
		options?: SendOptions,
	): Promise<unknown> {
		const segments = this.outboundSegments(parts, options);
		const resolved = segments instanceof Promise ? await segments : segments;
		this.logOutbound("send_private_msg", userId, resolved);
		return this.action(
			"send_private_msg",
			{ message: resolved, user_id: userId },
			outboundActionTimeoutMs(this.config, parts),
		);
	}

	async sendForward(target: OutboundTarget, parts: readonly MessagePart[]): Promise<unknown> {
		const node = {
			data: { content: toSegments(parts, { nativeSticker: this.config.nativeSticker }) },
			type: "node",
		};
		this.logOutbound(
			target.kind === "group" ? "send_group_forward_msg" : "send_private_forward_msg",
			target.platformConversationId,
			node.data.content,
		);
		return target.kind === "group"
			? this.action(
					"send_group_forward_msg",
					{
						group_id: target.platformConversationId,
						messages: [node],
					},
					outboundActionTimeoutMs(this.config, parts),
				)
			: this.action(
					"send_private_forward_msg",
					{
						messages: [node],
						user_id: target.platformConversationId,
					},
					outboundActionTimeoutMs(this.config, parts),
				);
	}

	async forwardMessage(target: OutboundTarget, messageIds: readonly string[]): Promise<unknown> {
		if (messageIds.length === 0) {
			throw new Error("At least one messageId is required to forward");
		}
		if (messageIds.length === 1) {
			const messageId = messageIds[0]!;
			return target.kind === "group"
				? this.action("forward_group_single_msg", {
						group_id: target.platformConversationId,
						message_id: messageId,
					})
				: this.action("forward_friend_single_msg", {
						message_id: messageId,
						user_id: target.platformConversationId,
					});
		}
		const nodes = messageIds.map((id) => ({
			data: { id },
			type: "node",
		}));
		return target.kind === "group"
			? this.action("send_group_forward_msg", {
					group_id: target.platformConversationId,
					messages: nodes,
				})
			: this.action("send_private_forward_msg", {
					messages: nodes,
					user_id: target.platformConversationId,
				});
	}

	async lookupMessage(platformMessageId: string): Promise<ChannelHistoryItem | undefined> {
		const data = await this.readAction("get_msg", { message_id: platformMessageId });
		return historyItem(data);
	}

	/**
	 * Read inbound image/sticker bytes through NapCat. The platform already has the short-lived
	 * CDN URL resolved, so this avoids a second host-side egress and works when the host's DNS
	 * points the CDN at a proxy fake-IP range.
	 */
	async fetchMedia(part: MessagePart): Promise<Uint8Array | undefined> {
		if (this.config.fetchInboundMedia !== undefined) {
			return await this.config.fetchInboundMedia(part);
		}
		const timeoutMs = this.config.fetchInboundMediaTimeoutMs ?? DEFAULT_INBOUND_MEDIA_TIMEOUT_MS;
		const maxBytes = this.config.fetchInboundMediaMaxBytes ?? DEFAULT_INBOUND_MEDIA_MAX_BYTES;
		let data: unknown;
		if (part.type === "image" || part.type === "sticker") {
			const reference = part.channelRef ?? part.sourceUrl;
			if (reference === undefined) return undefined;
			data = await this.readAction("get_image", { file: reference }, timeoutMs);
		} else if (part.type === "file" || part.type === "video") {
			const reference = part.channelRef ?? part.sourceUrl;
			if (reference === undefined) return undefined;
			data = await this.readAction(
				"get_file",
				part.channelRef === undefined ? { file: reference } : { file_id: reference },
				timeoutMs,
			);
		} else {
			return undefined;
		}
		const bytes = inboundMediaBytes(data);
		if (bytes === undefined) return undefined;
		if (bytes.byteLength > maxBytes) {
			throw new Error("Inbound media exceeds the channel media size cap");
		}
		return bytes;
	}

	/** Discover the groups NapCat already knows. Used to supplement policy-filtered targets. */
	async listGroups(): Promise<readonly { readonly groupId: string; readonly title: string }[]> {
		const data = await this.readAction("get_group_list", {});
		const record = recordOf(data);
		const raw = Array.isArray(data)
			? data
			: Array.isArray(record?.groups)
				? record.groups
				: Array.isArray(record?.data)
					? record.data
					: [];
		return raw.flatMap((entry) => {
			const item = recordOf(entry);
			const groupId = idStringOf(item?.group_id) ?? idStringOf(item?.groupId);
			if (groupId === undefined) return [];
			const title =
				stringOf(item?.group_name)?.trim() ??
				stringOf(item?.groupName)?.trim() ??
				`group:${groupId}`;
			return [{ groupId, title }];
		});
	}

	/** Discover friends known to NapCat. Used to supplement policy-filtered targets. */
	async listFriends(): Promise<readonly { readonly title: string; readonly userId: string }[]> {
		const data = await this.readAction("get_friend_list", {});
		const record = recordOf(data);
		const raw = Array.isArray(data)
			? data
			: Array.isArray(record?.friends)
				? record.friends
				: Array.isArray(record?.data)
					? record.data
					: [];
		return raw.flatMap((entry) => {
			const item = recordOf(entry);
			const userId = idStringOf(item?.user_id) ?? idStringOf(item?.userId);
			if (userId === undefined) return [];
			const title =
				stringOf(item?.remark)?.trim() ??
				stringOf(item?.nickname)?.trim() ??
				stringOf(item?.nickName)?.trim() ??
				`private:${userId}`;
			return [{ title, userId }];
		});
	}

	async readHistory(
		target: OutboundTarget,
		options: ChannelHistoryOptions = {},
	): Promise<readonly ChannelHistoryItem[]> {
		const count = Math.min(100, Math.max(1, options.limit ?? 20));
		const data =
			target.kind === "group"
				? await this.readAction("get_group_msg_history", {
						count,
						group_id: target.platformConversationId,
					})
				: await this.readAction("get_friend_msg_history", {
						count,
						user_id: target.platformConversationId,
					});
		const sinceMs = options.sinceMs;
		return historyItems(data).filter(
			(item) => sinceMs === undefined || (item.timestampMs ?? 0) >= sinceMs,
		);
	}

	async poke(target: OutboundTarget, userId: string): Promise<unknown> {
		return target.kind === "group"
			? this.action("group_poke", { group_id: target.platformConversationId, user_id: userId })
			: this.action("friend_poke", { user_id: target.platformConversationId });
	}

	async react(messageId: string, emojiId: string, set = true): Promise<unknown> {
		return this.action("set_msg_emoji_like", {
			emoji_id: emojiId,
			message_id: messageId,
			set,
		});
	}

	async setTyping(target: OutboundTarget, typing: boolean): Promise<unknown> {
		return this.action("set_input_status", {
			...(target.kind === "group"
				? { group_id: target.platformConversationId }
				: { user_id: target.platformConversationId }),
			event_type: typing ? 1 : 2,
		});
	}

	async deleteMessage(messageId: string): Promise<unknown> {
		return this.action("delete_msg", { message_id: messageId });
	}

	async markRead(messageId: string): Promise<unknown> {
		return this.action("mark_msg_as_read", { message_id: messageId });
	}

	async listGroupFiles(groupId: string): Promise<unknown> {
		return this.readAction("get_group_root_files", { group_id: groupId });
	}

	async fetchGroupFile(groupId: string, fileId: string, busid?: number): Promise<unknown> {
		return this.readAction("get_group_file_url", {
			busid: busid ?? 0,
			file_id: fileId,
			group_id: groupId,
		});
	}

	async uploadGroupFile(
		groupId: string,
		file: string,
		name: string,
		folder?: string,
	): Promise<unknown> {
		return this.action("upload_group_file", {
			file,
			group_id: groupId,
			name,
			...(folder === undefined ? {} : { folder }),
		});
	}

	async deleteGroupFile(groupId: string, fileId: string, busid?: number): Promise<unknown> {
		return this.action("delete_group_file", {
			busid: busid ?? 0,
			file_id: fileId,
			group_id: groupId,
		});
	}

	async groupBan(groupId: string, userId: string, durationSeconds: number): Promise<unknown> {
		return this.action("set_group_ban", {
			duration: durationSeconds,
			group_id: groupId,
			user_id: userId,
		});
	}

	async groupWholeBan(groupId: string, enable: boolean): Promise<unknown> {
		return this.action("set_group_whole_ban", { enable, group_id: groupId });
	}

	async groupKick(groupId: string, userId: string, rejectAddRequest = false): Promise<unknown> {
		return this.action("set_group_kick", {
			group_id: groupId,
			reject_add_request: rejectAddRequest,
			user_id: userId,
		});
	}

	async groupSetAdmin(groupId: string, userId: string, enable: boolean): Promise<unknown> {
		return this.action("set_group_admin", { enable, group_id: groupId, user_id: userId });
	}

	async groupSetCard(groupId: string, userId: string, card: string): Promise<unknown> {
		return this.action("set_group_card", { card, group_id: groupId, user_id: userId });
	}

	async groupSetName(groupId: string, groupName: string): Promise<unknown> {
		return this.action("set_group_name", { group_id: groupId, group_name: groupName });
	}

	async groupLeave(groupId: string, dismiss = false): Promise<unknown> {
		return this.action("set_group_leave", { group_id: groupId, is_dismiss: dismiss });
	}

	async groupSetSpecialTitle(groupId: string, userId: string, title: string): Promise<unknown> {
		return this.action("set_group_special_title", {
			group_id: groupId,
			special_title: title,
			user_id: userId,
		});
	}

	async setAvatar(file: string): Promise<unknown> {
		return this.action("set_qq_avatar", { file });
	}

	async setProfile(profile: Record<string, unknown>): Promise<unknown> {
		return this.action("set_qq_profile", profile);
	}

	async setLongnick(longnick: string): Promise<unknown> {
		return this.action("set_self_longnick", { longNick: longnick });
	}

	async setOnlineStatus(
		status: number,
		extStatus?: number,
		batteryStatus?: number,
	): Promise<unknown> {
		return this.action("set_online_status", {
			...(batteryStatus === undefined ? {} : { battery_status: batteryStatus }),
			...(extStatus === undefined ? {} : { ext_status: extStatus }),
			status,
		});
	}

	async rawAction(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return this.action(action, params);
	}

	async setFriendAddRequest(flag: string, approve: boolean, remark?: string): Promise<unknown> {
		return this.action("set_friend_add_request", {
			approve,
			flag,
			...(remark === undefined ? {} : { remark }),
		});
	}

	async setGroupAddRequest(
		flag: string,
		subType: string | undefined,
		approve: boolean,
		reason?: string,
	): Promise<unknown> {
		return this.action("set_group_add_request", {
			approve,
			flag,
			...(reason === undefined ? {} : { reason }),
			...(subType === undefined ? {} : { sub_type: subType }),
		});
	}

	async start(): Promise<void> {
		this.stopped = false;
		this.logger.debug("OneBot channel starting", {
			endpoint: this.endpointForLog(),
			mode: this.mode,
		});
		if (this.mode === "reverse") {
			await this.startReverse();
			return;
		}
		if (this.config.url === undefined || !isWebSocketUrl(this.config.url)) {
			throw new Error("OneBot url must use ws:// or wss://");
		}
		await this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.logger.debug("OneBot channel stopping", {
			inFlightActions: this.pending.size,
			mode: this.mode,
		});
		this.transport?.close();
		this.transport = undefined;
		void this.reverseServer?.stop();
		this.reverseServer = undefined;
		this.failPending(closeError());
		this.transition("closed");
	}

	private endpointForLog(): string | undefined {
		return this.mode === "reverse"
			? `ws-reverse://${this.config.host ?? DEFAULT_REVERSE_HOST}:${this.config.port ?? DEFAULT_REVERSE_PORT}`
			: safeEndpoint(this.config.url);
	}

	/**
	 * Outbound wire summary. Only segment types/counts and a bounded text preview are logged,
	 * never media references or headers that could carry credentials.
	 */
	private logOutbound(action: string, target: string, segments: readonly OneBotSegment[]): void {
		this.logger.trace("OneBot outbound message", {
			action,
			segmentCount: segments.length,
			segmentTypes: segmentTypeCounts(segments),
			target,
			textPreview: singleLinePreview(textOfSegments(segments)),
		});
	}

	private outboundSegments(
		parts: readonly MessagePart[],
		options?: SendOptions,
	): OneBotSegment[] | Promise<OneBotSegment[]> {
		const withReply = (segments: OneBotSegment[]): OneBotSegment[] =>
			options?.replyToPlatformMessageId === undefined
				? segments
				: [{ data: { id: options.replyToPlatformMessageId }, type: "reply" }, ...segments];
		const needsResolution =
			this.config.resolveMedia !== undefined &&
			parts.some(
				(part) =>
					part.type !== "text" &&
					part.type !== "channel-native" &&
					part.channelRef === undefined &&
					part.sourceUrl === undefined,
			);
		const segmentOptions: OneBotSegmentOptions = { nativeSticker: this.config.nativeSticker };
		if (!needsResolution) return withReply(toSegments(parts, segmentOptions));
		return Promise.all(parts.map((part) => this.resolveOutboundPart(part))).then((resolved) =>
			withReply(toSegments(resolved, segmentOptions)),
		);
	}

	/**
	 * Prefer an attached platform reference, then ask the host media bridge for content-
	 * addressed bytes. A local media part that cannot be resolved degrades to safe text; its
	 * id or hash is never sent to NapCat as if it were a file path.
	 */
	private async resolveOutboundPart(part: MessagePart): Promise<MessagePart> {
		if (part.type === "text" || part.type === "channel-native") return part;
		if (part.channelRef !== undefined || part.sourceUrl !== undefined) return part;
		if (this.config.resolveMedia !== undefined) {
			try {
				const file = await this.config.resolveMedia(part);
				if (file !== undefined && file.length > 0) {
					this.logger.trace("OneBot outbound media resolved", {
						partType: part.type,
						resolved: true,
					});
					return { ...part, channelRef: file };
				}
				this.logger.debug("OneBot outbound media unresolved", { partType: part.type });
			} catch (error) {
				this.logger.warn("OneBot outbound media resolution failed", {
					error: error instanceof Error ? error.message : String(error),
					partType: part.type,
				});
				// Fall through to the safe text downgrade below.
			}
		}
		const label = part.type === "sticker" ? "sticker" : part.type;
		this.logger.debug("OneBot outbound part downgraded", { partType: part.type });
		return { text: `[${label} unavailable]`, type: "text" };
	}

	private async startReverse(): Promise<void> {
		const host = this.config.host ?? DEFAULT_REVERSE_HOST;
		const port = this.config.port ?? DEFAULT_REVERSE_PORT;
		const reverseLogger = this.logger.child?.("reverse") ?? this.logger;
		const server = this.reverseServerFactory({
			...(this.config.accessToken === undefined ? {} : { accessToken: this.config.accessToken }),
			host,
			logger: reverseLogger,
			onConnection: (transport, info) => {
				this.origin = info.origin;
				this.remoteAddress = info.remoteAddress;
				this.attachTransport(transport, true);
			},
			onRejected: (info) => {
				this.lastErrorClass = "connect";
				this.lastEventAtMs = Date.now();
				this.origin = info.origin;
				this.remoteAddress = info.remoteAddress;
				// `info.reason` is a fixed enum; the presented token is never part of it.
				this.logger.warn("OneBot reverse connection rejected", {
					...(info.origin === undefined ? {} : { origin: info.origin }),
					...(info.remoteAddress === undefined ? {} : { remoteAddress: info.remoteAddress }),
					reason: info.reason,
				});
			},
			...(this.config.path === undefined ? {} : { path: this.config.path }),
			port,
		});
		this.reverseServer = server;
		this.transition("connecting");
		const started = await server.start();
		if (this.config.port !== started.port) {
			this.config = { ...this.config, port: started.port };
		}
		this.logger.debug("OneBot reverse channel listening", { host, port: started.port });
	}

	private attachTransport(transport: OneBotTransport, fromReverse: boolean): void {
		this.transport = transport;
		transport.on("open", () => {
			this.attempts = 0;
			this.transition("open");
			this.logger.info("OneBot WebSocket connected", {
				endpoint: this.endpointForLog(),
				mode: this.mode,
				...(this.origin === undefined ? {} : { origin: this.origin }),
				...(this.remoteAddress === undefined ? {} : { remoteAddress: this.remoteAddress }),
			});
		});
		transport.on("message", (data) => {
			this.handleMessage(data);
		});
		transport.on("error", () => {
			this.lastErrorClass = "connect";
			this.logger.warn("OneBot WebSocket error", { mode: this.mode });
		});
		transport.on("close", () => {
			if (this.transport === transport) this.transport = undefined;
			this.origin = undefined;
			this.remoteAddress = undefined;
			const failedActions = this.pending.size;
			this.failPending(closeError());
			this.logger.info("OneBot WebSocket disconnected", {
				failedActions,
				mode: this.mode,
				reason: fromReverse ? "reverse-client-closed" : "transport-closed",
				stopped: this.stopped,
			});
			if (this.stopped) return;
			if (fromReverse) {
				this.lastErrorClass = "disconnect";
				this.transition("connecting");
			} else {
				this.transition("reconnecting");
				this.lastErrorClass = "disconnect";
				void this.reconnect();
			}
		});
	}

	private async connect(): Promise<void> {
		this.transition("connecting");
		const transport = this.transportFactory(
			this.config.url ?? "",
			headersFor(this.config.accessToken),
		);
		this.attachTransport(transport, false);
	}

	private transition(state: OneBotChannelDiagnostics["state"]): void {
		if (this.connectionState === state) return;
		this.connectionState = state;
		this.stateHandler?.(state);
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private handleMessage(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.lastErrorClass = "unknown";
			this.logger.warn("OneBot malformed frame ignored", {
				bytes: typeof data === "string" ? data.length : 0,
				reason: "unparseable-json",
			});
			return;
		}
		if (this.handleResponse(parsed)) {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			this.logger.warn("OneBot malformed frame ignored", {
				bytes: typeof data === "string" ? data.length : 0,
				reason: "non-object-json",
			});
			return;
		}
		const event = parsed as OneBotEvent;
		this.logger.trace("OneBot inbound frame", inboundSummary(event));
		if (event.post_type === "notice") {
			const notice = normalizeOneBotNotice(event, this.config, this.logger);
			if (notice !== undefined) {
				this.eventCount += 1;
				this.lastEventAtMs = notice.occurredAtMs;
				this.noticeHandler?.(notice);
			}
			return;
		}
		if (event.post_type === "request") {
			const request = normalizeOneBotRequest(event, this.config, this.logger);
			if (request !== undefined) {
				this.eventCount += 1;
				this.lastEventAtMs = request.receivedAtMs;
				this.requestHandler?.(request);
			}
			return;
		}
		const segments = event.message ?? [];
		const needsMentionNameResolution =
			this.mentionNameResolver !== undefined &&
			segments.some((segment) => {
				if (segment.type !== "at") return false;
				const name = segment.data?.name;
				return typeof name !== "string" || name.trim().length === 0;
			});
		const wantsAsync =
			needsMentionNameResolution ||
			segments.some((segment) => segment.type === "reply") ||
			segments.some(
				(segment) =>
					segment.type === "forward" ||
					((segment.type === "record" || segment.type === "audio") &&
						this.config.audioTranscribe !== undefined) ||
					(segment.type === "video" && this.config.extractVideoFrames !== undefined),
			) ||
			segments.some((segment) => segment.type === "forward" && this.config.forwardExpand !== false);
		if (wantsAsync) {
			this.logger.trace("OneBot inbound event needs async enrichment", {
				segmentTypes: segmentTypeCounts(segments),
			});
			void this.handleMessageAsync(event);
			return;
		}
		const envelope = normalizeOneBotEvent(event, this.config, this.logger);
		if (envelope === undefined) return;
		this.eventCount += 1;
		this.lastEventAtMs = envelope.source.timestampMs;
		this.messageHandler?.(envelope);
	}

	private async handleMessageAsync(event: OneBotEvent): Promise<void> {
		try {
			const envelope = await normalizeOneBotEventAsync(event, this.config, this.normalizeHooks());
			if (envelope === undefined) return;
			this.eventCount += 1;
			this.lastEventAtMs = envelope.source.timestampMs;
			this.messageHandler?.(envelope);
		} catch (error) {
			this.lastErrorClass = "unknown";
			this.logger.warn("OneBot async normalization failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private normalizeHooks(): NormalizeHookOptions {
		const forward =
			typeof this.config.forwardExpand === "object" ? this.config.forwardExpand : undefined;
		const ptt = typeof this.config.pttToText === "object" ? this.config.pttToText : undefined;
		return {
			...(this.audioRateLimiter === undefined ? {} : { audioRateLimiter: this.audioRateLimiter }),
			...(this.config.audioTranscribe === undefined
				? {}
				: { audioTranscribe: this.config.audioTranscribe }),
			audioTranscribeMinIntervalMs: this.config.audioTranscribeMinIntervalMs ?? ptt?.minIntervalMs,
			audioTranscribeTimeoutMs: this.config.audioTranscribeTimeoutMs ?? ptt?.timeoutMs,
			...(this.config.extractVideoFrames === undefined
				? {}
				: { extractVideoFrames: this.config.extractVideoFrames }),
			...(this.config.forwardExpand === false
				? {}
				: { fetchForward: async (id: string) => this.action("get_forward_msg", { id }) }),
			forwardMaxChars: forward?.maxChars,
			forwardMaxNodes: forward?.maxNodes,
			forwardTimeoutMs: forward?.timeoutMs,
			logger: this.logger,
			...(this.mentionNameResolver === undefined
				? {}
				: { resolveMentionName: this.mentionNameResolver }),
			...(this.config.mentionNameTimeoutMs === undefined
				? {}
				: { mentionNameTimeoutMs: this.config.mentionNameTimeoutMs }),
			resolveQuotedMessage: (messageId) => this.resolveQuotedMessage(messageId),
		};
	}

	/** Best-effort `get_msg` lookup; normalization bounds and degrades it on failure. */
	private async resolveQuotedMessage(messageId: string): Promise<MessageQuote | undefined> {
		const data = await this.readAction(
			"get_msg",
			{ message_id: messageId },
			MAX_QUOTE_LOOKUP_TIMEOUT_MS,
		);
		return quotedMessage(data, this.config.botAccountId);
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
		if (echo === undefined) return false;
		const pending = this.pending.get(echo);
		if (pending === undefined) {
			this.logger.trace("OneBot echo correlation missed", { echo });
			return false;
		}
		clearTimeout(pending.timer);
		this.pending.delete(echo);
		this.logger.trace("OneBot echo correlated", { action: pending.action, echo });
		const ok = response.retcode === 0;
		this.logger.debug("OneBot action completed", {
			action: pending.action,
			durationMs: Date.now() - pending.startedAtMs,
			echo,
			ok,
			retcode: response.retcode,
		});
		if (ok) {
			pending.resolve(response.data);
		} else {
			pending.reject(new Error(`OneBot action failed: ${String(response.retcode)}`));
		}
		return true;
	}

	private action(
		action: string,
		params: Record<string, unknown>,
		timeoutOverrideMs?: number,
	): Promise<unknown> {
		const transport = this.transport;
		if (transport === undefined || this.stopped) {
			this.logger.debug("OneBot action rejected", {
				action,
				reason: this.stopped ? "stopped" : "not-connected",
			});
			return Promise.reject(closeError());
		}
		const echo = `echo-${this.nextEchoId++}`;
		return new Promise((resolve, reject) => {
			const timeoutMs =
				timeoutOverrideMs ?? this.config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				this.lastErrorClass = "action-timeout";
				this.logger.warn("OneBot action timed out", { action, echo, timeoutMs });
				reject(actionTimeoutError(action));
			}, timeoutMs);
			this.pending.set(echo, { action, reject, resolve, startedAtMs: Date.now(), timer });
			this.logger.debug("OneBot action sent", {
				action,
				echo,
				inFlightActions: this.pending.size,
				timeoutMs,
			});
			transport.send(JSON.stringify({ action, echo, params }));
		});
	}

	/** Retries only idempotent read actions; sends and destructive actions are at-most-once. */
	private async readAction(
		action: string,
		params: Record<string, unknown>,
		timeoutOverrideMs?: number,
	): Promise<unknown> {
		let lastError: unknown;
		for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
			try {
				return await this.action(action, params, timeoutOverrideMs);
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				if (/timeout|closed/iu.test(message) === false) throw error;
				if (attempt < READ_RETRY_ATTEMPTS - 1) {
					this.logger.debug("OneBot read action retry", {
						action,
						attempt: attempt + 1,
						delayMs: READ_RETRY_DELAY_MS,
						error: message,
					});
					await sleep(READ_RETRY_DELAY_MS);
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
		if (this.reconnecting || this.stopped) return;
		this.reconnecting = true;
		let failed = false;
		try {
			this.attempts += 1;
			const delayMs = Math.round(this.reconnectDelay());
			this.logger.debug("OneBot reconnect scheduled", { attempt: this.attempts, delayMs });
			await new Promise<void>((resolve) => {
				this.reconnectTimer = setTimeout(resolve, delayMs);
				this.reconnectTimer.unref?.();
			});
			this.reconnectTimer = undefined;
			if (!this.stopped) {
				try {
					await this.connect();
				} catch (error) {
					failed = true;
					this.lastErrorClass = "connect";
					this.logger.warn("OneBot reconnect attempt failed", {
						attempt: this.attempts,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} finally {
			this.reconnecting = false;
		}
		if (failed && !this.stopped) void this.reconnect();
	}
}
