import { assertPluginSqlNamespaced, pluginSqlPrefix } from "@elaina/plugin-registry";
import type { ElainaDatabase } from "@elaina/db";
import type { PluginDatabaseApi } from "@elaina/sdk";

type RawSqlite = {
	readonly query: (sql: string) => {
		all: (...params: unknown[]) => unknown[];
		run: (...params: unknown[]) => unknown;
	};
	readonly run: (sql: string, ...params: unknown[]) => unknown;
};

/**
 * Host-mode-only SQLite facade. Every statement is checked against the plugin's object prefix
 * before it reaches the shared connection; worker-mode plugins never receive this handle.
 */
export function createScopedPluginDatabase(
	database: ElainaDatabase,
	pluginId: string,
): PluginDatabaseApi {
	const prefix = pluginSqlPrefix(pluginId);
	const assert = (sql: string) => assertPluginSqlNamespaced(sql, pluginId);
	return {
		async exec(sql) {
			assert(sql);
			(database as unknown as { $client: RawSqlite }).$client.run(sql);
		},
		prefix,
		async query<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
			assert(sql);
			return (database as unknown as { $client: RawSqlite }).$client
				.query(sql)
				.all(...params) as T[];
		},
	};
}
