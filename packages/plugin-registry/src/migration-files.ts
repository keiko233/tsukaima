import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PluginMigrationsDeclaration } from "@elaina/sdk/manifest";
import {
	MigrationRegistryError,
	compareMigrationVersions,
	type PluginMigration,
} from "./migrations.ts";

export type { PluginMigrationsDeclaration };

const MIGRATION_FILE = /^([0-9A-Za-z][0-9A-Za-z.-]*)_(.+)\.sql$/u;
const DOWN_SUFFIX = ".down.sql";

interface MigrationFile {
	readonly file: string;
	readonly version: string;
}

function isDownFile(file: string): boolean {
	return file.endsWith(DOWN_SUFFIX);
}

function parseMigrationFile(file: string, directory: string): MigrationFile {
	const match = MIGRATION_FILE.exec(file);
	if (match === null) {
		throw new MigrationRegistryError(
			`Migration file ${file} in ${directory} must be named <version>_<name>.sql`,
		);
	}
	return { file, version: match[1] as string };
}

/**
 * Load `<version>_<name>.sql` files from a plugin migration directory.
 *
 * A file `0001_create_items.sql` has version `0001`; an optional `0001_create_items.down.sql`
 * next to it is its rollback plan. Versions are compared numerically, so `0010` runs after
 * `0009`. Hidden files and non-SQL files are ignored.
 */
export async function loadPluginMigrations(
	pluginRoot: string,
	declaration: PluginMigrationsDeclaration,
): Promise<readonly PluginMigration[]> {
	const root = resolve(pluginRoot);
	const directory = resolve(root, declaration.directory);
	const inside = relative(root, directory);
	if (inside.startsWith("..") || isAbsolute(inside)) {
		throw new MigrationRegistryError(
			`Plugin migrations directory ${declaration.directory} must stay inside ${pluginRoot}`,
		);
	}

	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		throw new MigrationRegistryError(`Cannot read plugin migrations in ${directory}`, {
			cause: error,
		});
	}

	const files = entries
		.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.filter((name) => name.endsWith(".sql") && !isDownFile(name))
		.map((name) => parseMigrationFile(name, directory))
		.toSorted((left, right) => compareMigrationVersions(left.version, right.version));

	const seen = new Set<string>();
	const migrations: PluginMigration[] = [];
	for (const migration of files) {
		if (seen.has(migration.version)) {
			throw new MigrationRegistryError(
				`Plugin migrations in ${directory} declare version ${migration.version} more than once`,
			);
		}
		seen.add(migration.version);
		const sql = await readFile(resolve(directory, migration.file), "utf8");
		if (sql.trim().length === 0) {
			throw new MigrationRegistryError(`Migration file ${migration.file} is empty`);
		}
		const rollbackFile = `${migration.file.slice(0, -".sql".length)}${DOWN_SUFFIX}`;
		const rollbackSql = entries.some((entry) => entry.isFile() && entry.name === rollbackFile)
			? await readFile(resolve(directory, rollbackFile), "utf8")
			: undefined;
		if (rollbackSql !== undefined && rollbackSql.trim().length === 0) {
			throw new MigrationRegistryError(`Migration rollback file ${rollbackFile} is empty`);
		}
		migrations.push({
			sql,
			version: migration.version,
			...(rollbackSql === undefined ? {} : { rollbackSql }),
		});
	}
	return migrations;
}
