import { describe, expect, test } from "bun:test";
import { createPluginContext, pluginManifestSchema, PluginRuntime } from "@elaina/sdk";
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

describe("union and enum config schemas", () => {
	const unionManifest = pluginManifestSchema.parse({
		apiVersion: "1",
		configSchema: {
			properties: {
				mode: { enum: ["forward", "reverse"], type: "string" },
				pttToText: {
					anyOf: [
						{ type: "boolean" },
						{
							properties: { timeoutMs: { type: "number" } },
							type: "object",
						},
					],
				},
			},
			type: "object",
		},
		kind: "builtin",
		name: "union-config",
		permissions: [],
		version: "0.1.0",
	});

	test("accepts every branch of a union and rejects values outside it", () => {
		expect(
			new PluginRegistry().install(unionManifest, {
				config: { mode: "reverse", pttToText: false },
			}).config,
		).toEqual({ mode: "reverse", pttToText: false });
		expect(
			new PluginRegistry().install(unionManifest, { config: { pttToText: { timeoutMs: 500 } } })
				.config,
		).toEqual({ pttToText: { timeoutMs: 500 } });
		expect(() =>
			new PluginRegistry().install(unionManifest, { config: { pttToText: "yes" } }),
		).toThrow(PluginRegistryError);
	});

	test("rejects an enum value that is not listed", () => {
		const registry = new PluginRegistry();
		expect(() => registry.install(unionManifest, { config: { mode: "sideways" } })).toThrow(
			PluginRegistryError,
		);
	});
});
