import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyPluginTables } from "../src/legacy-plugin-data.ts";
import { MigrationRegistry, MigrationRegistryError } from "../src/migrations.ts";
import { PluginDatabaseStore, wrapPluginSqlConnection } from "../src/plugin-database.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function createRegistry(): Promise<{
	databases: PluginDatabaseStore;
	registry: MigrationRegistry;
}> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-migrations-"));
	directories.push(directory);
	const databases = new PluginDatabaseStore({ directory: join(directory, "plugins") });
	return { databases, registry: new MigrationRegistry({ databases }) };
}

const migrations = [
	{
		rollbackSql: "DROP TABLE demo_items;",
		sql: "CREATE TABLE demo_items (id text primary key, name text);",
		version: "1.0.0",
	},
	{
		rollbackSql: "ALTER TABLE demo_items DROP COLUMN note;",
		sql: "ALTER TABLE demo_items ADD COLUMN note text;",
		version: "1.1.0",
	},
];

describe("plugin migration registry", () => {
	test("orders versions, supports dry-run, and records checksums in the plugin database", async () => {
		const { databases, registry } = await createRegistry();
		const dry = await registry.run("demo", migrations.toReversed(), { dryRun: true });
		expect(dry.pending).toEqual(["1.0.0", "1.1.0"]);
		expect(await registry.list("demo")).toEqual([]);
		expect(
			(await databases.open("demo")).query(
				"SELECT name FROM sqlite_master WHERE name='demo_items'",
			),
		).toEqual([]);

		const result = await registry.run("demo", migrations);
		expect(result.applied.map((migration) => migration.version)).toEqual(["1.0.0", "1.1.0"]);
		expect(result.applied[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
		const records = await registry.list("demo");
		expect(records.map((record) => record.version)).toEqual(["1.0.0", "1.1.0"]);

		// The ledger lives with the plugin, not in the domain database.
		expect(databases.pathFor("demo")).toEndWith("demo.sqlite");
		expect(
			(await databases.open("demo")).query(
				"SELECT name FROM sqlite_master WHERE name='_tsukaima_plugin_migrations'",
			),
		).toHaveLength(1);
	});

	test("rejects duplicate, regressive, and checksum-drifted versions", async () => {
		const { registry } = await createRegistry();
		await expect(registry.run("demo", [migrations[0]!, migrations[0]!])).rejects.toBeInstanceOf(
			MigrationRegistryError,
		);

		await registry.run("demo", migrations);
		await expect(
			registry.run("demo", [
				{
					sql: "CREATE TABLE demo_early (id text);",
					version: "0.9.0",
				},
			]),
		).rejects.toThrow("older than applied");

		await expect(
			registry.run("demo", [
				{ ...migrations[1]!, sql: "ALTER TABLE demo_items ADD COLUMN changed text;" },
			]),
		).rejects.toThrow("checksum drifted");
	});

	test("rejects statements that escape the plugin database and executes rollbacks", async () => {
		const { registry } = await createRegistry();
		await expect(
			registry.run("demo", [
				{ sql: "ATTACH DATABASE '/tmp/other.sqlite' AS other;", version: "1.0.0" },
			]),
		).rejects.toThrow("may not attach or detach");
		await expect(
			registry.run("demo", [{ sql: "VACUUM INTO '/tmp/copy.sqlite';", version: "1.0.0" }]),
		).rejects.toThrow("may not write a database file");

		await registry.run("demo", migrations);
		expect(await registry.rollbackPlugin("demo", { dryRun: true })).toEqual(["1.1.0", "1.0.0"]);
		expect(await registry.rollbackPlugin("demo")).toEqual(["1.1.0", "1.0.0"]);
		expect(await registry.list("demo")).toEqual([]);
	});
});

describe("legacy plugin table import", () => {
	test("copies rows into the plugin database and drops the domain tables", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-legacy-plugin-"));
		directories.push(directory);
		const source = new Database(join(directory, "domain.sqlite"), { create: true });
		source.exec("PRAGMA foreign_keys = ON");
		source.exec(`
			CREATE TABLE plugin_demo_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE plugin_demo_items (
				id TEXT PRIMARY KEY,
				pack_id TEXT NOT NULL REFERENCES plugin_demo_packs(id),
				legacy_only TEXT
			);
			CREATE TABLE messages (id TEXT PRIMARY KEY);
			INSERT INTO plugin_demo_packs VALUES ('p1', 'Pack');
			INSERT INTO plugin_demo_items VALUES ('i1', 'p1', 'old');
			INSERT INTO messages VALUES ('m1');
		`);
		const databases = new PluginDatabaseStore({ directory: join(directory, "plugins") });
		const target = await databases.open("demo");
		target.exec(`
			CREATE TABLE plugin_demo_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE plugin_demo_items (id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, added TEXT NOT NULL DEFAULT 'new');
		`);

		const result = migrateLegacyPluginTables({
			pluginId: "demo",
			source: wrapPluginSqlConnection(source),
			target,
		});
		expect(result.dropped).toEqual(["plugin_demo_items", "plugin_demo_packs"]);
		expect(result.orphaned).toEqual([]);
		expect(result.imported.find((table) => table.table === "plugin_demo_items")?.columns).toEqual([
			"id",
			"pack_id",
		]);
		expect(target.query("SELECT * FROM plugin_demo_items")).toEqual([
			{ added: "new", id: "i1", pack_id: "p1" },
		]);
		expect(
			source
				.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_demo_%'")
				.all(),
		).toEqual([]);
		expect(source.query("SELECT * FROM messages").all()).toEqual([{ id: "m1" }]);
		source.close();
	});

	test("leaves legacy tables in place when the plugin has no target table", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-legacy-orphan-"));
		directories.push(directory);
		const source = new Database(join(directory, "domain.sqlite"), { create: true });
		source.exec("CREATE TABLE plugin_demo_old (id TEXT PRIMARY KEY);");
		const databases = new PluginDatabaseStore({ directory: join(directory, "plugins") });
		const target = await databases.open("demo");

		const result = migrateLegacyPluginTables({
			pluginId: "demo",
			source: wrapPluginSqlConnection(source),
			target,
		});
		expect(result.orphaned).toEqual(["plugin_demo_old"]);
		expect(
			source
				.query("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_demo_old'")
				.all(),
		).toHaveLength(1);
		source.close();
	});
});
