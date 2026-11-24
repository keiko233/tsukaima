import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mcpServerSnapshotSchema, type McpServerSnapshot } from "@tsukaima/contracts";
import {
	createPluginContext,
	LocalStorageBridge,
	type AuditEntry,
	type PluginContext,
} from "@tsukaima/sdk";
import {
	MCP_ADMIN_TOOL_NAMES,
	MCP_INSTALL_SERVER_MODEL_NAME,
	MCP_INSTALL_SERVER_TOOL,
	MCP_LIST_SERVERS_MODEL_NAME,
	MCP_LIST_SERVERS_TOOL,
	MCP_RECONNECT_SERVER_TOOL,
	MCP_REMOVE_SERVER_TOOL,
	MCP_TOGGLE_SERVER_TOOL,
	MCP_UPDATE_SERVER_TOOL,
	mcpPlugin,
} from "./index.ts";
import { mcpManifest } from "./manifest.ts";
import { stdioEnvironment } from "./service.ts";

const FIXTURE = new URL("./fixtures/mcp-stdio-server.ts", import.meta.url).pathname;
const ENV_FIXTURE = new URL("./fixtures/mcp-env-stdio-server.ts", import.meta.url).pathname;
const SERVER_ID = "synthetic-mcp";

function makeContext(storage = new LocalStorageBridge(), audits: AuditEntry[] = []): PluginContext {
	return createPluginContext({
		audit: {
			record: async (entry) => {
				audits.push(entry);
			},
		},
		grantedPermissions: mcpManifest.permissions,
		manifest: mcpManifest,
		pluginId: "mcp",
		storage,
	});
}

function toolText(result: {
	readonly result: { readonly content: readonly { readonly text: string }[] };
}) {
	return result.result.content.map((part) => part.text).join("\n");
}

async function invokeTool(
	context: PluginContext,
	name: string,
	input: Record<string, unknown>,
	caller: Record<string, unknown> = { chatKind: "webui" },
): Promise<{ readonly text: string }> {
	const result = await context.tools.invoke(name, input, caller);
	if (!result.ok) throw new Error(`tool invocation failed: ${result.reason}`);
	return { text: toolText(result) };
}

