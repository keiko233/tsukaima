import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginManifestSchema } from "@tsukaima/sdk";
import { createPluginContext, PluginRuntime } from "@tsukaima/sdk";
import { PluginRegistry, PluginRegistryError } from "./registry.ts";
import { LocalPluginWorker } from "./worker.ts";

const manifest = pluginManifestSchema.parse({
	apiVersion: "1",
	kind: "third-party",
	name: "sample",
	version: "0.1.0",
	permissions: ["conversation.read"],
});

const toolManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	kind: "third-party",
	name: "sample",
	version: "0.1.0",
	permissions: ["conversation.read"],
	tools: [
		{
			description: "Echo",
			name: "sample.echo",
			parameters: {},
			requiredPermissions: ["conversation.read"],
		},
	],
});

function createRuntime() {
	const context = createPluginContext({
		grantedPermissions: ["conversation.read"],
		manifest: toolManifest,
		pluginId: "sample",
	});
	const plugin = { manifest: toolManifest, setup() {} };
	return { context, runtime: new PluginRuntime({ context, plugin }) };
}

describe("plugin registry", () => {
	test("loads manifest files and rejects malformed JSON", async () => {
		const registry = new PluginRegistry();
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-"));
		const manifestPath = join(directory, "tsukaima.plugin.json");
		const badManifestPath = join(directory, "bad.plugin.json");
		try {
			await writeFile(manifestPath, JSON.stringify(manifest));
			await writeFile(badManifestPath, "{");
			expect(await registry.loadManifestFile(manifestPath)).toEqual(manifest);
			await expect(registry.loadManifestFile(badManifestPath)).rejects.toThrow(PluginRegistryError);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("installs, lists, and uninstalls plugins", () => {
		const registry = new PluginRegistry();
		const installed = registry.install(manifest, { grantedPermissions: ["conversation.read"] });
		expect(installed.runMode).toBe("worker");
		expect(registry.size).toBe(1);
		expect(registry.get("sample")).toBe(installed);
		expect(() => registry.install(manifest)).toThrow(PluginRegistryError);
		registry.uninstall("sample");
		expect(registry.size).toBe(0);
		expect(() => registry.uninstall("sample")).toThrow(PluginRegistryError);
	});

	test("rejects grants outside the declared manifest permissions", () => {
		const registry = new PluginRegistry();
		expect(() => registry.install(manifest, { grantedPermissions: ["channel.send"] })).toThrow(
			PluginRegistryError,
		);
	});

	test("worker delegates tools and hooks only while started", async () => {
		const { context, runtime } = createRuntime();
		context.tools.register({
			description: "Echo",
			name: "sample.echo",
			parameters: {},
			requiredPermissions: ["conversation.read"],
			execute: () => ({ content: [{ text: "ok", type: "text" as const }] }),
		});
		const worker = new LocalPluginWorker(runtime);
		expect(() => worker.listTools()).toThrow(PluginRegistryError);
		await worker.start();
		expect(worker.listTools()).toHaveLength(1);
		expect(await worker.invokeTool("sample.echo", {})).toEqual({
			ok: true,
			result: { content: [{ text: "ok", type: "text" }] },
		});
		await worker.stop();
		expect(() => worker.listTools()).toThrow(PluginRegistryError);
	});
});
