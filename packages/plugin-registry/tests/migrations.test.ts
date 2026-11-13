import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDomainDatabase, migrateDomainDatabase, type TsukaimaDatabase } from "@tsukaima/db";
import { MigrationRegistry, MigrationRegistryError } from "../src/migrations.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function createRegistry(): Promise<{
	database: TsukaimaDatabase;
	registry: MigrationRegistry;
}> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-migrations-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return { database, registry: new MigrationRegistry({ database }) };
}

const migrations = [
	{
		rollbackSql: "DROP TABLE plugin_demo_items;",
		sql: "CREATE TABLE plugin_demo_items (id text primary key, name text);",
		version: "1.0.0",
	},
	{
		rollbackSql: "ALTER TABLE plugin_demo_items DROP COLUMN note;",
		sql: "ALTER TABLE plugin_demo_items ADD COLUMN note text;",
		version: "1.1.0",
	},
];

describe("plugin migration registry", () => {
	test("orders versions, supports dry-run, and records checksums", async () => {
		const { database, registry } = await createRegistry();
		const dry = await registry.run("demo", migrations.toReversed(), { dryRun: true });
		expect(dry.pending).toEqual(["1.0.0", "1.1.0"]);
		expect(await registry.list("demo")).toEqual([]);
		expect(
			(
				database as unknown as { $client: { query: (sql: string) => { all: () => unknown[] } } }
			).$client
				.query("SELECT name FROM sqlite_master WHERE name='plugin_demo_items'")
				.all(),
		).toEqual([]);

		const result = await registry.run("demo", migrations);
		expect(result.applied.map((migration) => migration.version)).toEqual(["1.0.0", "1.1.0"]);
		expect(result.applied[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
		const records = await registry.list("demo");
		expect(records.map((record) => record.version)).toEqual(["1.0.0", "1.1.0"]);
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
					sql: "CREATE TABLE plugin_demo_early (id text);",
					version: "0.9.0",
				},
			]),
		).rejects.toThrow("older than applied");

		await expect(
			registry.run("demo", [
				{ ...migrations[1]!, sql: "ALTER TABLE plugin_demo_items ADD COLUMN changed text;" },
			]),
		).rejects.toThrow("checksum drifted");
	});

	test("rejects un-namespaced SQL and executes the rollback plan", async () => {
		const { registry } = await createRegistry();
		await expect(
			registry.run("demo", [{ sql: "CREATE TABLE messages_copy (id text);", version: "1.0.0" }]),
		).rejects.toThrow("must start with plugin_demo_");
		await expect(
			registry.run("demo", [{ sql: "DELETE FROM main.users;", version: "1.0.0" }]),
		).rejects.toThrow("may only reference plugin_demo_* objects");
		await expect(
			registry.run("demo", [
				{
					sql: "CREATE TABLE plugin_demo_ref (id text REFERENCES users(id));",
					version: "1.0.0",
				},
			]),
		).rejects.toThrow("may only reference plugin_demo_* objects");

		await registry.run("demo", migrations);
		expect(await registry.rollbackPlugin("demo", { dryRun: true })).toEqual(["1.1.0", "1.0.0"]);
		expect(await registry.rollbackPlugin("demo")).toEqual(["1.1.0", "1.0.0"]);
		expect(await registry.list("demo")).toEqual([]);
	});
});
