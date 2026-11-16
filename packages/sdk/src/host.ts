import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@tsukaima/contracts";

/**
 * Capabilities a channel adapter can offer. Plugins that call channel verbs should check
 * for the capability instead of assuming an IM platform supports an action.
 */
export type LegacyChannelCapability =
	| "send"
	| "interact"
	| "group-manage"
	| "read-info"
	| "read-media"
	| "upload"
	| "raw";

export type GranularChannelCapability =
	| "send.text"
	| "send.image"
	| "send.audio"
	| "send.video"
	| "send.file"
	| "send.forward"
	| "reply.quote"
	| "interact.poke"
	| "interact.react"
	| "interact.typing"
	| "manage.group"
	| "manage.friend"
	| "manage.self"
	| "read.history"
	| "fetch.media";

/** Both legacy and granular values are accepted during the compatibility window. */
export type ChannelCapability = LegacyChannelCapability | GranularChannelCapability;

/** Expand a legacy capability to the machine-readable capabilities it implies. */
export function expandLegacyChannelCapabilities(
	capability: ChannelCapability,
): readonly GranularChannelCapability[] {
	switch (capability) {
		case "send":
			return ["send.text", "send.image", "send.audio", "send.video", "send.file"];
		case "interact":
			return ["reply.quote", "interact.poke", "interact.react", "interact.typing"];
		case "group-manage":
			return ["manage.group"];
		case "read-info":
			return ["read.history"];
		case "read-media":
		case "upload":
			return ["fetch.media"];
		case "raw":
			return [];
		default:
			return [capability];
	}
}

export function expandChannelCapabilities(
	capabilities: readonly ChannelCapability[],
): readonly GranularChannelCapability[] {
	const result = new Set<GranularChannelCapability>();
	for (const capability of capabilities) {
		for (const expanded of expandLegacyChannelCapabilities(capability)) result.add(expanded);
	}
	return [...result];
}

/** True when a channel capability set satisfies a required legacy or granular capability. */
export function hasChannelCapability(
	available: readonly ChannelCapability[],
	required: ChannelCapability,
): boolean {
	if (available.includes(required)) return true;
	const expanded = new Set(expandChannelCapabilities(available));
	if (expanded.has(required as GranularChannelCapability)) return true;
	return expandLegacyChannelCapabilities(required).some((value) => expanded.has(value));
}

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
	/** Optional typing/input indicator. Transport-only: callers decide pacing/trigger policy. */
	sendTyping?(target: OutboundTarget, typing: boolean): Promise<void>;
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

export interface ChannelCapabilityNarrowing {
	/** Optional allowlist applied on top of the adapter's own capabilities. */
	readonly allow?: readonly ChannelCapability[];
	/** Capabilities explicitly removed for a conversation. */
	readonly deny?: readonly ChannelCapability[];
}

export interface PluginOutboundSendInput {
	readonly target: OutboundTarget;
	readonly parts: readonly MessagePart[];
	readonly options?: SendOptions;
}

/**
 * A platform interaction that is not a message, for example a poke. The plugin performs the
 * platform call; the host only needs the summary so the interaction stays in durable history.
 */
export interface PluginOutboundInteractionInput {
	readonly target: OutboundTarget;
	/** One-line history summary, such as `[poke] 10001 -> 10002`. */
	readonly summary: string;
	/** Native part type stored with the history row, such as `notice:poke`. */
	readonly nativeType?: string;
}

/**
 * Host-owned outbound path for plugin-initiated sends. Sends are recorded as durable history
 * before delivery so the WebUI transcript and future turns see them, unlike a raw adapter call.
 */
export interface PluginOutboundApi {
	send(input: PluginOutboundSendInput): Promise<SendResult>;
	recordInteraction(input: PluginOutboundInteractionInput): Promise<void>;
}

export interface PluginChannelRegistry {
	/** Returns a disposer that unregisters the adapter. */
	register(adapter: ChannelAdapter): () => void;
	get(channelId: string): ChannelAdapter | undefined;
	list(): readonly ChannelAdapter[];
	/** Host- or conversation-owned narrowing of an adapter's capabilities. */
	narrow?(
		channelId: string,
		narrowing: ChannelCapabilityNarrowing | null,
		conversationId?: string,
	): void;
	capabilities?(channelId: string, conversationId?: string): readonly ChannelCapability[];
	hasCapability?(channelId: string, required: ChannelCapability, conversationId?: string): boolean;
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
