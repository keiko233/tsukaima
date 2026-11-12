import { describe, expect, test } from "bun:test";
import {
	LocalToolBridge,
	LocalUiBridge,
	createPluginContext,
	createPluginToolsExtension,
	providerSafeToolName,
} from "./bridges.ts";
import { pluginManifestSchema } from "./manifest.ts";
import { PermissionDeniedError, hasPermission, permissionMatches } from "./permissions.ts";
import { PluginRuntime } from "./runtime.ts";
import type { AuditEntry } from "./host.ts";
import type { PluginTool } from "./types.ts";

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

	test("adapts plugin tools to durable registrations with audit", async () => {
		const audits: AuditEntry[] = [];
		const invocations: Array<{
			readonly context: unknown;
			readonly input: Record<string, unknown>;
			readonly name: string;
		}> = [];
		const tool: PluginTool = {
			description: "Echo text",
			execute: () => ({ content: [{ text: "unused", type: "text" }] }),
			name: "sample.echo",
			parameters: {
				properties: { text: { type: "string" } },
				required: ["text"],
				type: "object",
			},
			requiredPermissions: ["conversation.read"],
		};
		const extension = createPluginToolsExtension(
			() => [tool],
			async (name, input, context) => {
				invocations.push({ context, input, name });
				return {
					ok: true,
					result: { content: [{ text: `echo:${String(input.text)}`, type: "text" }] },
				};
			},
			{
				audit: (entry) => {
					audits.push(entry);
				},
			},
		);

		const registration = extension.tools[0];
		expect(registration).toBeDefined();
		expect(registration?.name).toBe(providerSafeToolName("sample.echo"));
		expect(registration?.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
		expect(registration?.description).toBe("Echo text");
		expect(registration?.parameters).toEqual(tool.parameters);

		const result = await registration?.execute({ text: "ping" }, { conversationId: 42 }, {});
		expect(result).toEqual({ output: [{ text: "echo:ping", type: "text" }] });
		expect(invocations).toEqual([
			{
				context: { conversationId: "42" },
				input: { text: "ping" },
				name: "sample.echo",
			},
		]);
		expect(audits).toEqual([
			expect.objectContaining({
				action: "plugin.tool.invoke",
				result: "ok",
				targetId: "sample.echo",
				targetKind: "plugin-tool",
			}),
		]);
	});

	test("turns permission denial and execution failures into tool errors", async () => {
		const audits: AuditEntry[] = [];
		const tool: PluginTool = {
			description: "Denied",
			execute: () => ({ content: [] }),
			name: "sample.denied",
			parameters: { type: "object" },
			requiredPermissions: ["conversation.read"],
		};
		const extension = createPluginToolsExtension(
			() => [tool],
			async () => ({
				ok: false,
				permission: "conversation.read",
				reason: "permission_denied",
			}),
			{
				audit: (entry) => {
					audits.push(entry);
				},
			},
		);
		const denied = await extension.tools[0]?.execute({}, { conversationId: 1 }, {});
		expect(denied?.isError).toBe(true);
		expect(denied?.output[0]?.text).toContain("Permission denied");
		expect(audits.at(-1)).toEqual(
			expect.objectContaining({ reason: "permission_denied:conversation.read", result: "denied" }),
		);

		const failing = createPluginToolsExtension(
			() => [tool],
			async () => {
				throw new Error("plugin exploded");
			},
			{
				audit: (entry) => {
					audits.push(entry);
				},
			},
		);
		const failed = await failing.tools[0]?.execute({}, { conversationId: 1 }, {});
		expect(failed?.isError).toBe(true);
		expect(failed?.output[0]?.text).toContain("plugin exploded");
		expect(audits.at(-1)).toEqual(
			expect.objectContaining({ reason: "plugin exploded", result: "failed" }),
		);
	});

	test("keeps tool results intact when auditing fails", async () => {
		const warnings: unknown[] = [];
		const tool: PluginTool = {
			description: "Echo",
			execute: () => ({ content: [] }),
			name: "sample.echo",
			parameters: { type: "object" },
			requiredPermissions: [],
		};
		const extension = createPluginToolsExtension(
			() => [tool],
			async () => ({ ok: true, result: { content: [{ text: "still here", type: "text" }] } }),
			{
				audit: () => {
					throw new Error("audit unavailable");
				},
				logger: (message, error) => {
					warnings.push({ error, message });
					throw new Error("logger unavailable");
				},
			},
		);
		const result = await extension.tools[0]?.execute({}, { conversationId: 1 }, {});
		expect(result).toEqual({ output: [{ text: "still here", type: "text" }] });
		expect(warnings).toHaveLength(1);
	});

	test("degrades to no tools when the registry cannot be listed", () => {
		const extension = createPluginToolsExtension(
			() => {
				throw new Error("registry unavailable");
			},
			async () => ({ ok: true, result: { content: [] } }),
		);
		expect(extension.tools).toEqual([]);
	});
});
