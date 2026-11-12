import { adminEventSchema, type AdminEvent } from "@tsukaima/contracts";

type AdminEventSubscriber = (event: AdminEvent) => void;

export class AdminEventBus {
	readonly #subscribers = new Set<AdminEventSubscriber>();

	get subscriberCount(): number {
		return this.#subscribers.size;
	}

	subscribe(subscriber: AdminEventSubscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => {
			this.#subscribers.delete(subscriber);
		};
	}

	publish(event: AdminEvent): void {
		adminEventSchema.parse(event);
		for (const subscriber of this.#subscribers) {
			try {
				subscriber(event);
			} catch (error) {
				console.error("Admin event subscriber failed", error);
			}
		}
	}
}
