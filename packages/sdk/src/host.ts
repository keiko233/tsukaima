import type { ChannelRequest, MessageEnvelope, MessagePart } from "@elaina/contracts";

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
}

export interface OutboundTarget {
	readonly channelId: string;
	readonly kind: "private" | "group";
	readonly platformConversationId: string;
}

export interface SendResult {
	readonly platformMessageId?: string;
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
	send(target: OutboundTarget, parts: readonly MessagePart[]): Promise<SendResult>;
	onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
	onRequest?(handler: (request: ChannelRequest) => void): void;
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
