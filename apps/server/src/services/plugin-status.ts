import type { PluginStatusSnapshot } from "@elaina/contracts";

type StatusListener = (pluginId: string, status: PluginStatusSnapshot | null) => void;

/**
 * In-memory health snapshots for plugin pages. This is deliberately not durable: a status
 * describes the current runtime, and a restart starts every plugin fresh.
 */
export class PluginStatusStore {
	readonly #listeners = new Set<StatusListener>();
	readonly #statuses = new Map<string, PluginStatusSnapshot>();

	get(pluginId: string): PluginStatusSnapshot | undefined {
		return this.#statuses.get(pluginId);
	}

	list(): ReadonlyMap<string, PluginStatusSnapshot> {
		return this.#statuses;
	}

	set(pluginId: string, status: PluginStatusSnapshot | null): void {
		if (status === null) {
			if (!this.#statuses.delete(pluginId)) return;
		} else {
			this.#statuses.set(pluginId, status);
		}
		for (const listener of this.#listeners) {
			try {
				listener(pluginId, status);
			} catch {}
		}
	}

	clear(pluginId: string): void {
		this.set(pluginId, null);
	}

	subscribe(listener: StatusListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
}