function rpc(context: PluginContext, method: string, input?: unknown): Promise<unknown> {
	const shortName = method.startsWith("mcp.") ? method.slice(4) : method;
	return (
		context.rpc as unknown as {
			invoke(method: string, input?: unknown): Promise<unknown>;
		}
	).invoke(shortName, input);
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
				...MCP_ADMIN_TOOL_NAMES,
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
			expect(second.tools.list()).toHaveLength(MCP_ADMIN_TOOL_NAMES.length + 4);
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
			expect(context.tools.list().map((tool) => tool.name)).toEqual([...MCP_ADMIN_TOOL_NAMES]);
			const disabled = (await listServers(context))[0];
			expect(disabled?.state).toBe("disconnected");

			const enabled = parseSnapshot(
				await rpc(context, "mcp.toggle", { enabled: true, id: SERVER_ID }),
			);
			expect(enabled.state).toBe("connected");
			expect(context.tools.list()).toHaveLength(MCP_ADMIN_TOOL_NAMES.length + 4);

			const reconnected = parseSnapshot(await rpc(context, "mcp.reconnect", { id: SERVER_ID }));
			expect(reconnected.state).toBe("connected");
			expect(context.tools.list()).toHaveLength(MCP_ADMIN_TOOL_NAMES.length + 4);

			await rpc(context, "mcp.update", {
				disabledTools: ["picture"],
				id: SERVER_ID,
				name: "Synthetic MCP renamed",
			});
			expect(context.tools.list().map((tool) => tool.name)).not.toContain(
				"mcp.synthetic-mcp.picture",
			);

			await rpc(context, "mcp.delete", { id: SERVER_ID });
			expect(context.tools.list().map((tool) => tool.name)).toEqual([...MCP_ADMIN_TOOL_NAMES]);
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
			expect(context.tools.list().map((tool) => tool.name)).toEqual([...MCP_ADMIN_TOOL_NAMES]);
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

	test("admin MCP tools cover list, install, update, toggle, reconnect, and remove", async () => {
		const audits: AuditEntry[] = [];
		const context = makeContext(new LocalStorageBridge(), audits);
		await mcpPlugin.setup(context);
		const secret = "synthetic-mcp-admin-secret";
		try {
			const tools = context.tools.list();
			expect(
				tools.filter((tool) => MCP_ADMIN_TOOL_NAMES.includes(tool.name as never)),
			).toHaveLength(MCP_ADMIN_TOOL_NAMES.length);
			expect(tools.find((tool) => tool.name === MCP_LIST_SERVERS_TOOL)?.modelName).toBe(
				MCP_LIST_SERVERS_MODEL_NAME,
			);
			expect(tools.find((tool) => tool.name === MCP_INSTALL_SERVER_TOOL)?.modelName).toBe(
				MCP_INSTALL_SERVER_MODEL_NAME,
			);

			const listed = await invokeTool(context, MCP_LIST_SERVERS_TOOL, {}, { chatKind: "webui" });
			expect(JSON.parse(listed.text)).toEqual({ servers: [] });
			expect(audits.at(-1)).toMatchObject({
				action: "mcp.admin-tool",
				payload: expect.objectContaining({ operation: MCP_LIST_SERVERS_TOOL }),
				result: "ok",
				targetKind: "mcp-server",
			});

			const installed = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_INSTALL_SERVER_TOOL,
							createInput({
								transport: {
									args: [FIXTURE],
									command: process.execPath,
									env: { MCP_SYNTHETIC_SECRET: secret },
									type: "stdio",
								},
							}),
							{ chatKind: "workspace" },
						)
					).text,
				),
			);
			expect(installed.state).toBe("connected");
			expect(installed.secretKeys).toEqual(["env:MCP_SYNTHETIC_SECRET"]);
			expect(JSON.stringify(installed)).not.toContain(secret);
			expect(JSON.stringify(audits)).not.toContain(secret);

			const renamed = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_UPDATE_SERVER_TOOL,
							{ id: SERVER_ID, name: "Synthetic MCP admin rename" },
							{ chatKind: "private", isAdmin: true, senderPlatformId: "10002" },
						)
					).text,
				),
			);
			expect(renamed.name).toBe("Synthetic MCP admin rename");

			const disabled = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_TOGGLE_SERVER_TOOL,
							{ enabled: false, id: SERVER_ID },
							{ chatKind: "group", isAdmin: true, senderPlatformId: "10002" },
						)
					).text,
				),
			);
			expect(disabled.state).toBe("disconnected");
			expect(
				context.tools
					.list()
					.map((tool) => tool.name)
					.filter((name) => !name.startsWith("mcp.")),
			).toEqual([]);

			const enabled = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_TOGGLE_SERVER_TOOL,
							{ enabled: true, id: SERVER_ID },
							{ chatKind: "private", isAdmin: true, senderPlatformId: "10002" },
						)
					).text,
				),
			);
			expect(enabled.state).toBe("connected");
			const reconnected = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_RECONNECT_SERVER_TOOL,
							{ id: SERVER_ID },
							{ chatKind: "group", isAdmin: true, senderPlatformId: "10002" },
						)
					).text,
				),
			);
			expect(reconnected.state).toBe("connected");

			const removed = JSON.parse(
				(
					await invokeTool(
						context,
						MCP_REMOVE_SERVER_TOOL,
						{ id: SERVER_ID },
						{ chatKind: "group", isAdmin: true, senderPlatformId: "10002" },
					)
				).text,
			) as { readonly deleted: boolean; readonly id: string };
			expect(removed).toEqual({ deleted: true, id: SERVER_ID });
			expect(context.tools.list().map((tool) => tool.name)).toEqual([...MCP_ADMIN_TOOL_NAMES]);
			expect(
				audits.filter((audit) => audit.action === "mcp.admin-tool" && audit.result === "ok"),
			).toHaveLength(7);
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("every admin MCP tool denies non-admin IM, missing-sender, and synthetic callers", async () => {
		const audits: AuditEntry[] = [];
		const context = makeContext(new LocalStorageBridge(), audits);
		await mcpPlugin.setup(context);
		const invocations: readonly [string, Record<string, unknown>][] = [
			[MCP_LIST_SERVERS_TOOL, {}],
			[MCP_INSTALL_SERVER_TOOL, createInput({ id: "synthetic-denied" })],
			[MCP_UPDATE_SERVER_TOOL, { id: "synthetic-denied", name: "Synthetic denied" }],
			[MCP_TOGGLE_SERVER_TOOL, { enabled: false, id: "synthetic-denied" }],
			[MCP_RECONNECT_SERVER_TOOL, { id: "synthetic-denied" }],
			[MCP_REMOVE_SERVER_TOOL, { id: "synthetic-denied" }],
		];
		try {
			const callers = [
				{ chatKind: "private", isAdmin: false, senderPlatformId: "10003" },
				{ chatKind: "private", isAdmin: true },
				{ chatKind: "group", isAdmin: true },
				{ chatKind: "group" },
				{ chatKind: "task", isAdmin: true, senderPlatformId: "10002" },
				{ chatKind: "plugin", isAdmin: true, senderPlatformId: "10002" },
			];
			for (const [name, input] of invocations) {
				for (const caller of callers) {
					const result = await context.tools.invoke(name, input, caller);
					expect(result.ok).toBe(true);
					if (!result.ok) throw new Error("expected a text denial");
					expect(JSON.parse(toolText(result))).toEqual({ error: "admin_required" });
				}
			}
			expect(audits.filter((entry) => entry.result === "denied")).toHaveLength(
				invocations.length * callers.length,
			);
			for (const entry of audits.filter((audit) => audit.result === "denied")) {
				expect(entry.reason).toBe("admin_required");
				expect(entry.action).toBe("mcp.admin-tool");
				expect(JSON.stringify(entry.payload)).not.toContain("MCP_SYNTHETIC_SECRET");
			}
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("extends the stdio PATH with the tool install directories and de-duplicates it", () => {
		const home = "/home/synthetic";
		const env = stdioEnvironment({
			HOME: home,
			PATH: ["/usr/bin", "/usr/local/bin", join(home, ".local/bin"), "/bin"].join(delimiter),
		});
		expect(env.HOME).toBe(home);
		expect(env.PATH?.split(delimiter)).toEqual([
			"/usr/local/bin",
			join(home, ".local/bin"),
			"/usr/bin",
			"/bin",
		]);
	});

	test("passes configured env, cwd, and the extended PATH to a stdio server", async () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "tsukaima-mcp-env-")));
		const localBin = join(home, ".local/bin");
		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			const created = parseSnapshot(
				await rpc(
					context,
					"mcp.create",
					createInput({
						id: "synthetic-env",
						name: "Synthetic env MCP",
						transport: {
							args: [ENV_FIXTURE],
							command: process.execPath,
							cwd: home,
							env: {
								HOME: home,
								MCP_SYNTHETIC_FLAG: "synthetic",
								PATH: ["/usr/bin", "/usr/local/bin", localBin, "/bin"].join(delimiter),
							},
							type: "stdio",
						},
					}),
				),
			);
			expect(created.state).toBe("connected");

			const result = await context.tools.invoke("mcp.synthetic-env.environment", {});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected an environment result");
			const reported = JSON.parse(result.result.content[0]?.text ?? "{}") as {
				custom?: string;
				cwd?: string;
				home?: string;
				path?: string;
			};
			expect(reported.home).toBe(home);
			expect(reported.custom).toBe("synthetic");
			expect(reported.cwd).toBe(home);
			expect(reported.path?.split(delimiter)).toEqual([
				"/usr/local/bin",
				localBin,
				"/usr/bin",
				"/bin",
			]);
		} finally {
			await mcpPlugin.teardown?.(context);
			rmSync(home, { force: true, recursive: true });
		}
	});

	test("names the missing executable when a stdio command cannot be spawned", async () => {
		const context = makeContext();
		await mcpPlugin.setup(context);
		const missing = "tsukaima-mcp-executable-that-does-not-exist";
		try {
			const broken = parseSnapshot(
				await rpc(
					context,
					"mcp.create",
					createInput({
						id: "synthetic-missing",
						name: "Synthetic missing MCP",
						transport: { args: [], command: missing, type: "stdio" },
					}),
				),
			);
			expect(broken.state).toBe("error");
			expect(broken.lastError).toContain(missing);
			expect(broken.lastError).toContain("was not found");
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("splits inline command arguments when args are omitted", async () => {
		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			const created = parseSnapshot(
				await rpc(
					context,
					"mcp.create",
					createInput({
						id: "synthetic-inline",
						transport: {
							command: `"${process.execPath}" "${FIXTURE}"`,
							type: "stdio",
						},
					}),
				),
			);
			expect(created.state).toBe("connected");
			expect(created.tools.length).toBe(4);
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});
});
