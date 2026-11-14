import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Keyv from "keyv";
import KeyvSqlite from "@keyv/sqlite";
import { CacheBus } from "./bus.ts";
import { CacheStream, type CacheStreamOptions } from "./stream.ts";

export interface KeyvCacheOptions {
	/**
	 * SQLite file path. Omit for an in-memory cache (tests and short-lived embedders).
	 * A path keeps values across a host restart, which is what makes a reconnecting WebUI
	 * able to render an in-flight run immediately.
	 */
	readonly path?: string;
	/** Key prefix shared by every instance that opens the same file. */
	readonly namespace?: string;
	/** Table name inside the cache database. */
	readonly table?: string;
	/** TTL applied when `set()` does not provide one. Omit for no expiry. */
	readonly defaultTtlMs?: number;
	readonly onError?: (error: unknown) => void;
}

export interface CacheSetOptions {
	/** Time to live in milliseconds. `0` or omitted means no expiry. */
	readonly ttlMs?: number;
}

export interface CacheStats {
	readonly deletes: number;
	readonly errors: number;
	readonly gets: number;
	readonly hits: number;
	readonly misses: number;
	readonly publishes: number;
	readonly sets: number;
	readonly streamAppends: number;
}

export class KeyvCache {
	readonly bus: CacheBus;
	readonly #keyv: Keyv;
	readonly #namespace: string;
	readonly #defaultTtlMs: number | undefined;
	readonly #onError: ((error: unknown) => void) | undefined;
	readonly #locks = new Map<string, Promise<void>>();
	readonly #stats = {
		deletes: 0,
		errors: 0,
		gets: 0,
		hits: 0,
		misses: 0,
		publishes: 0,
		sets: 0,
		streamAppends: 0,
	};

	constructor(options: KeyvCacheOptions = {}) {
		this.#namespace = options.namespace ?? "tsukaima";
		this.#defaultTtlMs = options.defaultTtlMs;
		this.#onError = options.onError;
		this.bus = new CacheBus({
			onError: (error) => {
				this.#stats.errors += 1;
				this.#onError?.(error);
			},
		});
		const keyvOptions = { namespace: this.#namespace };
		if (options.path === undefined) {
			this.#keyv = new Keyv(keyvOptions);
		} else {
			mkdirSync(dirname(options.path), { recursive: true });
			const store = new KeyvSqlite({
				busyTimeout: 5_000,
				clearExpiredInterval: 30_000,
				driver: "bun:sqlite",
				table: options.table ?? "tsukaima_cache",
				uri: `sqlite://${options.path}`,
				wal: true,
			});
			this.#keyv = new Keyv({ ...keyvOptions, store });
		}
		this.#keyv.on("error", (error: unknown) => {
			this.#stats.errors += 1;
			this.#onError?.(error);
		});
	}

	async get<T>(key: string): Promise<T | undefined> {
		this.#stats.gets += 1;
		const value = (await this.#keyv.get(key)) as T | undefined;
		if (value === undefined) this.#stats.misses += 1;
		else this.#stats.hits += 1;
		return value;
	}

	async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
		this.#stats.sets += 1;
		const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
		if (ttlMs === undefined || ttlMs <= 0) await this.#keyv.set(key, value);
		else await this.#keyv.set(key, value, ttlMs);
	}

	async has(key: string): Promise<boolean> {
		return await this.#keyv.has(key);
	}

	async delete(key: string): Promise<boolean> {
		this.#stats.deletes += 1;
		return await this.#keyv.delete(key);
	}

	/**
	 * Read a value, or compute and store it on a miss. The per-key lock keeps a burst of
	 * callers from running the same expensive factory concurrently.
	 */
	async getOrSet<T>(
		key: string,
		factory: () => Promise<T> | T,
		options: CacheSetOptions = {},
	): Promise<T> {
		return await this.#withLock(key, async () => {
			const existing = await this.get<T>(key);
			if (existing !== undefined) return existing;
			const value = await factory();
			await this.set(key, value, options);
			return value;
		});
	}

	/** Atomic increment for counters such as a live-run revision. */
	async increment(key: string, by = 1, options: CacheSetOptions = {}): Promise<number> {
		return await this.#withLock(key, async () => {
			const current = (await this.get<number>(key)) ?? 0;
			const next = current + by;
			await this.set(key, next, options);
			return next;
		});
	}

	/** Logical keys in this cache, optionally filtered by prefix. */
	async keys(prefix?: string): Promise<readonly string[]> {
		const keys: string[] = [];
		for await (const [key] of this.#keyv.iterator()) {
			if (typeof key !== "string") continue;
			if (prefix !== undefined && !key.startsWith(prefix)) continue;
			keys.push(key);
		}
		return keys;
	}

	/** Delete every key, or every key with `prefix`. */
	async clear(prefix?: string): Promise<void> {
		if (prefix === undefined) {
			await this.#keyv.clear();
			return;
		}
		const keys = await this.keys(prefix);
		if (keys.length > 0) await this.#keyv.deleteMany([...keys]);
	}

	/** Namespace a stream inside this cache. */
	stream(name: string, options: CacheStreamOptions = {}): CacheStream {
		return new CacheStream(this, name, options);
	}

	async publish<T>(channel: string, payload: T): Promise<void> {
		this.#stats.publishes += 1;
		this.bus.publish(channel, payload);
	}

	subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
		return this.bus.subscribe(channel, handler);
	}

	stats(): CacheStats {
		return { ...this.#stats };
	}

	/** Serialize a read-modify-write on one key. */
	async withKeyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		return await this.#withLock(key, run);
	}

	/** Called by {@link CacheStream} because a stream append is a cache write with its own metric. */
	noteStreamAppend(): void {
		this.#stats.streamAppends += 1;
	}

	async close(): Promise<void> {
		await this.#keyv.disconnect();
	}

	async #withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(key) ?? Promise.resolve();
		const current = previous.then(run, run);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.#locks.set(key, tail);
		try {
			return await current;
		} finally {
			if (this.#locks.get(key) === tail) this.#locks.delete(key);
		}
	}
}
