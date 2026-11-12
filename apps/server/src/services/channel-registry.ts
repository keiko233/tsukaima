import type { ChannelAdapter, ChannelDiagnostics, SendResult } from "@tsukaima/sdk";
import type { MessagePart } from "@tsukaima/contracts";

export interface ChannelStatus extends ChannelDiagnostics {
	readonly id: string;
	readonly kind: string;
}

/**
 * The single place the server learns about channels. Channel plugins register their
 * adapters here instead of the lifecycle constructing them directly.
 */
export class ChannelRegistry {
	readonly #adapters = new Map<string, ChannelAdapter>();

	get size(): number {
		return this.#adapters.size;
	}

	register(adapter: ChannelAdapter): () => void {
		if (this.#adapters.has(adapter.id)) {
			throw new Error(`Channel ${adapter.id} is already registered`);
		}
		this.#adapters.set(adapter.id, adapter);
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
