import type { ChannelNotice, MessageEnvelope, MessagePart } from "@elaina/contracts";

export type OneBotEvent = {
	time: number;
	self_id: number | string;
	post_type: "message" | "notice" | "request" | "meta_event";
	message_type?: "private" | "group";
	request_type?: "friend" | "group";
	notice_type?: string;
	sub_type?: string;
	flag?: string;
	comment?: string;
	user_id?: number | string;
	operator_id?: number | string;
	target_id?: number | string;
	group_id?: number | string;
	message_id?: number | string;
	duration?: number | string;
	file?: {
		id?: string;
		name?: string;
		size?: number | string;
		busid?: number | string;
		url?: string;
	};
	likes?: Array<{ emoji_id?: string; count?: number | string }>;
	sender?: {
		user_id?: number | string;
		nickname?: string;
		card?: string;
		role?: "owner" | "admin" | "member";
	};
	message?: readonly OneBotSegment[];
};

export type OneBotRequestEvent = OneBotEvent & {
	post_type: "request";
	flag: string;
	request_type: "friend" | "group";
	user_id: number | string;
};

export type OneBotSegment = {
	type: string;
	data?: Record<string, unknown>;
};

export type OneBotForwardNode = {
	readonly segments?: readonly OneBotSegment[];
	readonly senderId?: string;
	readonly senderName?: string;
	readonly text?: string;
	readonly timestampMs?: number;
};

export type OneBotAudioTranscribeInput = {
	readonly channelRef?: string;
	readonly chatKey?: string;
	readonly durationMs?: number;
	readonly fileName?: string;
	readonly mimeType?: string;
	readonly sourceUrl?: string;
};

export type OneBotAudioTranscribeResult =
	| string
	| {
			readonly status?: "ok" | "fallback" | "skipped" | "failed";
			readonly text?: string;
			readonly transcript?: string;
	  };

export type OneBotAudioTranscribe = (
	input: OneBotAudioTranscribeInput,
) => OneBotAudioTranscribeResult | Promise<OneBotAudioTranscribeResult>;

export type OneBotVideoFrameInput = {
	readonly channelRef?: string;
	readonly durationMs?: number;
	readonly messageId?: string;
	readonly mimeType?: string;
	readonly sourceUrl?: string;
};

export type OneBotVideoFrame = {
	readonly mediaId?: string;
	readonly offsetMs?: number;
	readonly sha256?: string;
};

export type OneBotVideoFrameExtractor = (
	input: OneBotVideoFrameInput,
) => readonly OneBotVideoFrame[] | Promise<readonly OneBotVideoFrame[]>;

export type OneBotReconnectConfig = {
	initialDelayMs: number;
	maxDelayMs: number;
	jitterRatio: number;
};

export type OneBotConfig = {
	channelId: string;
	botAccountId: string;
	/** Forward WebSocket is the default and keeps existing deployments unchanged. */
	mode?: "forward" | "reverse";
	url?: string;
	host?: string;
	port?: number;
	path?: string;
	accessToken?: string;
	actionTimeoutMs?: number;
	reconnect: OneBotReconnectConfig;
	forwardExpand?:
		| boolean
		| {
				maxChars?: number | undefined;
				maxNodes?: number | undefined;
				timeoutMs?: number | undefined;
		  };
	pttToText?: boolean | { minIntervalMs?: number | undefined; timeoutMs?: number | undefined };
	splitMaxChars?: number;
	sendIntervalMs?: number;
	replyAsQuote?: boolean;
	pendingGraceMs?: number;
	audioTranscribe?: OneBotAudioTranscribe;
	audioTranscribeTimeoutMs?: number;
	audioTranscribeMinIntervalMs?: number;
	extractVideoFrames?: OneBotVideoFrameExtractor;
	/** Resolve canonical media bytes into a NapCat-consumable file reference. */
	resolveMedia?: (part: MessagePart) => Promise<string | undefined>;
};

export type OneBotTransportEvents = {
	message: (data: string) => void;
	open: () => void;
	close: () => void;
	error: (error: unknown) => void;
};

export type OneBotTransport = {
	close(): void;
	on<Name extends keyof OneBotTransportEvents>(
		name: Name,
		listener: OneBotTransportEvents[Name],
	): void;
	send(data: string): void;
};

export type OneBotTransportFactory = (
	url: string,
	headers: Record<string, string>,
) => OneBotTransport;

export type OneBotReverseConnectionInfo = {
	readonly origin?: string;
	readonly remoteAddress?: string;
};

export type OneBotReverseServerOptions = {
	readonly host: string;
	readonly path?: string;
	readonly port: number;
	readonly accessToken?: string;
	readonly onConnection: (transport: OneBotTransport, info: OneBotReverseConnectionInfo) => void;
	readonly onRejected?: (info: OneBotReverseConnectionInfo & { reason: string }) => void;
};

export type OneBotReverseServer = {
	readonly port: number;
	start(): Promise<{ port: number }>;
	stop(): Promise<void>;
};

export type OneBotReverseServerFactory = (
	options: OneBotReverseServerOptions,
) => OneBotReverseServer;

export type OneBotChannelDiagnostics = {
	connected: boolean;
	eventCount: number;
	lastErrorClass: "connect" | "disconnect" | "action-timeout" | "unknown" | undefined;
	lastEventAtMs?: number;
	mode: "forward" | "reverse";
	origin?: string;
	reconnectAttempts: number;
	remoteAddress?: string;
	state: "connecting" | "open" | "closed" | "reconnecting";
};

export type OneBotNotice = ChannelNotice;
export type { MessageEnvelope };
