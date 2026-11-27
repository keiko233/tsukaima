import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { JsonObject, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { AcpMcpStdioServerConfig } from "./protocol.ts";

const DEFAULT_SERVER_NAME = "tsukaima-chat-tools";
const DEFAULT_MAX_CAPTURED_CALLS = 8;
const STDIO_SHIM_PATH = fileURLToPath(new URL("./mcp-bridge-stdio.ts", import.meta.url));

export interface AcpChatToolBridgeOptions {
	readonly serverName?: string;
	readonly maxCapturedCalls?: number;
}

export interface AcpChatToolBridge {
	readonly mcpServer: AcpMcpStdioServerConfig;
	getToolCalls(): readonly ToolCall[];
	close(): Promise<void>;
}

/**
 * Starts an ephemeral MCP server that exposes only the supplied chat tools. Tool calls are
 * captured for the conversation host and are never executed inside this plugin.
 */
export async function startAcpChatToolBridge(
	tools: readonly Tool[],
	options: AcpChatToolBridgeOptions = {},
): Promise<AcpChatToolBridge> {
	const token = randomBytes(32).toString("hex");
	const allowedTools = new Map(tools.map((tool) => [tool.name, tool]));
	const capturedToolCalls: ToolCall[] = [];
	const maxCapturedCalls = options.maxCapturedCalls ?? DEFAULT_MAX_CAPTURED_CALLS;
	let closed = false;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.headers.get("authorization") !== `Bearer ${token}`) {
				return new Response("Unauthorized", { status: 401 });
			}
			if (request.method !== "POST") {
				return new Response("Method not allowed", { status: 405 });
			}

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return errorResponse(null, -32700, "Parse error");
			}
			if (!isRecord(body) || typeof body.method !== "string") {
				return errorResponse(null, -32600, "Invalid request");
			}

			const id = isJsonRpcId(body.id) ? body.id : null;
			switch (body.method) {
				case "initialize":
					return successResponse(id, {
						capabilities: { tools: {} },
						protocolVersion: "2024-11-05",
						serverInfo: { name: "tsukaima-chat-tools", version: "0.36.0" },
					});
				case "notifications/initialized":
					return new Response(null, { status: 204 });
				case "ping":
					return successResponse(id, {});
				case "tools/list":
					return successResponse(id, {
						tools: tools.map((tool) => ({
							description: tool.description,
							inputSchema: tool.parameters,
							name: tool.name,
						})),
					});
				case "tools/call":
					return handleToolCall(id, body.params);
				default:
					return errorResponse(id, -32601, `Method not found: ${body.method}`);
			}

			function handleToolCall(callId: unknown, params: unknown): Response {
				if (!isRecord(params) || typeof params.name !== "string") {
					return errorResponse(callId, -32602, "tools/call requires a tool name");
				}
				const name = params.name;
				if (!allowedTools.has(name)) {
					return errorResponse(callId, -32602, `Tool is not available: ${name}`);
				}
				const callArguments = params.arguments;
				if (!isRecord(callArguments)) {
					return errorResponse(callId, -32602, "tools/call requires an object arguments value");
				}
				if (capturedToolCalls.length >= maxCapturedCalls) {
					return errorResponse(callId, -32603, "Tool call capture limit reached");
				}

				capturedToolCalls.push({
					arguments: callArguments as JsonObject,
					id: `acp-mcp-${capturedToolCalls.length}`,
					name,
					type: "toolCall",
				});
				return successResponse(callId, {
					content: [
						{
							text: "Tool call queued for host execution. End your current turn now and wait for the tool result.",
							type: "text",
						},
					],
					isError: false,
				});
			}
		},
	});

	const mcpServer: AcpMcpStdioServerConfig = {
		args: [STDIO_SHIM_PATH],
		command: process.execPath,
		env: {
			TSUKAIMA_ACP_MCP_TOKEN: token,
			TSUKAIMA_ACP_MCP_URL: server.url.toString(),
		},
		name: options.serverName ?? DEFAULT_SERVER_NAME,
	};

	return {
		close: async () => {
			if (closed) return;
			closed = true;
			await server.stop(true);
		},
		getToolCalls: () => [...capturedToolCalls],
		mcpServer,
	};
}

function successResponse(id: unknown, result: unknown): Response {
	return Response.json({ id: id ?? null, jsonrpc: "2.0", result });
}

function errorResponse(id: unknown, code: number, message: string): Response {
	return Response.json({ error: { code, message }, id: id ?? null, jsonrpc: "2.0" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is string | number | null {
	return value === null || typeof value === "string" || typeof value === "number";
}
