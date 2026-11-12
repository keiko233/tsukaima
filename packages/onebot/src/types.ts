import type { MessageEnvelope } from "@tsukaima/contracts";

export type OneBotEvent = {
	time: number;
	self_id: number | string;
	post_type: "message" | "notice" | "request" | "meta_event";
	message_type?: "private" | "group";
	user_id?: number | string;
	group_id?: number | string;
	message_id?: number | string;
	sender?: {
		user_id?: number | string;
		nickname?: string;
		card?: string;
		role?: "owner" | "admin" | "member";
	};
	message?: readonly OneBotSegment[];
};

export type OneBotSegment = {
	type: string;
	data?: Record<string, unknown>;
};

export type OneBotConfig = {
	channelId: string;
	botAccountId: string;
	url: string;
	accessToken?: string;
	actionTimeoutMs?: number;
	reconnect: {
		initialDelayMs: number;
		maxDelayMs: number;
		jitterRatio: number;
	};
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

export type OneBotTransportFactory = (url: string, headers: Record<string, string>) => OneBotTransport;

export type OneBotChannelDiagnostics = {
	eventCount: number;
	lastErrorClass: "connect" | "disconnect" | "action-timeout" | "unknown" | undefined;
	reconnectAttempts: number;
	state: "connecting" | "open" | "closed" | "reconnecting";
};

export type { MessageEnvelope };
