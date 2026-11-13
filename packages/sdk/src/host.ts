import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@elaina/contracts";

/**
 * Capabilities a channel adapter can offer. Plugins that call channel verbs should check
 * for the capability instead of assuming an IM platform supports an action.
 */
export type ChannelCapability =
	| "send"
	| "interact"
	| "group-manage"
	| "read-info"
	| "read-media"
	| "upload"
	| "raw";

export interface ChannelDiagnostics {
	readonly connected: boolean;
	readonly state: string;
	readonly eventCount?: number;
	readonly lastErrorClass?: string | undefined;
	readonly lastEventAtMs?: number;
	readonly reconnectAttempts?: number;
	/** The adapter has a destination configured (even if it is not connected). */
	readonly configured?: boolean;
	/** The adapter failed to start and will not retry until its settings change. */
	readonly restartRequired?: boolean;
	/** Transport mode when the adapter supports more than one (for example forward/reverse). */
	readonly mode?: string;
	/** Reverse-mode peer diagnostics; undefined for outbound transports. */
	readonly remoteAddress?: string;
	readonly origin?: string;
}

export interface OutboundTarget {
	readonly channelId: string;
	readonly kind: "private" | "group";
	readonly platformConversationId: string;
}

export interface SendResult {
	readonly platformMessageId?: string;
}

export interface SendOptions {
	/** Prepend a platform reply segment quoting this message when supported. */
	readonly replyToPlatformMessageId?: string;
}

export interface ChannelHistoryItem {
	readonly platformMessageId: string;
	readonly parts?: readonly MessagePart[];
	readonly senderId?: string;
	readonly text?: string;
	readonly timestampMs?: number;
}

export interface ChannelHistoryOptions {
	readonly limit?: number;
	readonly sinceMs?: number;
}

export interface ChannelRequestDecision {
	readonly action: "approve" | "reject";
	readonly reason?: string;
}

/**
 * The floor a channel plugin implements. The host owns the registry; plugins own the
 * transport, normalization, and platform-specific actions.
 */
export interface ChannelAdapter {
	readonly id: string;
	/** Written into `chat_objects.channelId` classification and `messages.kind`. */
	readonly kind: string;
	capabilities(): readonly ChannelCapability[];
	diagnostics(): ChannelDiagnostics;
	start(): Promise<void>;
	stop(): Promise<void>;
	send(
		target: OutboundTarget,
		parts: readonly MessagePart[],
		options?: SendOptions,
	): Promise<SendResult>;
	onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
	/** Dedicated notice channel; notices never masquerade as message envelopes. */
	onNotice?(handler: (notice: ChannelNotice) => void): void;
	onRequest?(handler: (request: ChannelRequest) => void): void;
	/** Used by pending-delivery reconciliation; optional for read-only transports. */
	lookupMessage?(platformMessageId: string): Promise<ChannelHistoryItem | undefined>;
	readHistory?(
		target: OutboundTarget,
		options?: ChannelHistoryOptions,
	): Promise<readonly ChannelHistoryItem[]>;
	resolveRequest?(request: ChannelRequest, decision: ChannelRequestDecision): Promise<void>;
}

export interface PluginChannelRegistry {
	/** Returns a disposer that unregisters the adapter. */
	register(adapter: ChannelAdapter): () => void;
	get(channelId: string): ChannelAdapter | undefined;
	list(): readonly ChannelAdapter[];
}

export interface PluginSettingsApi<T = unknown> {
	get(): Promise<T>;
	onChange(handler: (next: T) => Promise<void> | void): () => void;
}

export interface PluginRequestApi {
	persist(request: ChannelRequest): Promise<void>;
}

export interface AuditEntry {
	readonly action: string;
	/** Defaults to the WebUI administrator when omitted. */
	readonly actorId?: string;
	readonly actorKind?: "user" | "agent" | "plugin" | "system";
	readonly payload?: unknown;
	readonly reason?: string;
	readonly result: "ok" | "denied" | "failed";
	readonly targetId?: string;
	readonly targetKind: string;
}

export interface PluginAuditApi {
	record(entry: AuditEntry): Promise<void>;
}

/**
 * Read-only bindings the host injects for built-in plugins (test doubles, transport
 * factories, and similar). Third-party plugins never receive these.
 */
export interface PluginDependencyBag {
	get<T = unknown>(key: string): T | undefined;
}
