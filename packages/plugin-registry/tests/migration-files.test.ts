import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginMigrations } from "../src/migration-files.ts";
import { MigrationRegistryError } from "../src/migrations.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function pluginRoot(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-migration-files-"));
	directories.push(root);
	await mkdir(join(root, "migrations"), { recursive: true });
	for (const [name, sql] of Object.entries(files)) {
		await writeFile(join(root, "migrations", name), sql);
	}
	return root;
}

describe("plugin migration files", () => {
	test("loads numeric-ordered up and down files and ignores unrelated files", async () => {
		const root = await pluginRoot({
			"0002_items.sql": "CREATE TABLE items (id text);",
			"0002_items.down.sql": "DROP TABLE items;",
			"0010_more.sql": "CREATE TABLE more (id text);",
			"README.md": "not sql",
		});
		// create in a second pass so the first file is not accidentally the sort winner
		await writeFile(join(root, "migrations", "0001_packs.sql"), "CREATE TABLE packs (id text);");

		const migrations = await loadPluginMigrations(root, { directory: "migrations" });
		expect(migrations.map((migration) => migration.version)).toEqual(["0001", "0002", "0010"]);
		expect(migrations[1]).toEqual(
			expect.objectContaining({
				rollbackSql: "DROP TABLE items;",
				sql: "CREATE TABLE items (id text);",
			}),
		);
		expect(migrations[0]?.rollbackSql).toBeUndefined();
	});

	test("rejects malformed names, duplicate versions, empty files, and traversal", async () => {
		const malformed = await pluginRoot({ "init.sql": "CREATE TABLE items (id text);" });
		await expect(
			loadPluginMigrations(malformed, { directory: "migrations" }),
		).rejects.toBeInstanceOf(MigrationRegistryError);

		const duplicate = await pluginRoot({
			"0001_a.sql": "CREATE TABLE a (id text);",
			"0001_b.sql": "CREATE TABLE b (id text);",
		});
		await expect(loadPluginMigrations(duplicate, { directory: "migrations" })).rejects.toThrow(
			"more than once",
		);

		const empty = await pluginRoot({ "0001_a.sql": "   \n" });
		await expect(loadPluginMigrations(empty, { directory: "migrations" })).rejects.toThrow("empty");

		const outside = await pluginRoot({ "0001_a.sql": "CREATE TABLE a (id text);" });
		await expect(loadPluginMigrations(outside, { directory: "../elsewhere" })).rejects.toThrow(
			"must stay inside",
		);
	});

	test("reports a missing migrations directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "tsukaima-migration-missing-"));
		directories.push(root);
		await expect(loadPluginMigrations(root, { directory: "migrations" })).rejects.toThrow(
			"Cannot read plugin migrations",
		);
	});
});
