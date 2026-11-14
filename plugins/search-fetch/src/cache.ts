import type { PluginLogger } from "@tsukaima/sdk";

export interface SnapshotRecord {
	readonly bytes: number;
	readonly contentType: string;
	readonly conversationId?: string;
	readonly description?: string;
	readonly fetchId: string;
	readonly finalUrl: string;
	readonly fetchedAtMs: number;
	readonly language?: string;
	readonly lastAccessMs: number;
	readonly status: number;
	readonly text: string;
	readonly title: string;
	readonly url: string;
}

export interface SnapshotInput {
	readonly contentType: string;
	readonly description?: string;
	readonly fetchId: string;
	readonly finalUrl: string;
	readonly fetchedAtMs: number;
	readonly language?: string;
	readonly status: number;
	readonly text: string;
	readonly title: string;
	readonly url: string;
}

export interface SnapshotCacheOptions {
	readonly logger?: PluginLogger;
	readonly maxBytes: number;
	readonly maxEntries: number;
	readonly now?: () => number;
	readonly ttlMs: number;
}

export interface SnapshotCacheStats {
	readonly bytes: number;
	readonly entries: number;
	readonly maxBytes: number;
	readonly maxEntries: number;
	readonly scopedEntries: number;
	readonly ttlMs: number;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
	return encoder.encode(value).length;
}

/**
 * Bounded, TTL-scoped snapshot cache. Entries written with a conversation scope are only
 * readable by that conversation; global entries are readable by every conversation.
 */
export class SnapshotCache {
	readonly #entries = new Map<string, SnapshotRecord>();
	readonly #logger: PluginLogger | undefined;
	#maxBytes: number;
	#maxEntries: number;
	readonly #now: () => number;
	#ttlMs: number;
	#bytes = 0;

	constructor(options: SnapshotCacheOptions) {
		this.#logger = options.logger;
		this.#maxBytes = Math.max(1, Math.floor(options.maxBytes));
		this.#maxEntries = Math.max(1, Math.floor(options.maxEntries));
		this.#now = options.now ?? Date.now;
		this.#ttlMs = Math.max(1, Math.floor(options.ttlMs));
	}

	configure(options: Partial<SnapshotCacheOptions>): void {
		if (options.maxBytes !== undefined) {
			this.#maxBytes = Math.max(1, Math.floor(options.maxBytes));
		}
		if (options.maxEntries !== undefined) {
			this.#maxEntries = Math.max(1, Math.floor(options.maxEntries));
		}
		if (options.ttlMs !== undefined) {
			this.#ttlMs = Math.max(1, Math.floor(options.ttlMs));
		}
		this.#evictExpired();
		this.#enforceLimits();
		this.#logger?.debug("snapshot cache configured", {
			entries: this.#entries.size,
			maxBytes: this.#maxBytes,
			maxEntries: this.#maxEntries,
			ttlMs: this.#ttlMs,
		});
	}

	get maxBytes(): number {
		return this.#maxBytes;
	}

	get maxEntries(): number {
		return this.#maxEntries;
	}

	get ttlMs(): number {
		return this.#ttlMs;
	}

	set(input: SnapshotInput, conversationId?: string): SnapshotRecord {
		const record: SnapshotRecord = {
			bytes:
				byteLength(input.text) +
				byteLength(input.title) +
				byteLength(input.url) +
				byteLength(input.finalUrl),
			contentType: input.contentType,
			...(conversationId === undefined ? {} : { conversationId }),
			...(input.description === undefined ? {} : { description: input.description }),
			fetchId: input.fetchId,
			fetchedAtMs: input.fetchedAtMs,
			finalUrl: input.finalUrl,
			...(input.language === undefined ? {} : { language: input.language }),
			lastAccessMs: this.#now(),
			status: input.status,
			text: input.text,
			title: input.title,
			url: input.url,
		};
		this.delete(input.fetchId);
		this.#entries.set(record.fetchId, record);
		this.#bytes += record.bytes;
		this.#enforceLimits();
		this.#logger?.trace("snapshot stored", {
			bytes: record.bytes,
			entries: this.#entries.size,
			fetchId: record.fetchId,
			scoped: conversationId !== undefined,
			totalBytes: this.#bytes,
		});
		return record;
	}

	get(fetchId: string, conversationId?: string): SnapshotRecord | undefined {
		const record = this.#entries.get(fetchId);
		if (record === undefined) {
			this.#logger?.trace("snapshot cache miss", { fetchId, reason: "missing" });
			return undefined;
		}
		if (this.#isExpired(record)) {
			this.#logger?.trace("snapshot cache miss", { fetchId, reason: "expired" });
			this.delete(fetchId, "expired");
			return undefined;
		}
		if (record.conversationId !== undefined && record.conversationId !== conversationId) {
			this.#logger?.trace("snapshot cache miss", { fetchId, reason: "conversation_scope" });
			return undefined;
		}
		const now = this.#now();
		const accessed: SnapshotRecord = { ...record, lastAccessMs: now };
		this.#entries.set(fetchId, accessed);
		this.#logger?.trace("snapshot cache hit", {
			ageMs: now - record.fetchedAtMs,
			bytes: record.bytes,
			fetchId,
			scoped: record.conversationId !== undefined,
		});
		return accessed;
	}

	delete(fetchId: string, reason = "delete"): boolean {
		const existing = this.#entries.get(fetchId);
		if (existing === undefined) return false;
		this.#entries.delete(fetchId);
		this.#bytes = Math.max(0, this.#bytes - existing.bytes);
		this.#logger?.trace("snapshot evicted", {
			bytes: existing.bytes,
			entries: this.#entries.size,
			fetchId,
			reason,
		});
		return true;
	}

	/** Clear every snapshot, or only the snapshots scoped to one conversation. */
	clear(conversationId?: string): number {
		let removed = 0;
		for (const [fetchId, record] of this.#entries) {
			if (conversationId !== undefined && record.conversationId !== conversationId) continue;
			this.delete(fetchId, "clear");
			removed += 1;
		}
		this.#logger?.debug("snapshot cache cleared", {
			conversationScoped: conversationId !== undefined,
			entries: this.#entries.size,
			removed,
			remainingBytes: this.#bytes,
		});
		return removed;
	}

	stats(): SnapshotCacheStats {
		this.#evictExpired();
		let scoped = 0;
		for (const record of this.#entries.values()) {
			if (record.conversationId !== undefined) scoped += 1;
		}
		return {
			bytes: this.#bytes,
			entries: this.#entries.size,
			maxBytes: this.#maxBytes,
			maxEntries: this.#maxEntries,
			scopedEntries: scoped,
			ttlMs: this.#ttlMs,
		};
	}

	#isExpired(record: SnapshotRecord): boolean {
		return this.#now() - record.fetchedAtMs > this.#ttlMs;
	}

	#evictExpired(): void {
		for (const [fetchId, record] of this.#entries) {
			if (this.#isExpired(record)) this.delete(fetchId, "ttl");
		}
	}

	#enforceLimits(): void {
		while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
			let oldest: SnapshotRecord | undefined;
			for (const record of this.#entries.values()) {
				if (oldest === undefined || record.lastAccessMs < oldest.lastAccessMs) {
					oldest = record;
				}
			}
			if (oldest === undefined) return;
			this.delete(oldest.fetchId, "lru_limit");
		}
	}
}
