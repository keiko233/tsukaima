import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

const baseManifest = {
	apiVersion: "1",
	kind: "third-party" as const,
	migrations: { directory: "migrations" },
	name: "runtime-plugin",
	permissions: ["storage.global", "tasks.create", "tasks.get", "tasks.list"],
	version: "1.0.0",
};

async function createLifecycle() {
	const directory = await mkdtemp(join(tmpdir(), "elaina-plugin-host-lifecycle-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{ ELAINA_DATA_DIR: directory, ELAINA_PORT: "7420" },
		{ plugins: [] },
	);
	await lifecycle.start();
	return lifecycle;
}

describe("plugin host lifecycle", () => {
	test("installs a migrated plugin, exposes scoped storage/db/tasks, upgrades, and uninstalls", async () => {
		const lifecycle = await createLifecycle();
		try {
			const installed = await lifecycle.pluginHost.install(baseManifest, {
				migrations: [
					{
						rollbackSql: "DROP TABLE plugin_runtime_plugin_items;",
						sql: "CREATE TABLE plugin_runtime_plugin_items (id text primary key);",
						version: "1.0.0",
					},
				],
			});
			expect(installed).toEqual(
				expect.objectContaining({ id: "runtime-plugin", version: "1.0.0" }),
			);
			const context = lifecycle.pluginHost.context("runtime-plugin");
			expect(context?.database?.prefix).toBe("plugin_runtime_plugin_");
			await context?.database?.exec("INSERT INTO plugin_runtime_plugin_items (id) VALUES ('one')");
			expect(await context?.database?.query("SELECT id FROM plugin_runtime_plugin_items")).toEqual([
				{ id: "one" },
			]);
			await context?.database?.exec("CREATE TABLE messages_copy (id text)");
			const tables = await context?.database?.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_copy'",
			);
			expect(tables?.map((table) => table.name)).toEqual(["messages_copy"]);
			await expect(
				context?.database?.exec("ATTACH DATABASE '/tmp/escape.sqlite' AS escape"),
			).rejects.toThrow("may not attach or detach");

			const task = await context?.tasks?.create({ kind: "runtime-test" });
			if (task === undefined) throw new Error("task not created");
			expect(task.pluginId).toBe("runtime-plugin");
			expect((await context?.tasks?.list())?.map((item) => item.id)).toEqual([task.id]);

			const upgraded = await lifecycle.pluginHost.upgrade(
				"runtime-plugin",
				{ ...baseManifest, version: "2.0.0" },
				{
					migrations: [
						{
							rollbackSql: "ALTER TABLE plugin_runtime_plugin_items DROP COLUMN note;",
							sql: "ALTER TABLE plugin_runtime_plugin_items ADD COLUMN note text;",
							version: "2.0.0",
						},
					],
				},
			);
			expect(upgraded.version).toBe("2.0.0");
			expect(lifecycle.pluginHost.context("runtime-plugin")?.manifest.version).toBe("2.0.0");

			expect(await lifecycle.pluginHost.uninstall("runtime-plugin", { retainData: false })).toBe(
				true,
			);
			expect(lifecycle.pluginHost.context("runtime-plugin")).toBeUndefined();
			expect((await lifecycle.pluginHost.list()).map((plugin) => plugin.id)).toEqual([]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("quarantines a plugin after repeated prepare failures and skips auto-start", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.pluginHost.install(baseManifest, { migrations: [] });
			await lifecycle.pluginHost.recordPluginFailure("runtime-plugin", "prepare failed");
			await lifecycle.pluginHost.recordPluginFailure("runtime-plugin", "prepare failed");
			await lifecycle.pluginHost.recordPluginFailure("runtime-plugin", "prepare failed");
			const row = (await lifecycle.pluginHost.list()).find(
				(plugin) => plugin.id === "runtime-plugin",
			);
			expect(row?.lifecycle).toEqual(
				expect.objectContaining({
					failureCount: 3,
					quarantineReason: "prepare failed",
				}),
			);
			expect(row?.lifecycle?.quarantinedAt).not.toBeNull();
			const recovered = await lifecycle.pluginHost.recover("runtime-plugin");
			expect(recovered.lifecycle).toEqual(
				expect.objectContaining({ failureCount: 0, quarantinedAt: null }),
			);
		} finally {
			await lifecycle.stop();
		}
	});
});
