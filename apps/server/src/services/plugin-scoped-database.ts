import { assertPluginSqlIsolated, pluginSqlPrefix } from "@tsukaima/plugin-registry";
import type { PluginDatabaseConnection } from "@tsukaima/plugin-registry";
import type { PluginDatabaseApi } from "@tsukaima/sdk";

/**
 * Facade over one plugin's own SQLite file. The file already isolates the plugin from core and
 * other plugins; the only rejected statement is one that would attach another database.
 */
export function createPluginDatabase(
	database: PluginDatabaseConnection,
	pluginId: string,
): PluginDatabaseApi {
	return {
		async exec(sql) {
			assertPluginSqlIsolated(sql, pluginId);
			database.exec(sql);
		},
		prefix: pluginSqlPrefix(pluginId),
		async query<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
			assertPluginSqlIsolated(sql, pluginId);
			return database.query<T>(sql, params);
		},
	};
}
