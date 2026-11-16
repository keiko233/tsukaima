import { and, eq } from "drizzle-orm";
import { pluginKvStorage, type TsukaimaDatabase } from "@tsukaima/db";
import {
	SqlitePluginStorage,
	type PluginPermission,
	type PluginStorageDriver,
	type PluginStorageRow,
} from "@tsukaima/sdk";

function toRow(row: typeof pluginKvStorage.$inferSelect): PluginStorageRow {
	return {
		key: row.key,
		pluginId: row.pluginId,
		scope: row.scope,
		scopeKey: row.scopeKey,
		updatedAt: row.updatedAt,
		valueJson: row.valueJson,
	};
}

/** Durable `pluginKvStorage` driver shared by every plugin storage bridge. */
export class PluginStorageStore {
	readonly #database: () => TsukaimaDatabase | undefined;

	constructor(database: () => TsukaimaDatabase | undefined) {
		this.#database = database;
	}

	driver(pluginId: string): PluginStorageDriver {
		let scopedPluginId = pluginId;
		return {
			delete: async (owner, scope, scopeKey, key) => {
				const database = this.#database();
				if (database === undefined) return;
				await database
					.delete(pluginKvStorage)
					.where(
						and(
							eq(pluginKvStorage.pluginId, owner),
							eq(pluginKvStorage.scope, scope),
							eq(pluginKvStorage.scopeKey, scopeKey),
							eq(pluginKvStorage.key, key),
						),
					);
			},
			deleteAll: async (owner) => {
				const database = this.#database();
				if (database === undefined) return;
				await database.delete(pluginKvStorage).where(eq(pluginKvStorage.pluginId, owner));
			},
			get: async (owner, scope, scopeKey, key) => {
				const database = this.#database();
				if (database === undefined) return undefined;
				const [row] = await database
					.select({ valueJson: pluginKvStorage.valueJson })
					.from(pluginKvStorage)
					.where(
						and(
							eq(pluginKvStorage.pluginId, owner),
							eq(pluginKvStorage.scope, scope),
							eq(pluginKvStorage.scopeKey, scopeKey),
							eq(pluginKvStorage.key, key),
						),
					)
					.limit(1);
				return row?.valueJson;
			},
			list: async (owner) => {
				const database = this.#database();
				if (database === undefined) return [];
				const rows = await database
					.select()
					.from(pluginKvStorage)
					.where(eq(pluginKvStorage.pluginId, owner));
				return rows.map(toRow);
			},
			set: async (row) => {
				const database = this.#database();
				if (database === undefined) return;
				if (row.pluginId !== scopedPluginId) {
					throw new Error(`Storage driver for ${scopedPluginId} cannot write ${row.pluginId}`);
				}
				await database
					.insert(pluginKvStorage)
					.values({
						key: row.key,
						pluginId: row.pluginId,
						scope: row.scope as "global" | "conversation",
						scopeKey: row.scopeKey,
						updatedAt: row.updatedAt,
						valueJson: row.valueJson,
					})
					.onConflictDoUpdate({
						set: { updatedAt: row.updatedAt, valueJson: row.valueJson },
						target: [
							pluginKvStorage.pluginId,
							pluginKvStorage.scope,
							pluginKvStorage.scopeKey,
							pluginKvStorage.key,
						],
					});
				scopedPluginId = row.pluginId;
			},
		};
	}

	bridge(pluginId: string, grantedPermissions: readonly PluginPermission[]): SqlitePluginStorage {
		return new SqlitePluginStorage({
			driver: this.driver(pluginId),
			grantedPermissions,
			pluginId,
		});
	}

	async export(pluginId: string): Promise<readonly PluginStorageRow[]> {
		return (await this.driver(pluginId).list?.(pluginId)) ?? [];
	}

	async import(rows: readonly PluginStorageRow[]): Promise<void> {
		const driver = this.driver(rows[0]?.pluginId ?? "plugin");
		for (const row of rows) await driver.set(row);
	}

	async clear(pluginId: string): Promise<void> {
		await this.driver(pluginId).deleteAll?.(pluginId);
	}
}
