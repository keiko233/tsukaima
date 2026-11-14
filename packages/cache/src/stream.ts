import type { KeyvCache } from "./keyv-cache.ts";

export interface CacheStreamOptions {
	/** Retained events per stream. Old events leave from the front. Default 200. */
	readonly maxEvents?: number;
	/** Time to live for the whole stream, refreshed by every append. Omit for no expiry. */
	readonly ttlMs?: number;
}

export interface CacheStreamEvent<T = unknown> {
	/** Monotonic per-stream sequence number, starting at 1. */
	readonly seq: number;
	readonly atMs: number;
	readonly value: T;
}

interface StreamRecord {
	readonly events: CacheStreamEvent[];
	readonly nextSeq: number;
}

const DEFAULT_MAX_EVENTS = 200;

/**
 * A bounded append-only log on top of Keyv, the "Redis Stream" shape a live run needs.
 *
 * The latest value of a run lives in a normal key. The event log is for replay: a client
 * that reconnects asks for events after its last sequence number instead of re-reading a
 * full transcript. The whole log is one Keyv value, which is enough for the single Bun
 * process this host runs; the append path is serialized per stream by a key lock.
 */
export class CacheStream {
	readonly #cache: KeyvCache;
	readonly #key: string;
	readonly #maxEvents: number;
	readonly #ttlMs: number | undefined;

	constructor(cache: KeyvCache, name: string, options: CacheStreamOptions = {}) {
		this.#cache = cache;
		this.#key = `stream:${name}`;
		this.#maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
		this.#ttlMs = options.ttlMs;
	}

	async append<T>(value: T): Promise<CacheStreamEvent<T>> {
		return await this.#cache.withKeyLock(this.#key, async () => {
			const record = (await this.#cache.get<StreamRecord>(this.#key)) ?? {
				events: [],
				nextSeq: 1,
			};
			const event: CacheStreamEvent<T> = {
				atMs: Date.now(),
				seq: record.nextSeq,
				value,
			};
			const events = [...record.events, event as CacheStreamEvent].slice(-this.#maxEvents);
			await this.#cache.set(
				this.#key,
				{ events, nextSeq: event.seq + 1 } satisfies StreamRecord,
				this.#ttlMs === undefined ? {} : { ttlMs: this.#ttlMs },
			);
			this.#cache.noteStreamAppend();
			return event;
		});
	}

	async read<T = unknown>(afterSeq = 0, limit = 100): Promise<readonly CacheStreamEvent<T>[]> {
		const record = await this.#cache.get<StreamRecord>(this.#key);
		if (record === undefined) return [];
		return record.events
			.filter((event) => event.seq > afterSeq)
			.slice(0, Math.max(1, Math.floor(limit))) as readonly CacheStreamEvent<T>[];
	}

	async latest<T = unknown>(): Promise<CacheStreamEvent<T> | undefined> {
		const record = await this.#cache.get<StreamRecord>(this.#key);
		return record?.events.at(-1) as CacheStreamEvent<T> | undefined;
	}

	async length(): Promise<number> {
		const record = await this.#cache.get<StreamRecord>(this.#key);
		return record?.events.length ?? 0;
	}

	async clear(): Promise<void> {
		await this.#cache.delete(this.#key);
	}
}
