import {
	expandChannelCapabilities,
	expandLegacyChannelCapabilities,
	hasChannelCapability,
	type ChannelAdapter,
	type ChannelCapability,
	type ChannelCapabilityNarrowing,
	type ChannelDiagnostics,
	type SendOptions,
	type SendResult,
} from "@tsukaima/sdk";
import type {
	ChannelNotice,
	ChannelRequest,
	MessageEnvelope,
	MessagePart,
} from "@tsukaima/contracts";

export interface ChannelStatus extends ChannelDiagnostics {
	readonly id: string;
	readonly kind: string;
}

export interface ChannelRegistryOptions {
	/** Host-owned ingestion pipeline for inbound messages. */
	readonly onEnvelope?: (channelId: string, envelope: MessageEnvelope) => void;
	/** Host-owned inbox for friend/group requests. */
	readonly onRequest?: (channelId: string, request: ChannelRequest) => void;
	/** Host-owned notice stream (poke, revoke, reactions, moderation, ...). */
	readonly onNotice?: (channelId: string, notice: ChannelNotice) => void;
}

/**
 * The single place the server learns about channels. Channel plugins register their
 * adapters here instead of the lifecycle constructing them directly.
 */
export class ChannelRegistry {
	readonly #adapters = new Map<string, ChannelAdapter>();
	readonly #narrowings = new Map<string, ChannelCapabilityNarrowing>();
	readonly #conversationNarrowings = new Map<string, ChannelCapabilityNarrowing>();
	readonly #options: ChannelRegistryOptions;

	constructor(options: ChannelRegistryOptions = {}) {
		this.#options = options;
	}

	get size(): number {
		return this.#adapters.size;
	}

	register(adapter: ChannelAdapter): () => void {
		if (this.#adapters.has(adapter.id)) {
			throw new Error(`Channel ${adapter.id} is already registered`);
		}
		this.#adapters.set(adapter.id, adapter);
		const { onEnvelope, onNotice, onRequest } = this.#options;
		if (onEnvelope !== undefined) {
			adapter.onEnvelope((envelope) => onEnvelope(adapter.id, envelope));
		}
		if (onNotice !== undefined && adapter.onNotice !== undefined) {
			adapter.onNotice((notice) => onNotice(adapter.id, notice));
		}
		if (onRequest !== undefined && adapter.onRequest !== undefined) {
			adapter.onRequest((request) => onRequest(adapter.id, request));
		}
		return () => {
			this.#adapters.delete(adapter.id);
			this.#narrowings.delete(adapter.id);
			for (const key of this.#conversationNarrowings.keys()) {
				if (key.startsWith(`${adapter.id}:`)) this.#conversationNarrowings.delete(key);
			}
		};
	}

	get(channelId: string): ChannelAdapter | undefined {
		return this.#adapters.get(channelId);
	}

	list(): readonly ChannelAdapter[] {
		return [...this.#adapters.values()];
	}

	/** Narrow (or reset) host capabilities for a channel, optionally per conversation. */
	narrow(
		channelId: string,
		narrowing: ChannelCapabilityNarrowing | null,
		conversationId?: string,
	): void {
		const key = conversationId === undefined ? channelId : `${channelId}:${conversationId}`;
		const target = conversationId === undefined ? this.#narrowings : this.#conversationNarrowings;
		if (narrowing === null) {
			target.delete(key);
			return;
		}
		target.set(key, narrowing);
	}

	capabilities(channelId: string, conversationId?: string): readonly ChannelCapability[] {
		const adapter = this.#adapters.get(channelId);
		if (adapter === undefined) return [];
		const base = new Set<ChannelCapability>(adapter.capabilities());
		for (const capability of expandChannelCapabilities(adapter.capabilities()))
			base.add(capability);
		const apply = (narrowing: ChannelCapabilityNarrowing | undefined) => {
			if (narrowing === undefined) return;
			const allow = narrowing.allow === undefined ? undefined : new Set(narrowing.allow);
			const deny = new Set(narrowing.deny ?? []);
			for (const capability of base) {
				const expanded = expandLegacyChannelCapabilities(capability);
				const denied = deny.has(capability) || expanded.some((candidate) => deny.has(candidate));
				const allowed =
					allow === undefined ||
					allow.has(capability) ||
					expanded.some((candidate) => allow.has(candidate));
				if (denied || !allowed) base.delete(capability);
			}
		};
		apply(this.#narrowings.get(channelId));
		if (conversationId !== undefined) {
			apply(this.#conversationNarrowings.get(`${channelId}:${conversationId}`));
		}
		return [...base];
	}

	hasCapability(channelId: string, required: ChannelCapability, conversationId?: string): boolean {
		return hasChannelCapability(this.capabilities(channelId, conversationId), required);
	}

	statuses(): readonly ChannelStatus[] {
		return this.list().map((adapter) => ({
			...adapter.diagnostics(),
			id: adapter.id,
			kind: adapter.kind,
		}));
	}

	async send(
		channelId: string,
		kind: "private" | "group",
		platformConversationId: string,
		parts: readonly MessagePart[],
		options?: SendOptions,
	): Promise<SendResult> {
		const adapter = this.#adapters.get(channelId);
		if (adapter === undefined) {
			throw new Error(`Channel ${channelId} is not registered`);
		}
		return adapter.send({ channelId, kind, platformConversationId }, parts, options);
	}

	/** No-op when the adapter does not support typing indicators. */
	async sendTyping(
		channelId: string,
		kind: "private" | "group",
		platformConversationId: string,
		typing: boolean,
	): Promise<void> {
		const adapter = this.#adapters.get(channelId);
		if (adapter?.sendTyping === undefined) return;
		try {
			await adapter.sendTyping({ channelId, kind, platformConversationId }, typing);
		} catch {
			// Typing is cosmetic; a platform rejection must never fail the reply.
		}
	}
}
