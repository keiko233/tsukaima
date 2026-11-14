import { pluginSqlPrefix } from "./naming.ts";
import type { PluginDatabaseConnection, PluginSqlConnection } from "./plugin-database.ts";

export interface LegacyPluginTableImport {
	/** Rows inserted into the plugin database (SQLite `changes()` for the copy statement). */
	readonly importedRows: number;
	/** Columns copied. New columns are left at their defaults. */
	readonly columns: readonly string[];
	readonly table: string;
}

export interface LegacyPluginDataResult {
	readonly dropped: readonly string[];
	readonly imported: readonly LegacyPluginTableImport[];
	/** Legacy tables with no matching table in the plugin database; they are left untouched. */
	readonly orphaned: readonly string[];
}

export interface LegacyPluginDataOptions {
	/** Raw connection to the domain database (the pre-split shared database). */
	readonly source: PluginSqlConnection;
	/** The plugin's own database. */
	readonly target: PluginDatabaseConnection;
	readonly pluginId: string;
}

interface TableRow {
	readonly name: string;
}

interface ColumnRow {
	readonly name: string;
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function tables(source: PluginSqlConnection, pattern: string): readonly string[] {
	return source
		.query<TableRow>(
			`SELECT name FROM sqlite_master
	WHERE type = 'table' AND name LIKE ? ESCAPE '\\' AND name NOT LIKE 'sqlite_%'
	ORDER BY name`,
			[pattern],
		)
		.map((row) => row.name);
}

function columns(database: PluginSqlConnection, table: string): readonly string[] {
	return database
		.query<ColumnRow>(`PRAGMA table_info(${quoteIdentifier(table)})`)
		.map((row) => row.name);
}

function tableExists(database: PluginSqlConnection, table: string): boolean {
	return (
		database.query<TableRow>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			[table],
		).length > 0
	);
}

/**
 * Move tables created by the old shared-database plugin convention into a plugin's own file.
 *
 * The source tables are dropped only after their matching target tables received the rows. If a
 * target table is missing (for example the plugin no longer owns it), the legacy table is left in
 * the domain database and reported as orphaned rather than silently discarded.
 *
 * The import is idempotent: a crash after copying but before dropping leaves the source in place,
 * and `INSERT OR IGNORE` makes the next run a no-op for already-copied rows.
 */
export function migrateLegacyPluginTables(
	options: LegacyPluginDataOptions,
): LegacyPluginDataResult {
	const prefix = pluginSqlPrefix(options.pluginId);
	const escapedPrefix = prefix.replace(/[_%\\]/gu, "\\$&");
	const legacyTables = tables(options.source, `${escapedPrefix}%`);
	if (legacyTables.length === 0) {
		return { dropped: [], imported: [], orphaned: [] };
	}

	const imported: LegacyPluginTableImport[] = [];
	const dropped: string[] = [];
	const orphaned: string[] = [];
	const schema = `_elaina_legacy_${options.pluginId.replace(/[^a-z0-9_]/giu, "_")}`;

	options.source.exec(`ATTACH DATABASE ${quoteLiteral(options.target.path)} AS ${schema}`);
	try {
		// Foreign keys must be off while dropping mutually-referencing legacy tables in arbitrary
		// order, and while inserting child rows before their parents.
		options.source.exec("PRAGMA foreign_keys = OFF");
		try {
			options.source.transaction(() => {
				for (const table of legacyTables) {
					if (!tableExists(options.target, table)) {
						orphaned.push(table);
						continue;
					}
					const targetColumns = new Set(columns(options.target, table));
					const shared = columns(options.source, table).filter((column) =>
						targetColumns.has(column),
					);
					if (shared.length === 0) {
						orphaned.push(table);
						continue;
					}
					const list = shared.map(quoteIdentifier).join(", ");
					options.source.query(
						`INSERT OR IGNORE INTO ${schema}.${quoteIdentifier(table)} (${list})
	SELECT ${list} FROM main.${quoteIdentifier(table)}`,
					);
					const [change] = options.source.query<{ changes: number }>("SELECT changes() AS changes");
					imported.push({ columns: shared, importedRows: change?.changes ?? 0, table });
					options.source.exec(`DROP TABLE main.${quoteIdentifier(table)}`);
					dropped.push(table);
				}
				if (tableExists(options.source, "plugin_migrations")) {
					options.source.query("DELETE FROM plugin_migrations WHERE plugin_id = ?", [
						options.pluginId,
					]);
				}
			});
		} finally {
			options.source.exec("PRAGMA foreign_keys = ON");
		}
	} finally {
		try {
			options.source.exec(`DETACH DATABASE ${schema}`);
		} catch {
			// The transaction may already have detached implicitly after an error.
		}
	}
	return { dropped, imported, orphaned };
}
