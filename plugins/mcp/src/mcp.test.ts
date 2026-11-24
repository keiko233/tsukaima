import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	mcpServerCreateSchema,
	mcpServerSnapshotSchema,
	mcpServerUpdateSchema,
	type McpServerSnapshot,
} from "@tsukaima/contracts";
import {
	createPluginContext,
	LocalStorageBridge,
	type AuditEntry,
	type PluginContext,
} from "@tsukaima/sdk";
import { z } from "zod";
import {
	MCP_ADMIN_TOOL_NAMES,
	MCP_CLEAR_OAUTH_TOOL,
	MCP_COMPLETE_OAUTH_TOOL,
	MCP_INSTALL_SERVER_MODEL_NAME,
	MCP_INSTALL_SERVER_TOOL,
	MCP_LIST_SERVERS_MODEL_NAME,
	MCP_LIST_SERVERS_TOOL,
	MCP_OAUTH_HOST_BINDING,
	MCP_RECONNECT_SERVER_TOOL,
	MCP_REMOVE_SERVER_TOOL,
	MCP_START_OAUTH_TOOL,
	MCP_TOGGLE_SERVER_TOOL,
	MCP_UPDATE_SERVER_TOOL,
	mcpPlugin,
	type McpOAuthCallbackOutcome,
	type McpOAuthCallbackParams,
	type McpOAuthHost,
} from "./index.ts";
import { mcpManifest } from "./manifest.ts";
import { stdioEnvironment } from "./service.ts";

const FIXTURE = new URL("./fixtures/mcp-stdio-server.ts", import.meta.url).pathname;
const ENV_FIXTURE = new URL("./fixtures/mcp-env-stdio-server.ts", import.meta.url).pathname;
const SERVER_ID = "synthetic-mcp";

