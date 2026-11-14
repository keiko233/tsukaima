import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PluginNamingError, sanitizePluginId } from "./naming.ts";

/** Minimal synchronous SQLite surface used for migrations and legacy imports. */
export interface PluginSqlConnection {
	exec(sql: string): void;
	query<T = unknown>(sql: string, params?: readonly unknown[]): readonly T[];
	transaction<T>(task: () => T): T;
}

/** One plugin-owned SQLite file. */
export interface PluginDatabaseConnection extends PluginSqlConnection {
	readonly path: string;
	close(): void;
}

export interface PluginDatabaseProvider {
	close(pluginId: string): void;
	get(pluginId: string): PluginDatabaseConnection | undefined;
	open(pluginId: string): Promise<PluginDatabaseConnection>;
}

export interface PluginDatabaseStoreOptions {
	/** Directory that holds `<sanitized-plugin-id>.sqlite` files. */
	readonly directory: string;
}

interface BunSqliteLike {
	exec(sql: string): void;
	query(sql: string): { all: (...params: never[]) => unknown[] };
	transaction<T>(task: () => T): () => T;
}

function openConnection(path: string): PluginDatabaseConnection {
	const database = new Database(path, { create: true });
	database.run("PRAGMA journal_mode = WAL");
	database.run("PRAGMA synchronous = NORMAL");
	database.run("PRAGMA busy_timeout = 5000");
	database.run("PRAGMA foreign_keys = ON");
	return {
		close: () => database.close(),
		exec: (sql) => database.exec(sql),
		path,
		query: <T = unknown>(sql: string, params: readonly unknown[] = []): readonly T[] =>
			database.query(sql).all(...(params as never[])) as T[],
		transaction: <T>(task: () => T): T => database.transaction(task)(),
	};
}

/**
 * Wrap an existing Bun SQLite connection (for example the domain database's raw client) in the
 * small surface used by legacy plugin data imports.
 */
export function wrapPluginSqlConnection(database: BunSqliteLike): PluginSqlConnection {
	return {
		exec: (sql) => database.exec(sql),
		query: <T = unknown>(sql: string, params: readonly unknown[] = []): readonly T[] =>
			database.query(sql).all(...(params as never[])) as T[],
		transaction: <T>(task: () => T): T => database.transaction(task)(),
	};
}

/**
 * Opens and caches one SQLite file per plugin under `<data-dir>/plugins/`.
 *
 * Sanitized ids must be unique: `my-plugin` and `my_plugin` would otherwise share a file, so the
 * store rejects the second owner instead of silently mixing their data.
 */
export class PluginDatabaseStore implements PluginDatabaseProvider {
	readonly #directory: string;
	readonly #connections = new Map<string, PluginDatabaseConnection>();
	readonly #owners = new Map<string, string>();

	constructor(options: PluginDatabaseStoreOptions) {
		this.#directory = options.directory;
	}

	get directory(): string {
		return this.#directory;
	}

	pathFor(pluginId: string): string {
		const key = this.#key(pluginId);
		return join(this.#directory, `${key}.sqlite`);
	}

	get(pluginId: string): PluginDatabaseConnection | undefined {
		return this.#connections.get(sanitizePluginId(pluginId));
	}

	async open(pluginId: string): Promise<PluginDatabaseConnection> {
		const key = this.#key(pluginId);
		const existing = this.#connections.get(key);
		if (existing !== undefined) return existing;
		await mkdir(this.#directory, { recursive: true });
		const connection = openConnection(join(this.#directory, `${key}.sqlite`));
		this.#connections.set(key, connection);
		return connection;
	}

	close(pluginId: string): void {
		const key = sanitizePluginId(pluginId);
		this.#connections.get(key)?.close();
		this.#connections.delete(key);
		this.#owners.delete(key);
	}

	closeAll(): void {
		for (const connection of this.#connections.values()) connection.close();
		this.#connections.clear();
		this.#owners.clear();
	}

	#key(pluginId: string): string {
		const key = sanitizePluginId(pluginId);
		const owner = this.#owners.get(key);
		if (owner !== undefined && owner !== pluginId) {
			throw new PluginNamingError(
				`Plugins ${owner} and ${pluginId} share the database name ${key}`,
			);
		}
		this.#owners.set(key, pluginId);
		return key;
	}
}
