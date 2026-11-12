import type { ChannelAdapter, ChannelDiagnostics, SendResult } from "@tsukaima/sdk";
import type { ChannelRequest, MessageEnvelope, MessagePart } from "@tsukaima/contracts";

export interface ChannelStatus extends ChannelDiagnostics {
	readonly id: string;
	readonly kind: string;
}

export interface ChannelRegistryOptions {
	/** Host-owned ingestion pipeline for inbound messages. */
	readonly onEnvelope?: (channelId: string, envelope: MessageEnvelope) => void;
	/** Host-owned inbox for friend/group requests. */
	readonly onRequest?: (channelId: string, request: ChannelRequest) => void;
}

/**
 * The single place the server learns about channels. Channel plugins register their
 * adapters here instead of the lifecycle constructing them directly.
 */
export class ChannelRegistry {
	readonly #adapters = new Map<string, ChannelAdapter>();
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
		const { onEnvelope, onRequest } = this.#options;
		if (onEnvelope !== undefined) {
			adapter.onEnvelope((envelope) => onEnvelope(adapter.id, envelope));
		}
		if (onRequest !== undefined && adapter.onRequest !== undefined) {
			adapter.onRequest((request) => onRequest(adapter.id, request));
		}
		return () => {
			this.#adapters.delete(adapter.id);
		};
	}

	get(channelId: string): ChannelAdapter | undefined {
		return this.#adapters.get(channelId);
	}

	list(): readonly ChannelAdapter[] {
		return [...this.#adapters.values()];
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
	): Promise<SendResult> {
		const adapter = this.#adapters.get(channelId);
		if (adapter === undefined) {
			throw new Error(`Channel ${channelId} is not registered`);
		}
		return adapter.send({ channelId, kind, platformConversationId }, parts);
	}
}
