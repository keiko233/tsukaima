export type CacheBusHandler<T = unknown> = (payload: T) => void;

export interface CacheBusOptions {
	readonly onError?: (error: unknown, channel: string) => void;
}

interface BusSubscription {
	readonly channel: string;
	readonly handler: CacheBusHandler;
	readonly prefix: string | undefined;
}

/**
 * Process-local pub/sub, the Keyv companion that a plain key/value store lacks.
 *
 * Keyv covers persistence, TTL, and atomic reads. It deliberately has no notification
 * channel, so live state needs a small in-process bus beside it: every SSE connection
 * subscribes here and a writer publishes once. The bus is intentionally not persisted:
 * a subscriber that was offline when a run changed reads the snapshot in Keyv instead.
 */
export class CacheBus {
	readonly #subscriptions = new Set<BusSubscription>();
	readonly #onError: ((error: unknown, channel: string) => void) | undefined;

	constructor(options: CacheBusOptions = {}) {
		this.#onError = options.onError;
	}

	get subscriberCount(): number {
		return this.#subscriptions.size;
	}

	/**
	 * Subscribe to one channel, or to a prefix when the channel ends in `*`.
	 * `run.*` receives `run`, `run.active`, and every deeper channel.
	 */
	subscribe<T = unknown>(channel: string, handler: CacheBusHandler<T>): () => void {
		const subscription: BusSubscription = {
			channel,
			handler: handler as CacheBusHandler,
			prefix: channel.endsWith("*") ? channel.slice(0, -1) : undefined,
		};
		this.#subscriptions.add(subscription);
		return () => {
			this.#subscriptions.delete(subscription);
		};
	}

	publish<T = unknown>(channel: string, payload: T): void {
		for (const subscription of this.#subscriptions) {
			const prefix = subscription.prefix;
			const matched =
				prefix === undefined
					? channel === subscription.channel
					: channel === prefix.slice(0, -1) || channel.startsWith(prefix);
			if (!matched) continue;
			try {
				subscription.handler(payload);
			} catch (error) {
				this.#onError?.(error, channel);
			}
		}
	}
}
