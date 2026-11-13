import type { PluginHookName } from "@elaina/sdk";
import type { Logger } from "../logging.ts";

type HookHandler = (payload: unknown) => unknown | Promise<unknown>;

/**
 * Host-side hook fan-out. Plugins subscribe through `context.events`; the pipeline emits
 * at real points. A failing handler never breaks message processing.
 */
export class HookBus {
	readonly #handlers = new Map<PluginHookName, Set<HookHandler>>();
	readonly #logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger.child("elaina::server::hooks");
	}

	on(name: PluginHookName, handler: HookHandler): () => void {
		const handlers = this.#handlers.get(name) ?? new Set<HookHandler>();
		handlers.add(handler);
		this.#handlers.set(name, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#handlers.delete(name);
		};
	}

	async emit(name: PluginHookName, payload: unknown): Promise<void> {
		const handlers = this.#handlers.get(name);
		if (handlers === undefined) return;
		for (const handler of handlers) {
			try {
				await handler(payload);
			} catch (error) {
				this.#logger.warn("plugin hook failed", {
					error: error instanceof Error ? error.message : String(error),
					hook: name,
				});
			}
		}
	}

	/**
	 * Ordered transform fan-out. Handlers run in registration order and each may replace the
	 * value seen by the next handler. A throwing handler is logged and skipped.
	 */
	async transform(name: PluginHookName, payload: unknown): Promise<unknown> {
		let current = payload;
		for (const handler of this.#handlers.get(name) ?? []) {
			try {
				const next = await handler(current);
				if (next !== undefined) current = next;
			} catch (error) {
				this.#logger.warn("plugin transform hook failed", {
					error: error instanceof Error ? error.message : String(error),
					hook: name,
				});
			}
		}
		return current;
	}

	emitDetached(name: PluginHookName, payload: unknown): void {
		void this.emit(name, payload).catch(() => undefined);
	}
}
