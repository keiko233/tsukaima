import { hasPermission, type PluginPermission } from "./permissions.ts";
import type { PluginStorage, SerializedValue } from "./types.ts";

export type PluginStorageScope = "global" | "conversation";

export interface PluginStorageRow {
	readonly key: string;
	readonly pluginId: string;
	readonly scope: PluginStorageScope;
	readonly scopeKey: string;
	readonly updatedAt: string;
	readonly valueJson: string;
}

/** Narrow persistence port so the SDK does not depend on a concrete database package. */
export interface PluginStorageDriver {
	get(
		pluginId: string,
		scope: PluginStorageScope,
		scopeKey: string,
		key: string,
	): string | undefined | Promise<string | undefined>;
	set(row: PluginStorageRow): void | Promise<void>;
	delete?(
		pluginId: string,
		scope: PluginStorageScope,
		scopeKey: string,
		key: string,
	): void | Promise<void>;
	list?(pluginId: string): readonly PluginStorageRow[] | Promise<readonly PluginStorageRow[]>;
	deleteAll?(pluginId: string): void | Promise<void>;
}

export interface SqlitePluginStorageOptions {
	readonly driver: PluginStorageDriver;
	readonly pluginId: string;
	/** Manifest grants. Omit to allow both scopes (pure unit tests). */
	readonly grantedPermissions?: readonly PluginPermission[];
	readonly now?: () => Date;
}

/**
 * Durable plugin key/value storage. Despite the historical name, persistence is provided by
 * any SQLite-backed `PluginStorageDriver`; the host wires it to `pluginKvStorage`.
 */
export class SqlitePluginStorage implements PluginStorage {
	readonly #driver: PluginStorageDriver;
	readonly #pluginId: string;
	readonly #grantedPermissions: readonly PluginPermission[] | undefined;
	readonly #now: () => Date;

	constructor(options: SqlitePluginStorageOptions) {
		this.#driver = options.driver;
		this.#pluginId = options.pluginId;
		this.#grantedPermissions = options.grantedPermissions;
		this.#now = options.now ?? (() => new Date());
	}

	readonly conversation = {
		get: async <T = SerializedValue>(
			conversationId: string,
			key: string,
		): Promise<T | undefined> => {
			this.#assertScope("conversation");
			return (await this.#get("conversation", conversationId, key)) as T | undefined;
		},
		set: async (conversationId: string, key: string, value: SerializedValue): Promise<void> => {
			this.#assertScope("conversation");
			await this.#set("conversation", conversationId, key, value);
		},
	};

	readonly global = {
		get: async <T = SerializedValue>(key: string): Promise<T | undefined> => {
			this.#assertScope("global");
			return (await this.#get("global", "", key)) as T | undefined;
		},
		set: async (key: string, value: SerializedValue): Promise<void> => {
			this.#assertScope("global");
			await this.#set("global", "", key, value);
		},
	};

	async exportAll(): Promise<readonly PluginStorageRow[]> {
		return (await this.#driver.list?.(this.#pluginId)) ?? [];
	}

	async importAll(rows: readonly PluginStorageRow[]): Promise<void> {
		for (const row of rows) {
			if (row.pluginId !== this.#pluginId) continue;
			await this.#driver.set(row);
		}
	}

	async clear(): Promise<void> {
		await this.#driver.deleteAll?.(this.#pluginId);
	}

	#assertScope(scope: PluginStorageScope): void {
		if (this.#grantedPermissions === undefined) return;
		const permission = scope === "global" ? "storage.global" : "storage.conversation";
		if (!hasPermission(this.#grantedPermissions, permission)) {
			throw new Error(`Plugin ${this.#pluginId} is not granted permission ${permission}`);
		}
	}

	async #get(
		scope: PluginStorageScope,
		scopeKey: string,
		key: string,
	): Promise<unknown | undefined> {
		const raw = await this.#driver.get(this.#pluginId, scope, scopeKey, key);
		if (raw === undefined) return undefined;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return undefined;
		}
	}

	async #set(
		scope: PluginStorageScope,
		scopeKey: string,
		key: string,
		value: unknown,
	): Promise<void> {
		const valueJson = JSON.stringify(value);
		if (valueJson === undefined) throw new Error("Plugin storage value must be JSON-serializable");
		await this.#driver.set({
			key,
			pluginId: this.#pluginId,
			scope,
			scopeKey,
			updatedAt: this.#now().toISOString(),
			valueJson,
		});
	}
}
