import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@tsukaima/contracts";
import type {
	ChannelHistoryItem,
	ChannelHistoryOptions,
	OutboundTarget,
	SendOptions,
} from "@tsukaima/sdk";
import type { WebSocket as BunWebSocket, WebSocketOptions } from "bun";
import {
	normalizeOneBotEvent,
	normalizeOneBotEventAsync,
	normalizeOneBotNotice,
	normalizeOneBotRequest,
} from "./normalize.ts";
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
	reject: (error: Error) => void;
	resolve: (data: unknown) => void;
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
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_REVERSE_HOST = "127.0.0.1";
const DEFAULT_REVERSE_PORT = 3002;
const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 40;

const actionTimeoutError = (action: string): Error => new Error(`OneBot action timeout: ${action}`);

const closeError = (): Error => new Error("OneBot connection closed");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const mediaFile = (part: MessagePart): string | undefined => {
	if (part.type === "text" || part.type === "channel-native") return undefined;
	return part.channelRef ?? part.sourceUrl ?? part.sha256 ?? part.mediaId;
};

/**
 * Serialize a core message part into OneBot v11 segments. `channel-native` parts degrade to
 * their safe summary because the remote platform cannot render an opaque local structure.
 */
export const toSegments = (parts: readonly MessagePart[]): OneBotSegment[] => {
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
				if (file !== undefined) segments.push({ data: { file }, type: "image" });
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

	constructor(
		config: OneBotConfig,
		transportFactory?: OneBotTransportFactory,
		reverseServerFactory?: OneBotReverseServerFactory,
	) {
		this.config = config;
		this.transportFactory = transportFactory ?? defaultTransportFactory;
		this.reverseServerFactory = reverseServerFactory ?? bunReverseServerFactory;
		const interval =
			config.audioTranscribeMinIntervalMs ??
			(typeof config.pttToText === "object" ? config.pttToText.minIntervalMs : undefined) ??
			0;
		this.audioRateLimiter =
			config.audioTranscribe === undefined ? undefined : new OneBotIntervalRateLimiter(interval);
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
		return this.action("send_group_msg", {
			group_id: groupId,
			message: segments instanceof Promise ? await segments : segments,
		});
	}

	async sendPrivate(
		userId: string,
		parts: readonly MessagePart[],
		options?: SendOptions,
	): Promise<unknown> {
		const segments = this.outboundSegments(parts, options);
		return this.action("send_private_msg", {
			message: segments instanceof Promise ? await segments : segments,
			user_id: userId,
		});
	}

	async sendForward(target: OutboundTarget, parts: readonly MessagePart[]): Promise<unknown> {
		const node = { data: { content: toSegments(parts) }, type: "node" };
		return target.kind === "group"
			? this.action("send_group_forward_msg", {
					group_id: target.platformConversationId,
					messages: [node],
				})
			: this.action("send_private_forward_msg", {
					messages: [node],
					user_id: target.platformConversationId,
				});
	}

	async lookupMessage(platformMessageId: string): Promise<ChannelHistoryItem | undefined> {
		const data = await this.readAction("get_msg", { message_id: platformMessageId });
		return historyItem(data);
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
		this.transport?.close();
		this.transport = undefined;
		void this.reverseServer?.stop();
		this.reverseServer = undefined;
		this.failPending(closeError());
		this.transition("closed");
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
		if (!needsResolution) return withReply(toSegments(parts));
		return Promise.all(parts.map((part) => this.resolveOutboundPart(part))).then((resolved) =>
			withReply(toSegments(resolved)),
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
				if (file !== undefined && file.length > 0) return { ...part, channelRef: file };
			} catch {
				// Fall through to the safe text downgrade below.
			}
		}
		const label = part.type === "sticker" ? "sticker" : part.type;
		return { text: `[${label} unavailable]`, type: "text" };
	}

	private async startReverse(): Promise<void> {
		const host = this.config.host ?? DEFAULT_REVERSE_HOST;
		const port = this.config.port ?? DEFAULT_REVERSE_PORT;
		const server = this.reverseServerFactory({
			...(this.config.accessToken === undefined ? {} : { accessToken: this.config.accessToken }),
			host,
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
	}

	private attachTransport(transport: OneBotTransport, fromReverse: boolean): void {
		this.transport = transport;
		transport.on("open", () => {
			this.attempts = 0;
			this.transition("open");
		});
		transport.on("message", (data) => {
			this.handleMessage(data);
		});
		transport.on("error", () => {
			this.lastErrorClass = "connect";
		});
		transport.on("close", () => {
			if (this.transport === transport) this.transport = undefined;
			this.origin = undefined;
			this.remoteAddress = undefined;
			this.failPending(closeError());
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
			return;
		}
		if (this.handleResponse(parsed)) {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const event = parsed as OneBotEvent;
		if (event.post_type === "notice") {
			const notice = normalizeOneBotNotice(event, this.config);
			if (notice !== undefined) {
				this.eventCount += 1;
				this.lastEventAtMs = notice.occurredAtMs;
				this.noticeHandler?.(notice);
			}
			return;
		}
		if (event.post_type === "request") {
			const request = normalizeOneBotRequest(event, this.config);
			if (request !== undefined) {
				this.eventCount += 1;
				this.lastEventAtMs = request.receivedAtMs;
				this.requestHandler?.(request);
			}
			return;
		}
		const segments = event.message ?? [];
		const wantsAsync =
			segments.some(
				(segment) =>
					segment.type === "forward" ||
					((segment.type === "record" || segment.type === "audio") &&
						this.config.audioTranscribe !== undefined) ||
					(segment.type === "video" && this.config.extractVideoFrames !== undefined),
			) ||
			segments.some((segment) => segment.type === "forward" && this.config.forwardExpand !== false);
		if (wantsAsync) {
			void this.handleMessageAsync(event);
			return;
		}
		const envelope = normalizeOneBotEvent(event, this.config);
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
		} catch {
			this.lastErrorClass = "unknown";
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
		};
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
		if (pending === undefined) return false;
		clearTimeout(pending.timer);
		this.pending.delete(echo);
		if (response.retcode === 0) {
			pending.resolve(response.data);
		} else {
			pending.reject(new Error(`OneBot action failed: ${String(response.retcode)}`));
		}
		return true;
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

	/** Retries only idempotent read actions; sends and destructive actions are at-most-once. */
	private async readAction(action: string, params: Record<string, unknown>): Promise<unknown> {
		let lastError: unknown;
		for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
			try {
				return await this.action(action, params);
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				if (/timeout|closed/iu.test(message) === false) throw error;
				if (attempt < READ_RETRY_ATTEMPTS - 1) await sleep(READ_RETRY_DELAY_MS);
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
			await new Promise<void>((resolve) => {
				this.reconnectTimer = setTimeout(resolve, this.reconnectDelay());
				this.reconnectTimer.unref?.();
			});
			this.reconnectTimer = undefined;
			if (!this.stopped) {
				try {
					await this.connect();
				} catch {
					failed = true;
					this.lastErrorClass = "connect";
				}
			}
		} finally {
			this.reconnecting = false;
		}
		if (failed && !this.stopped) void this.reconnect();
	}
}
