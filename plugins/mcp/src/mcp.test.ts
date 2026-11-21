import { describe, expect, test } from "bun:test";
import { mcpServerSnapshotSchema, type McpServerSnapshot } from "@tsukaima/contracts";
import { createPluginContext, LocalStorageBridge, type PluginContext } from "@tsukaima/sdk";
import { mcpPlugin } from "./index.ts";
import { mcpManifest } from "./manifest.ts";

const FIXTURE = new URL("./fixtures/mcp-stdio-server.ts", import.meta.url).pathname;
const SERVER_ID = "synthetic-mcp";

function makeContext(storage = new LocalStorageBridge()): PluginContext {
	return createPluginContext({
		grantedPermissions: mcpManifest.permissions,
		manifest: mcpManifest,
		pluginId: "mcp",
		storage,
	});
}

function rpc(context: PluginContext, method: string, input?: unknown): Promise<unknown> {
	return (
		context.rpc as unknown as {
			invoke(method: string, input?: unknown): Promise<unknown>;
		}
	).invoke(method, input);
}

function parseSnapshot(value: unknown): McpServerSnapshot {
	return mcpServerSnapshotSchema.parse(value);
}

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		deferred: true,
		enabled: true,
		id: SERVER_ID,
		name: "Synthetic MCP",
		surface: "both",
		timeoutMs: 5_000,
		transport: {
			args: [FIXTURE],
			command: process.execPath,
			type: "stdio",
		},
		...overrides,
	};
}

async function listServers(context: PluginContext): Promise<McpServerSnapshot[]> {
	const result = (await rpc(context, "mcp.list")) as {
		servers?: readonly unknown[];
	};
	return (result.servers ?? []).map(parseSnapshot);
}

describe("mcp plugin", () => {
	test("connects, registers discovered tools, and returns text and image content", async () => {
		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			const created = parseSnapshot(await rpc(context, "mcp.create", createInput()));
			expect(created.state).toBe("connected");
			expect(created.tools.map((tool) => tool.name)).toEqual(["echo", "picture", "slow", "fail"]);
			expect(context.tools.list().map((tool) => tool.name)).toEqual([
				"mcp.synthetic-mcp.echo",
				"mcp.synthetic-mcp.picture",
				"mcp.synthetic-mcp.slow",
				"mcp.synthetic-mcp.fail",
			]);

			const text = await context.tools.invoke("mcp.synthetic-mcp.echo", {
				text: "synthetic ping",
			});
			expect(text.ok).toBe(true);
			if (!text.ok) throw new Error("expected text result");
			expect(text.result.content).toEqual([{ text: "synthetic ping", type: "text" }]);

			const image = await context.tools.invoke("mcp.synthetic-mcp.picture", {});
			expect(image.ok).toBe(true);
			if (!image.ok) throw new Error("expected image result");
			expect(image.result.images?.[0]?.mimeType).toBe("image/png");
			expect((image.result.images?.[0]?.data.length ?? 0) > 0).toBe(true);

			await expect(context.tools.invoke("mcp.synthetic-mcp.fail", {})).rejects.toThrow(
				"synthetic tool failure",
			);
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("persists masked config and restores it in a new plugin instance", async () => {
		const storage = new LocalStorageBridge();
		const secret = "synthetic-secret-value";
		const first = makeContext(storage);
		await mcpPlugin.setup(first);
		try {
			const created = parseSnapshot(
				await rpc(
					first,
					"mcp.create",
					createInput({
						transport: {
							args: [FIXTURE],
							command: process.execPath,
							env: { MCP_SYNTHETIC_SECRET: secret },
							type: "stdio",
						},
					}),
				),
			);
			expect(created.secretKeys).toEqual(["env:MCP_SYNTHETIC_SECRET"]);
			expect(JSON.stringify(await listServers(first))).not.toContain(secret);
			expect(JSON.stringify(created)).not.toContain(secret);
		} finally {
			await mcpPlugin.teardown?.(first);
		}

		const second = makeContext(storage);
		await mcpPlugin.setup(second);
		try {
			const restored = await listServers(second);
			expect(restored).toHaveLength(1);
			expect(restored[0]?.id).toBe(SERVER_ID);
			expect(restored[0]?.state).toBe("connected");
			expect(JSON.stringify(restored)).not.toContain(secret);
			expect(second.tools.list()).toHaveLength(4);
		} finally {
			await mcpPlugin.teardown?.(second);
		}
	});

	test("toggles and reconnects without leaving stale tools registered", async () => {
		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			await rpc(context, "mcp.create", createInput());
			await rpc(context, "mcp.toggle", { enabled: false, id: SERVER_ID });
			expect(context.tools.list()).toEqual([]);
			const disabled = (await listServers(context))[0];
			expect(disabled?.state).toBe("disconnected");

			const enabled = parseSnapshot(
				await rpc(context, "mcp.toggle", { enabled: true, id: SERVER_ID }),
			);
			expect(enabled.state).toBe("connected");
			expect(context.tools.list()).toHaveLength(4);

			const reconnected = parseSnapshot(await rpc(context, "mcp.reconnect", { id: SERVER_ID }));
			expect(reconnected.state).toBe("connected");
			expect(context.tools.list()).toHaveLength(4);

			await rpc(context, "mcp.update", {
				disabledTools: ["picture"],
				id: SERVER_ID,
				name: "Synthetic MCP renamed",
			});
			expect(context.tools.list().map((tool) => tool.name)).not.toContain(
				"mcp.synthetic-mcp.picture",
			);

			await rpc(context, "mcp.delete", { id: SERVER_ID });
			expect(context.tools.list()).toEqual([]);
			expect(await listServers(context)).toEqual([]);
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("records a broken server without failing plugin setup", async () => {
		const context = makeContext();
		await expect(mcpPlugin.setup(context)).resolves.toBeUndefined();
		try {
			const broken = parseSnapshot(
				await rpc(
					context,
					"mcp.create",
					createInput({
						id: "synthetic-broken",
						name: "Synthetic broken MCP",
						timeoutMs: 2_000,
						transport: {
							args: [],
							command: "mcp-command-that-does-not-exist",
							type: "stdio",
						},
					}),
				),
			);
			expect(broken.state).toBe("error");
			expect(broken.tools).toEqual([]);
			expect(broken.lastError?.length).toBeGreaterThan(0);
			expect(context.tools.list()).toEqual([]);
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("enforces the per-server timeout", async () => {
		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			await rpc(context, "mcp.create", createInput({ timeoutMs: 300 }));
			await expect(context.tools.invoke("mcp.synthetic-mcp.slow", {})).rejects.toThrow("timed out");
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("rejects invalid RPC input", async () => {
		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			await expect(rpc(context, "mcp.create", { name: "Missing transport" })).rejects.toThrow();
			await expect(rpc(context, "mcp.delete", { id: "" })).rejects.toThrow();
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});
});