function makeContext(
	storage = new LocalStorageBridge(),
	audits: AuditEntry[] = [],
	dependencies?: ReadonlyMap<string, unknown>,
): PluginContext {
	return createPluginContext({
		audit: {
			record: async (entry) => {
				audits.push(entry);
			},
		},
		...(dependencies === undefined
			? {}
			: {
					dependencies: {
						get: <T = unknown>(key: string): T | undefined =>
							dependencies.get(key) as T | undefined,
					},
				}),
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

			const text = await context.tools.invoke(
				"mcp.synthetic-mcp.echo",
				{ text: "synthetic ping" },
				{ chatKind: "webui" },
			);
			expect(text.ok).toBe(true);
			if (!text.ok) throw new Error("expected text result");
			expect(text.result.content).toEqual([{ text: "synthetic ping", type: "text" }]);

			const image = await context.tools.invoke(
				"mcp.synthetic-mcp.picture",
				{},
				{ chatKind: "webui" },
			);
			expect(image.ok).toBe(true);
			if (!image.ok) throw new Error("expected image result");
			expect(image.result.images?.[0]?.mimeType).toBe("image/png");
			expect((image.result.images?.[0]?.data.length ?? 0) > 0).toBe(true);

			await expect(
				context.tools.invoke("mcp.synthetic-mcp.fail", {}, { chatKind: "webui" }),
			).rejects.toThrow("synthetic tool failure");
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
			await expect(
				context.tools.invoke("mcp.synthetic-mcp.slow", {}, { chatKind: "webui" }),
			).rejects.toThrow("timed out");
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

			const result = await context.tools.invoke(
				"mcp.synthetic-env.environment",
				{},
				{ chatKind: "webui" },
			);
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

	test("defaults MCP server scope to admin and gates server tools by scope", async () => {
		const audits: AuditEntry[] = [];
		const context = makeContext(new LocalStorageBridge(), audits);
		await mcpPlugin.setup(context);
		try {
			const created = parseSnapshot(await rpc(context, "mcp.create", createInput()));
			expect(created.scope).toBe("admin");
			expect(
				context.tools.list().find((tool) => tool.name === "mcp.synthetic-mcp.echo")?.description,
			).toContain("admin only");

			const deniedCallers = [
				{},
				{ chatKind: "private", isAdmin: false, senderPlatformId: "10003" },
				{ chatKind: "group", senderPlatformId: "10003" },
				{ chatKind: "group", isAdmin: true },
				{ chatKind: "task", isAdmin: true, senderPlatformId: "10002" },
				{ chatKind: "plugin", isAdmin: true, senderPlatformId: "10002" },
			];
			for (const caller of deniedCallers) {
				const denied = await context.tools.invoke(
					"mcp.synthetic-mcp.echo",
					{ text: "denied" },
					caller,
				);
				expect(denied.ok).toBe(true);
				if (!denied.ok) throw new Error("expected text denial");
				expect(JSON.parse(toolText(denied))).toEqual({ error: "admin_required" });
			}
			expect(audits.filter((entry) => entry.action === "mcp.tool.denied")).toHaveLength(
				deniedCallers.length,
			);

			const allowedCallers = [
				{ chatKind: "webui" },
				{ chatKind: "workspace" },
				{ chatKind: "private", isAdmin: true, senderPlatformId: "10002" },
				{ chatKind: "group", isAdmin: true, senderPlatformId: "10002" },
			];
			for (const caller of allowedCallers) {
				const allowed = await context.tools.invoke(
					"mcp.synthetic-mcp.echo",
					{ text: "allowed" },
					caller,
				);
				expect(allowed.ok).toBe(true);
				if (!allowed.ok) throw new Error("expected allowed response");
				expect(allowed.result.content).toEqual([{ text: "allowed", type: "text" }]);
			}

			const opened = parseSnapshot(
				await rpc(context, "mcp.update", { id: SERVER_ID, scope: "everyone" }),
			);
			expect(opened.scope).toBe("everyone");
			expect(
				context.tools.list().find((tool) => tool.name === "mcp.synthetic-mcp.echo")?.description,
			).not.toContain("admin only");

			const nonAdminAllowed = await context.tools.invoke(
				"mcp.synthetic-mcp.echo",
				{ text: "public" },
				{ chatKind: "group", senderPlatformId: "10003" },
			);
			expect(nonAdminAllowed.ok).toBe(true);
			if (!nonAdminAllowed.ok) throw new Error("expected public response");
			expect(nonAdminAllowed.result.content).toEqual([{ text: "public", type: "text" }]);
		} finally {
			await mcpPlugin.teardown?.(context);
		}
	});

	test("generates JSON Schemas for create and update admin tools", () => {
		expect(() => z.toJSONSchema(mcpServerCreateSchema)).not.toThrow();
		expect(() => z.toJSONSchema(mcpServerUpdateSchema)).not.toThrow();
	});

	test("supports HTTP bearer token authentication with secret masking and preservation", async () => {
		const expectedToken = "synthetic-bearer-token-value";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
				if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
					return new Response("Unauthorized", { status: 401 });
				}
				if (request.method === "GET") return new Response(null, { status: 405 });
				const body = (await request.json()) as {
					id?: string | number;
					method: string;
					params?: { arguments?: Record<string, unknown>; name?: string };
				};
				if (body.method === "initialize") {
					return Response.json({
						id: body.id,
						jsonrpc: "2.0",
						result: {
							capabilities: { tools: {} },
							protocolVersion: "2025-03-26",
							serverInfo: { name: "synthetic-bearer-mcp", version: "1.0.0" },
						},
					});
				}
				if (body.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				if (body.method === "tools/list") {
					return Response.json({
						id: body.id,
						jsonrpc: "2.0",
						result: {
							tools: [
								{
									description: "Ping over HTTP bearer auth",
									inputSchema: { properties: { msg: { type: "string" } }, type: "object" },
									name: "ping",
								},
							],
						},
					});
				}
				if (body.method === "tools/call") {
					return Response.json({
						id: body.id,
						jsonrpc: "2.0",
						result: {
							content: [
								{ text: `pong:${String(body.params?.arguments?.msg ?? "")}`, type: "text" },
							],
						},
					});
				}
				return new Response("Unsupported", { status: 400 });
			},
		});

		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			const created = parseSnapshot(
				await rpc(context, "mcp.create", {
					deferred: true,
					enabled: true,
					id: "synthetic-bearer",
					name: "Synthetic Bearer MCP",
					surface: "both",
					timeoutMs: 5_000,
					transport: {
						auth: { token: expectedToken, type: "bearer" },
						type: "http",
						url: `${server.url.origin}/mcp`,
					},
				}),
			);
			expect(created.state).toBe("connected");
			expect(created.secretKeys).toEqual(["auth:token"]);
			expect(JSON.stringify(created)).not.toContain(expectedToken);

			const updated = parseSnapshot(
				await rpc(context, "mcp.update", {
					id: "synthetic-bearer",
					transport: {
						auth: { token: "***", type: "bearer" },
						type: "http",
						url: `${server.url.origin}/mcp`,
					},
				}),
			);
			expect(updated.state).toBe("connected");
			expect(JSON.stringify(updated)).not.toContain(expectedToken);

			const called = await context.tools.invoke(
				"mcp.synthetic-bearer.ping",
				{ msg: "ok" },
				{ chatKind: "webui" },
			);
			expect(called.ok).toBe(true);
			if (!called.ok) throw new Error("expected ping result");
			expect(called.result.content).toEqual([{ text: "pong:ok", type: "text" }]);
		} finally {
			await mcpPlugin.teardown?.(context);
			await server.stop(true);
		}
	});

	test("supports OAuth 2.1 Authorization Code + PKCE + DCR, callback completion, refresh, and persistence", async () => {
		let currentAccessToken = "example-access-token-1";
		let currentRefreshToken = "example-refresh-token-1";
		let rejectRefresh = false;
		let registeredClientId = "";
		let registeredClientSecret = "";
		let lastIssuedCode = "";
		let lastCodeChallenge = "";
		let lastRedirectUri = "";
		let lastResource = "";
		const tokenRequests: string[] = [];

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request): Promise<Response> {
				const url = new URL(request.url);
				const origin = url.origin;
				if (url.pathname === "/.well-known/oauth-protected-resource") {
					return Response.json({
						authorization_servers: [origin],
						resource: `${origin}/mcp`,
						scopes_supported: ["mcp:read"],
					});
				}
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({
						authorization_endpoint: `${origin}/authorize`,
						code_challenge_methods_supported: ["S256"],
						grant_types_supported: ["authorization_code", "refresh_token"],
						issuer: origin,
						registration_endpoint: `${origin}/register`,
						response_types_supported: ["code"],
						token_endpoint: `${origin}/token`,
						token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
					});
				}
				if (url.pathname === "/register" && request.method === "POST") {
					const body = (await request.json()) as { redirect_uris?: string[] };
					registeredClientId = "dcr-client-123";
					registeredClientSecret = "dcr-secret-xyz";
					return Response.json(
						{
							client_id: registeredClientId,
							client_secret: registeredClientSecret,
							grant_types: ["authorization_code", "refresh_token"],
							redirect_uris: body.redirect_uris ?? [],
							response_types: ["code"],
							token_endpoint_auth_method: "client_secret_basic",
						},
						{ status: 201 },
					);
				}
				if (url.pathname === "/token" && request.method === "POST") {
					const form = new URLSearchParams(await request.text());
					const grantType = form.get("grant_type") ?? "";
					tokenRequests.push(grantType);
					const authHeader = request.headers.get("authorization") ?? "";
					const expectedBasic = `Basic ${Buffer.from(`${registeredClientId}:${registeredClientSecret}`).toString("base64")}`;
					if (authHeader !== expectedBasic) {
						return Response.json({ error: "invalid_client" }, { status: 401 });
					}
					if (grantType === "authorization_code") {
						const code = form.get("code");
						const verifier = form.get("code_verifier") ?? "";
						const challenge = createHash("sha256").update(verifier).digest("base64url");
						if (
							code !== lastIssuedCode ||
							challenge !== lastCodeChallenge ||
							form.get("redirect_uri") !== lastRedirectUri ||
							form.get("resource") !== lastResource
						) {
							return Response.json({ error: "invalid_grant" }, { status: 400 });
						}
						return Response.json({
							access_token: currentAccessToken,
							expires_in: 3600,
							refresh_token: currentRefreshToken,
							scope: "mcp:read",
							token_type: "Bearer",
						});
					}
					if (grantType === "refresh_token") {
						if (rejectRefresh || form.get("refresh_token") !== currentRefreshToken) {
							return Response.json({ error: "invalid_grant" }, { status: 400 });
						}
						currentAccessToken = "example-access-token-2";
						currentRefreshToken = "example-refresh-token-2";
						return Response.json({
							access_token: currentAccessToken,
							expires_in: 3600,
							refresh_token: currentRefreshToken,
							scope: "mcp:read",
							token_type: "Bearer",
						});
					}
					return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
				}
				if (url.pathname === "/mcp") {
					if (request.headers.get("authorization") !== `Bearer ${currentAccessToken}`) {
						return new Response("Unauthorized", {
							headers: {
								"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp:read"`,
							},
							status: 401,
						});
					}
					if (request.method === "GET") return new Response(null, { status: 405 });
					const body = (await request.json()) as {
						id?: string | number;
						method: string;
						params?: { arguments?: Record<string, unknown> };
					};
					if (body.method === "initialize") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								capabilities: { tools: {} },
								protocolVersion: "2025-03-26",
								serverInfo: { name: "synthetic-oauth-mcp", version: "1.0.0" },
							},
						});
					}
					if (body.method === "notifications/initialized") {
						return new Response(null, { status: 202 });
					}
					if (body.method === "tools/list") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								tools: [
									{
										description: "Read protected item",
										inputSchema: { properties: {}, type: "object" },
										name: "whoami",
									},
								],
							},
						});
					}
					if (body.method === "tools/call") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								content: [{ text: `token=${currentAccessToken}`, type: "text" }],
							},
						});
					}
				}
				return new Response("Not found", { status: 404 });
			},
		});

		let registeredCallback:
			| ((params: McpOAuthCallbackParams) => Promise<McpOAuthCallbackOutcome>)
			| undefined;
		const oauthHost: McpOAuthHost = {
			publicUrl: "https://webui.example.test",
			registerCallbackHandler(handler) {
				registeredCallback = handler;
				return () => {
					registeredCallback = undefined;
				};
			},
		};
		const storage = new LocalStorageBridge();
		const deps = new Map<string, unknown>([[MCP_OAUTH_HOST_BINDING, oauthHost]]);
		const firstContext = makeContext(storage, [], deps);
		await mcpPlugin.setup(firstContext);
		try {
			const created = parseSnapshot(
				await rpc(firstContext, "mcp.create", {
					deferred: true,
					enabled: true,
					id: "synthetic-oauth",
					name: "Synthetic OAuth MCP",
					surface: "both",
					timeoutMs: 5_000,
					transport: {
						auth: { grantType: "authorization_code", type: "oauth" },
						type: "http",
						url: `${server.url.origin}/mcp`,
					},
				}),
			);
			expect(created.state).toBe("auth_required");
			expect(created.oauth?.status).toBe("pending");
			expect(created.oauth?.clientId).toBe("dcr-client-123");
			expect(created.oauth?.redirectUrl).toBe("https://webui.example.test/api/mcp/oauth/callback");
			const authUrl = new URL(created.oauth?.authorizationUrl ?? "");
			expect(authUrl.origin).toBe(server.url.origin);
			expect(authUrl.pathname).toBe("/authorize");
			lastCodeChallenge = authUrl.searchParams.get("code_challenge") ?? "";
			lastRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
			lastResource = authUrl.searchParams.get("resource") ?? "";
			const stateParam = authUrl.searchParams.get("state") ?? "";
			expect(lastCodeChallenge.length).toBeGreaterThan(10);
			expect(stateParam.length).toBeGreaterThan(10);
			expect(JSON.stringify(created)).not.toContain(registeredClientSecret);

			lastIssuedCode = "synthetic-auth-code-1";
			const outcome = await registeredCallback?.({ code: lastIssuedCode, state: stateParam });
			expect(outcome).toEqual({ ok: true, serverId: "synthetic-oauth" });

			// Replaying the same single-use state must be rejected.
			const replay = await registeredCallback?.({ code: lastIssuedCode, state: stateParam });
			expect(replay?.ok).toBe(false);

			const connected = (await listServers(firstContext))[0];
			expect(connected?.state).toBe("connected");
			expect(connected?.oauth?.status).toBe("authorized");
			expect(connected?.oauth?.hasRefreshToken).toBe(true);
			expect(JSON.stringify(connected)).not.toContain(currentAccessToken);
			expect(JSON.stringify(connected)).not.toContain(currentRefreshToken);

			const whoami = await firstContext.tools.invoke(
				"mcp.synthetic-oauth.whoami",
				{},
				{ chatKind: "webui" },
			);
			expect(whoami.ok).toBe(true);
			if (!whoami.ok) throw new Error("expected whoami result");
			expect(whoami.result.content).toEqual([
				{ text: "token=example-access-token-1", type: "text" },
			]);

			// Simulate access token expiration on the MCP server -> reconnect refreshes automatically.
			currentAccessToken = "example-access-token-expired-on-server";
			const refreshed = parseSnapshot(
				await rpc(firstContext, "mcp.reconnect", { id: "synthetic-oauth" }),
			);
			expect(refreshed.state).toBe("connected");
			expect(tokenRequests).toContain("refresh_token");

			// Simulate refresh token revocation -> transitions back to auth_required with new URL.
			currentAccessToken = "example-access-token-revoked";
			rejectRefresh = true;
			const needsReauth = parseSnapshot(
				await rpc(firstContext, "mcp.reconnect", { id: "synthetic-oauth" }),
			);
			expect(needsReauth.state).toBe("auth_required");
			expect(needsReauth.oauth?.status).toBe("pending");
			const nextAuthUrl = new URL(needsReauth.oauth?.authorizationUrl ?? "");
			lastCodeChallenge = nextAuthUrl.searchParams.get("code_challenge") ?? "";
			lastRedirectUri = nextAuthUrl.searchParams.get("redirect_uri") ?? "";
			lastResource = nextAuthUrl.searchParams.get("resource") ?? "";
			lastIssuedCode = "synthetic-auth-code-2";
			rejectRefresh = false;
			currentAccessToken = "example-access-token-3";
			const completed = parseSnapshot(
				await rpc(firstContext, "mcp.completeOAuth", {
					callbackUrl: `${lastRedirectUri}?code=${lastIssuedCode}&state=${nextAuthUrl.searchParams.get("state")}`,
					id: "synthetic-oauth",
				}),
			);
			expect(completed.state).toBe("connected");
		} finally {
			await mcpPlugin.teardown?.(firstContext);
		}

		// Restoring from persistent plugin storage connects immediately with saved tokens.
		const secondContext = makeContext(storage, [], deps);
		await mcpPlugin.setup(secondContext);
		try {
			const restored = (await listServers(secondContext))[0];
			expect(restored?.state).toBe("connected");
			expect(restored?.oauth?.status).toBe("authorized");
			expect(secondContext.tools.list().map((tool) => tool.name)).toContain(
				"mcp.synthetic-oauth.whoami",
			);
		} finally {
			await mcpPlugin.teardown?.(secondContext);
			await server.stop(true);
		}
	});

	test("supports OAuth 2.0 Client Credentials with client_secret_basic and private_key_jwt", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { format: "pem", type: "pkcs8" },
			publicKeyEncoding: { format: "pem", type: "spki" },
		});
		void publicKey;
		const secretToken = "example-m2m-secret-token";
		const jwtToken = "example-m2m-jwt-token";
		const clientSecret = "example-m2m-client-secret";
		let seenJwtAssertion = "";

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request): Promise<Response> {
				const url = new URL(request.url);
				const origin = url.origin;
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({
						authorization_endpoint: `${origin}/authorize`,
						issuer: origin,
						response_types_supported: ["code"],
						token_endpoint: `${origin}/token`,
						token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"],
					});
				}
				if (url.pathname === "/token" && request.method === "POST") {
					const form = new URLSearchParams(await request.text());
					if (form.get("grant_type") !== "client_credentials") {
						return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
					}
					const assertion = form.get("client_assertion");
					if (
						assertion !== null &&
						form.get("client_assertion_type") ===
							"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
					) {
						seenJwtAssertion = assertion;
						return Response.json({
							access_token: jwtToken,
							expires_in: 3600,
							token_type: "Bearer",
						});
					}
					const expectedBasic = `Basic ${Buffer.from(`m2m-secret-client:${clientSecret}`).toString("base64")}`;
					if (request.headers.get("authorization") === expectedBasic) {
						return Response.json({
							access_token: secretToken,
							expires_in: 3600,
							token_type: "Bearer",
						});
					}
					return Response.json({ error: "invalid_client" }, { status: 401 });
				}
				if (url.pathname === "/mcp") {
					const authHeader = request.headers.get("authorization");
					if (authHeader !== `Bearer ${secretToken}` && authHeader !== `Bearer ${jwtToken}`) {
						return new Response("Unauthorized", { status: 401 });
					}
					if (request.method === "GET") return new Response(null, { status: 405 });
					const body = (await request.json()) as { id?: string | number; method: string };
					if (body.method === "initialize") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								capabilities: { tools: {} },
								protocolVersion: "2025-03-26",
								serverInfo: { name: "synthetic-m2m-mcp", version: "1.0.0" },
							},
						});
					}
					if (body.method === "notifications/initialized") {
						return new Response(null, { status: 202 });
					}
					if (body.method === "tools/list") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								tools: [
									{
										description: "Machine status",
										inputSchema: { properties: {}, type: "object" },
										name: "status",
									},
								],
							},
						});
					}
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const context = makeContext();
		await mcpPlugin.setup(context);
		try {
			const basicCreated = parseSnapshot(
				await rpc(context, "mcp.create", {
					deferred: true,
					enabled: true,
					id: "synthetic-m2m-basic",
					name: "Synthetic M2M Basic",
					surface: "both",
					timeoutMs: 5_000,
					transport: {
						auth: {
							clientId: "m2m-secret-client",
							clientSecret,
							expectedIssuer: server.url.origin,
							grantType: "client_credentials",
							scope: "tools:read",
							type: "oauth",
						},
						type: "http",
						url: `${server.url.origin}/mcp`,
					},
				}),
			);
			expect(basicCreated.state).toBe("connected");
			expect(basicCreated.oauth?.status).toBe("authorized");
			expect(basicCreated.oauth?.grantType).toBe("client_credentials");
			expect(basicCreated.secretKeys).toEqual(["auth:clientSecret"]);
			expect(JSON.stringify(basicCreated)).not.toContain(clientSecret);
			expect(JSON.stringify(basicCreated)).not.toContain(secretToken);

			const jwtCreated = parseSnapshot(
				await rpc(context, "mcp.create", {
					deferred: true,
					enabled: true,
					id: "synthetic-m2m-jwt",
					name: "Synthetic M2M JWT",
					surface: "both",
					timeoutMs: 5_000,
					transport: {
						auth: {
							algorithm: "RS256",
							clientId: "m2m-jwt-client",
							expectedIssuer: server.url.origin,
							grantType: "client_credentials",
							privateKey,
							tokenEndpointAuthMethod: "private_key_jwt",
							type: "oauth",
						},
						type: "http",
						url: `${server.url.origin}/mcp`,
					},
				}),
			);
			expect(jwtCreated.state).toBe("connected");
			expect(jwtCreated.oauth?.status).toBe("authorized");
			expect(jwtCreated.secretKeys).toEqual(["auth:privateKey"]);
			expect(seenJwtAssertion.split(".")).toHaveLength(3);
			expect(JSON.stringify(jwtCreated)).not.toContain("PRIVATE KEY");
			expect(JSON.stringify(jwtCreated)).not.toContain(jwtToken);

			// Pinning a mismatched expectedIssuer must refuse to send credentials.
			const mismatch = parseSnapshot(
				await rpc(context, "mcp.create", {
					deferred: true,
					enabled: true,
					id: "synthetic-m2m-mismatch",
					name: "Synthetic M2M Mismatch",
					surface: "both",
					timeoutMs: 5_000,
					transport: {
						auth: {
							clientId: "m2m-secret-client",
							clientSecret,
							expectedIssuer: "https://unexpected-issuer.invalid",
							grantType: "client_credentials",
							type: "oauth",
						},
						type: "http",
						url: `${server.url.origin}/mcp`,
					},
				}),
			);
			expect(mismatch.state).toBe("error");
			expect(JSON.stringify(mismatch)).not.toContain(clientSecret);
		} finally {
			await mcpPlugin.teardown?.(context);
			await server.stop(true);
		}
	});

	test("admin OAuth tools enforce admin gates and audit without leaking secrets", async () => {
		const audits: AuditEntry[] = [];
		const context = makeContext(new LocalStorageBridge(), audits);
		await mcpPlugin.setup(context);
		const clientSecret = "synthetic-admin-oauth-secret";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request): Response {
				const url = new URL(request.url);
				const origin = url.origin;
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({
						authorization_endpoint: `${origin}/authorize`,
						code_challenge_methods_supported: ["S256"],
						issuer: origin,
						response_types_supported: ["code"],
						token_endpoint: `${origin}/token`,
					});
				}
				if (url.pathname === "/mcp") {
					return new Response("Unauthorized", { status: 401 });
				}
				return new Response("Not found", { status: 404 });
			},
		});
		try {
			await rpc(context, "mcp.create", {
				deferred: true,
				enabled: true,
				id: "synthetic-admin-oauth",
				name: "Synthetic Admin OAuth",
				surface: "both",
				timeoutMs: 5_000,
				transport: {
					auth: {
						clientId: "pre-reg-client",
						clientSecret,
						grantType: "authorization_code",
						type: "oauth",
					},
					type: "http",
					url: `${server.url.origin}/mcp`,
				},
			});

			for (const [toolName, payload] of [
				[MCP_START_OAUTH_TOOL, { id: "synthetic-admin-oauth" }],
				[MCP_COMPLETE_OAUTH_TOOL, { code: "abc", id: "synthetic-admin-oauth" }],
				[MCP_CLEAR_OAUTH_TOOL, { id: "synthetic-admin-oauth" }],
			] as const) {
				const denied = await context.tools.invoke(toolName, payload, {
					chatKind: "private",
					isAdmin: false,
					senderPlatformId: "10003",
				});
				expect(denied.ok).toBe(true);
				if (!denied.ok) throw new Error("expected denial");
				expect(JSON.parse(toolText(denied))).toEqual({ error: "admin_required" });
			}

			const started = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_START_OAUTH_TOOL,
							{ callbackOrigin: "https://panel.example.test", id: "synthetic-admin-oauth" },
							{ chatKind: "webui" },
						)
					).text,
				),
			);
			expect(started.state).toBe("auth_required");
			expect(started.oauth?.redirectUrl).toBe("https://panel.example.test/api/mcp/oauth/callback");

			const cleared = parseSnapshot(
				JSON.parse(
					(
						await invokeTool(
							context,
							MCP_CLEAR_OAUTH_TOOL,
							{ id: "synthetic-admin-oauth" },
							{ chatKind: "webui" },
						)
					).text,
				),
			);
			expect(cleared.oauth?.status).toBe("unauthenticated");
			expect(JSON.stringify(audits)).not.toContain(clientSecret);
		} finally {
			await mcpPlugin.teardown?.(context);
			await server.stop(true);
		}
	});
});
