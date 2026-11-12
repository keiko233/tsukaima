import { describe, expect, test } from "bun:test";
import { LocalToolBridge, LocalUiBridge, createPluginContext } from "./bridges.ts";
import { pluginManifestSchema } from "./manifest.ts";
import { PermissionDeniedError, hasPermission, permissionMatches } from "./permissions.ts";
import { PluginRuntime } from "./runtime.ts";

const manifest = pluginManifestSchema.parse({
	apiVersion: "1",
	kind: "third-party",
	name: "sample",
	version: "0.1.0",
	permissions: ["conversation.read", "channel.send"],
	tools: [
		{
			description: "Echo",
			name: "sample.echo",
			parameters: {},
			requiredPermissions: ["conversation.read"],
		},
	],
});

describe("plugin sdk", () => {
	test("validates and normalizes manifests", () => {
		expect(manifest.permissions).toEqual(["conversation.read", "channel.send"]);
		expect(() => pluginManifestSchema.parse({ ...manifest, name: "Invalid_Plugin" })).toThrow();
		expect(() =>
			pluginManifestSchema.parse({ ...manifest, permissions: ["conversation.read.<*>"] }),
		).toThrow();
	});

	test("supports wildcard permission matching", () => {
		expect(permissionMatches("conversation.*", "conversation.read")).toBe(true);
		expect(hasPermission(["*"], "channel.send")).toBe(true);
		expect(hasPermission(["conversation.read"], "channel.send")).toBe(false);
	});

	test("registers namespaced tools and denies missing permissions", async () => {
		const context = createPluginContext({ manifest, pluginId: "sample" });
		const executed: string[] = [];
		context.tools.register({
			description: "Echo",
			name: "sample.echo",
			parameters: {},
			requiredPermissions: ["conversation.read"],
			execute: () => {
				executed.push("echo");
				return { content: [{ text: "ok", type: "text" as const }] };
			},
		});
		expect(context.tools.list()).toHaveLength(1);
		const allowed = await context.tools.invoke("sample.echo", {});
		expect(allowed).toEqual({ ok: true, result: { content: [{ text: "ok", type: "text" }] } });
		expect(executed).toEqual(["echo"]);

		const deniedBridge = new LocalToolBridge("sample", []);
		expect(() =>
			deniedBridge.register({
				description: "Echo",
				name: "sample.echo",
				parameters: {},
				requiredPermissions: ["conversation.read"],
				execute: () => ({ content: [{ text: "ok", type: "text" as const }] }),
			}),
		).toThrow(PermissionDeniedError);
	});

	test("emits hooks through the runtime host bridge", async () => {
		const context = createPluginContext({ manifest, pluginId: "sample" });
		const payloads: unknown[] = [];
		context.events.on("message.received", (payload) => {
			payloads.push(payload);
		});
		const plugin = { manifest, setup() {} };
		const runtime = new PluginRuntime({ context, plugin });
		const bridge = runtime.hostBridge();
		await expect(bridge.emitHook("message.received", { id: "m1" })).rejects.toThrow(
			"Plugin sample is not started",
		);
		await runtime.start();
		await bridge.emitHook("message.received", { id: "m1" });
		await runtime.stop();
		expect(payloads).toEqual([{ id: "m1" }]);
	});

	test("registers UI declarations", () => {
		const ui = new LocalUiBridge();
		const definition = {
			component: "ReviewPanel",
			data: {},
			id: "sample.review",
			kind: "panel" as const,
			title: "Review",
		};
		ui.register(definition);
		expect(ui.list()).toEqual([definition]);
	});
});
