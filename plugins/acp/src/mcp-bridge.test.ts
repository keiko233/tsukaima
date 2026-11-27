import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Tool } from "@earendil-works/pi-ai";
import { startAcpChatToolBridge, type AcpChatToolBridge } from "./mcp-bridge.ts";

const TOOLS: readonly Tool[] = [
	{
		description: "Echo synthetic text",
		name: "echo",
		parameters: {
			additionalProperties: false,
			properties: { text: { type: "string" } },
			required: ["text"],
			type: "object",
		},
	},
	{
		description: "Read a synthetic weather summary",
		name: "weather",
		parameters: {
			properties: { city: { type: "string" } },
			type: "object",
		},
	},
];

interface JsonRpcResponse {
	readonly error?: {
		readonly code: number;
		readonly message: string;
	};
	readonly id?: number | string | null;
	readonly result?: unknown;
}

interface StdioRpc {
	notify(method: string, params?: unknown): void;
	request(method: string, params?: unknown): Promise<JsonRpcResponse>;
	close(): void;
}

describe("ACP chat tool MCP bridge", () => {
	test("rejects unauthorized HTTP requests", async () => {
		const bridge = await startAcpChatToolBridge(TOOLS);
		try {
			const response = await fetch(bridgeUrl(bridge), {
				body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			expect(response.status).toBe(401);
			expect(bridge.getToolCalls()).toEqual([]);
		} finally {
			await bridge.close();
		}
	});

	test("serves only allowed tools and captures calls over stdio", async () => {
		const bridge = await startAcpChatToolBridge(TOOLS);
		const child = spawn(bridge.mcpServer.command, [...(bridge.mcpServer.args ?? [])], {
			env: { ...process.env, ...bridgeEnv(bridge) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const rpc = createStdioRpc(child);
		try {
			const initialized = await rpc.request("initialize", {
				clientInfo: { name: "synthetic-test-client", version: "1.0.0" },
				protocolVersion: 1,
			});
			expect(initialized.error).toBeUndefined();
			expect(initialized.result).toEqual({
				capabilities: { tools: {} },
				protocolVersion: "2024-11-05",
				serverInfo: { name: "tsukaima-chat-tools", version: "0.36.0" },
			});

			rpc.notify("notifications/initialized");
			const listed = await rpc.request("tools/list");
			expect(listed.error).toBeUndefined();
			expect(listed.result).toEqual({
				tools: TOOLS.map((tool) => ({
					description: tool.description,
					inputSchema: tool.parameters,
					name: tool.name,
				})),
			});

			const call = await rpc.request("tools/call", {
				arguments: { text: "synthetic echo" },
				name: "echo",
			});
			expect(call.error).toBeUndefined();
			expect(call.result).toEqual({
				content: [
					{
						text: "Tool call queued for host execution. End your current turn now and wait for the tool result.",
						type: "text",
					},
				],
				isError: false,
			});
			expect(bridge.getToolCalls()).toEqual([
				{
					arguments: { text: "synthetic echo" },
					id: "acp-mcp-0",
					name: "echo",
					type: "toolCall",
				},
			]);

			const rejected = await rpc.request("tools/call", {
				arguments: { command: "synthetic command" },
				name: "bash",
			});
			expect(rejected.error?.code).toBe(-32602);
			expect(bridge.getToolCalls()).toHaveLength(1);
		} finally {
			rpc.close();
			await bridge.close();
		}
	});

	test("close shuts down the HTTP server", async () => {
		const bridge = await startAcpChatToolBridge(TOOLS);
		const url = bridgeUrl(bridge);
		try {
			const response = await fetch(url, {
				body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" }),
				headers: {
					authorization: `Bearer ${bridgeEnv(bridge).TSUKAIMA_ACP_MCP_TOKEN}`,
					"content-type": "application/json",
				},
				method: "POST",
			});
			expect(response.status).toBe(200);
		} finally {
			await bridge.close();
		}

		await expect(
			fetch(url, {
				body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "ping" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		).rejects.toThrow();
	});
});

function bridgeEnv(bridge: AcpChatToolBridge): Readonly<Record<string, string>> {
	return bridge.mcpServer.env as Readonly<Record<string, string>>;
}

function bridgeUrl(bridge: AcpChatToolBridge): string {
	return bridgeEnv(bridge).TSUKAIMA_ACP_MCP_URL as string;
}

function createStdioRpc(child: ChildProcessWithoutNullStreams): StdioRpc {
	let nextId = 1;
	const pending = new Map<
		string,
		{
			readonly reject: (error: Error) => void;
			readonly resolve: (response: JsonRpcResponse) => void;
		}
	>();
	const reader = createInterface({ input: child.stdout, terminal: false });
	reader.on("line", (line) => {
		const response = JSON.parse(line) as JsonRpcResponse;
		if (response.id === undefined || response.id === null) return;
		const waiter = pending.get(String(response.id));
		if (waiter === undefined) return;
		pending.delete(String(response.id));
		waiter.resolve(response);
	});
	child.once("exit", (code, signal) => {
		const error = new Error(`MCP stdio shim exited (code=${code}, signal=${signal})`);
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	});

	return {
		close: () => {
			reader.close();
			child.kill();
		},
		notify: (method, params) => {
			child.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					method,
					...(params === undefined ? {} : { params }),
				})}\n`,
			);
		},
		request: (method, params) => {
			const id = nextId;
			nextId += 1;
			return new Promise<JsonRpcResponse>((resolve, reject) => {
				pending.set(String(id), { reject, resolve });
				child.stdin.write(
					`${JSON.stringify({
						id,
						jsonrpc: "2.0",
						method,
						...(params === undefined ? {} : { params }),
					})}\n`,
				);
			});
		},
	};
}
