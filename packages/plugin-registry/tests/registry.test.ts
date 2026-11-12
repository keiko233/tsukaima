import { describe, expect, test } from "bun:test";
import { createPluginContext, pluginManifestSchema, PluginRuntime } from "@tsukaima/sdk";
import { PluginRegistry, PluginRegistryError } from "../src/index.ts";
import { LocalPluginWorker } from "../src/worker.ts";

const manifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configSchema: {
		properties: { interval: { type: "number" } },
		required: ["interval"],
		type: "object",
	},
	kind: "third-party",
	name: "validated",
	permissions: [],
	version: "0.1.0",
});

describe("plugin config validation", () => {
	test("accepts valid config and rejects invalid config", () => {
		const registry = new PluginRegistry();
		expect(registry.install(manifest, { config: { interval: 10 } }).config).toEqual({
			interval: 10,
		});
		expect(() => registry.install(manifest, { config: {} })).toThrow(PluginRegistryError);
		expect(() => registry.install(manifest, { config: { interval: "10" } })).toThrow(
			PluginRegistryError,
		);
	});
});

describe("plugin worker lifecycle", () => {
	test("prevents concurrent start and restart after stop", async () => {
		const toolManifest = pluginManifestSchema.parse({ ...manifest, name: "worker" });
		const context = createPluginContext({ manifest: toolManifest, pluginId: "worker" });
		const runtime = new PluginRuntime({ context, plugin: { manifest: toolManifest, setup() {} } });
		const worker = new LocalPluginWorker(runtime);
		const first = worker.start();
		await expect(worker.start()).rejects.toThrow("already starting");
		await first;
		await worker.stop();
		await worker.start();
		await worker.stop();
	});
});
