import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginManifestSchema } from "@elaina/sdk";
import { PluginDatabaseStore } from "../src/plugin-database.ts";
import { MigrationRegistry } from "../src/migrations.ts";
import { PluginLifecycleError, PluginLifecycleManager } from "../src/lifecycle.ts";
import { PluginRegistry } from "../src/registry.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

const manifest = (version: string) =>
	pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "third-party",
		migrations: { directory: "migrations" },
		name: "lifecycle",
		permissions: ["storage.global"],
		version,
	});

async function setup(options: { maxFailures?: number } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "elaina-plugin-lifecycle-"));
	directories.push(directory);
	const databases = new PluginDatabaseStore({ directory: join(directory, "plugins") });
	let config: Record<string, unknown> = {};
	let storage: unknown = [{ key: "seed", valueJson: "{}" }];
	const calls = { clear: 0, import: 0, start: 0, stop: 0 };
	const manager = new PluginLifecycleManager({
		...(options.maxFailures === undefined ? {} : { maxFailures: options.maxFailures }),
		migrations: new MigrationRegistry({ databases }),
		registry: new PluginRegistry(),
		hooks: {
			clearStorage: async () => {
				calls.clear += 1;
			},
			exportStorage: async () => storage,
			importStorage: async (_pluginId, value) => {
				calls.import += 1;
				storage = value;
			},
			readConfig: async () => config,
			start: async () => {
				calls.start += 1;
			},
			stop: async () => {
				calls.stop += 1;
			},
			writeConfig: async (_pluginId, value) => {
				config = value;
			},
		},
	});
	return {
		calls,
		databases,
		getConfig: () => config,
		getStorage: () => storage,
		manager,
		setConfig: (value: Record<string, unknown>) => {
			config = value;
		},
		setStorage: (value: unknown) => {
			storage = value;
		},
	};
}

describe("plugin lifecycle manager", () => {
	test("backs up config/storage before an upgrade and restores them on migration failure", async () => {
		const context = await setup();
		await context.manager.install(manifest("1.0.0"), {
			migrations: [
				{
					rollbackSql: "DROP TABLE plugin_lifecycle_items;",
					sql: "CREATE TABLE plugin_lifecycle_items (id text primary key);",
					version: "1.0.0",
				},
			],
		});
		context.setConfig({ endpoint: "ws://old" });
		context.setStorage([{ key: "old", valueJson: "{}" }]);

		await expect(
			context.manager.upgrade("lifecycle", manifest("2.0.0"), {
				migrations: [
					{
						sql: "CREATE TABLE plugin_lifecycle_items (id text primary key);",
						version: "2.0.0",
					},
				],
			}),
		).rejects.toThrow();
		expect(context.manager.registry.get("lifecycle")?.manifest.version).toBe("1.0.0");
		expect(context.getConfig()).toEqual({ endpoint: "ws://old" });
		expect(context.getStorage()).toEqual([{ key: "old", valueJson: "{}" }]);
		expect(context.calls.import).toBe(1);
		expect(context.calls.start).toBeGreaterThan(0);

		await context.manager.upgrade("lifecycle", manifest("2.0.0"), {
			migrations: [
				{
					rollbackSql: "ALTER TABLE plugin_lifecycle_items DROP COLUMN note;",
					sql: "ALTER TABLE plugin_lifecycle_items ADD COLUMN note text;",
					version: "2.0.0",
				},
			],
		});
		expect(context.manager.registry.get("lifecycle")?.manifest.version).toBe("2.0.0");
	});

	test("quarantines repeated failures until explicit recovery", async () => {
		const context = await setup({ maxFailures: 2 });
		await context.manager.install(manifest("1.0.0"), { migrations: [] });
		context.manager.recordFailure("lifecycle", "setup failed");
		expect(context.manager.isQuarantined("lifecycle")).toBe(false);
		context.manager.recordFailure("lifecycle", "setup failed again");
		expect(context.manager.isQuarantined("lifecycle")).toBe(true);
		await expect(context.manager.reload("lifecycle")).rejects.toBeInstanceOf(PluginLifecycleError);
		await context.manager.recover("lifecycle");
		expect(context.manager.isQuarantined("lifecycle")).toBe(false);
		expect(context.manager.state("lifecycle")?.failureCount).toBe(0);
	});

	test("uninstall retains or removes data according to the retention flag", async () => {
		const context = await setup();
		await context.manager.install(manifest("1.0.0"), { migrations: [] });
		await context.manager.uninstall("lifecycle", { retainData: true });
		expect(context.calls.clear).toBe(0);
		expect(context.manager.registry.get("lifecycle")).toBeUndefined();

		await context.manager.install(manifest("1.0.0"), { migrations: [] });
		await context.manager.uninstall("lifecycle", { retainData: false });
		expect(context.calls.clear).toBe(1);
	});
});
