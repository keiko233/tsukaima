import {
	mcpServerCreateSchema,
	mcpServerIdInputSchema,
	mcpServerToggleInputSchema,
	mcpServerUpdateSchema,
} from "@tsukaima/contracts";
import type { PluginContext, PluginTool, ToolInvocationContext, ToolResult } from "@tsukaima/sdk";
import { z } from "zod";
import {
	MCP_INSTALL_SERVER_MODEL_NAME,
	MCP_INSTALL_SERVER_TOOL,
	MCP_LIST_SERVERS_MODEL_NAME,
	MCP_LIST_SERVERS_TOOL,
	MCP_RECONNECT_SERVER_MODEL_NAME,
	MCP_RECONNECT_SERVER_TOOL,
	MCP_REMOVE_SERVER_MODEL_NAME,
	MCP_REMOVE_SERVER_TOOL,
	MCP_TOGGLE_SERVER_MODEL_NAME,
	MCP_TOGGLE_SERVER_TOOL,
	MCP_UPDATE_SERVER_MODEL_NAME,
	MCP_UPDATE_SERVER_TOOL,
} from "./manifest.ts";
import type { McpManager } from "./service.ts";

export const MCP_ADMIN_TOOL_NAMES = [
	MCP_LIST_SERVERS_TOOL,
	MCP_INSTALL_SERVER_TOOL,
	MCP_UPDATE_SERVER_TOOL,
	MCP_TOGGLE_SERVER_TOOL,
	MCP_RECONNECT_SERVER_TOOL,
	MCP_REMOVE_SERVER_TOOL,
] as const;

const AUDIT_ACTION = "mcp.admin-tool";
const POLICY = {
	lazy: true,
	maxConcurrent: 4,
	surface: "both",
	timeoutMs: 60_000,
	visibility: "model",
} as const;

export interface McpToolsOptions {
	readonly onChanged?: () => Promise<void> | void;
}

const text = (value: unknown): ToolResult => ({
	content: [{ text: typeof value === "string" ? value : JSON.stringify(value), type: "text" }],
});

/** Fail-closed runtime gate shared by every MCP management tool. */
export function isAdminMcpCaller(invocation: ToolInvocationContext): boolean {
	const kind = invocation.chatKind;
	if (kind === "webui" || kind === "workspace") return true;
	if ((kind === "private" || kind === "group") && invocation.isAdmin === true) {
		return invocation.senderPlatformId !== undefined;
	}
	return false;
}

function callerIdentity(invocation: ToolInvocationContext): Record<string, unknown> {
	return {
		...(invocation.chatKind === undefined ? {} : { chatKind: invocation.chatKind }),
		...(invocation.conversationId === undefined
			? {}
			: { conversationId: invocation.conversationId }),
		...(invocation.senderPlatformId === undefined
			? {}
			: { senderPlatformId: invocation.senderPlatformId }),
		...(invocation.isAdmin === undefined ? {} : { isAdmin: invocation.isAdmin }),
	};
}

/** Audit-safe view of a server input: identifiers and transport kind, never secret values. */
function serverInputSummary(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null) return {};
	const record = input as Record<string, unknown>;
	const transport =
		typeof record.transport === "object" && record.transport !== null
			? (record.transport as Record<string, unknown>)
			: undefined;
	return {
		...(typeof record.id === "string" ? { id: record.id } : {}),
		...(typeof record.name === "string" ? { name: record.name } : {}),
		...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
		...(typeof transport?.type === "string" ? { transport: transport.type } : {}),
	};
}

export function createMcpTools(
	context: PluginContext,
	manager: McpManager,
	options: McpToolsOptions = {},
): PluginTool[] {
	const audit = async (entry: Parameters<NonNullable<PluginContext["audit"]>["record"]>[0]) => {
		try {
			await context.audit?.record(entry);
		} catch {}
	};

	const tool = <Input>(config: {
		readonly description: string;
		readonly modelName: string;
		readonly mutates: boolean;
		readonly name: string;
		readonly parameters: Record<string, unknown>;
		readonly parse: (raw: unknown) => Input;
		readonly run: (current: McpManager, input: Input) => Promise<unknown>;
		readonly summary: (input: Input) => Record<string, unknown>;
	}): PluginTool => ({
		description: config.description,
		modelName: config.modelName,
		async execute(raw, invocation) {
			const caller = callerIdentity(invocation);
			if (!isAdminMcpCaller(invocation)) {
				await audit({
					action: AUDIT_ACTION,
					...(invocation.senderPlatformId === undefined
						? {}
						: { actorId: invocation.senderPlatformId }),
					actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
					payload: { ...caller, operation: config.name, reason: "admin_required" },
					reason: "admin_required",
					result: "denied",
					targetKind: "mcp-server",
				});
				return text({ error: "admin_required" });
			}
			let parsed: Input;
			try {
				parsed = config.parse(raw);
			} catch {
				await audit({
					action: AUDIT_ACTION,
					...(invocation.senderPlatformId === undefined
						? {}
						: { actorId: invocation.senderPlatformId }),
					actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
					payload: { ...caller, operation: config.name, reason: "invalid_input" },
					reason: "invalid_input",
					result: "failed",
					targetKind: "mcp-server",
				});
				return text({ error: "invalid_input" });
			}
			const summary = config.summary(parsed);
			try {
				const result = await config.run(manager, parsed);
				if (config.mutates) await options.onChanged?.();
				await audit({
					action: AUDIT_ACTION,
					...(invocation.senderPlatformId === undefined
						? {}
						: { actorId: invocation.senderPlatformId }),
					actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
					payload: { ...caller, operation: config.name, ...summary },
					result: "ok",
					...(typeof summary.id === "string" ? { targetId: summary.id } : {}),
					targetKind: "mcp-server",
				});
				return text(result);
			} catch (error) {
				const reason = error instanceof z.ZodError ? "invalid_input" : "operation_failed";
				await audit({
					action: AUDIT_ACTION,
					...(invocation.senderPlatformId === undefined
						? {}
						: { actorId: invocation.senderPlatformId }),
					actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
					payload: { ...caller, operation: config.name, ...summary, reason },
					reason,
					result: "failed",
					...(typeof summary.id === "string" ? { targetId: summary.id } : {}),
					targetKind: "mcp-server",
				});
				return text({ error: reason });
			}
		},
		name: config.name,
		parameters: config.parameters,
		policy: POLICY,
		requiredPermissions: ["tools"],
	});

	return [
		tool({
			description:
				"List configured MCP servers with masked secret placeholders, connection state, and discovered tools.",
			modelName: MCP_LIST_SERVERS_MODEL_NAME,
			mutates: false,
			name: MCP_LIST_SERVERS_TOOL,
			parameters: { properties: {}, type: "object" },
			parse: () => undefined,
			run: async (current) => ({ servers: current.list() }),
			summary: () => ({}),
		}),
		tool({
			description:
				"Install an MCP server. Provide the same fields as the MCP settings form; secret env/header values are stored masked.",
			modelName: MCP_INSTALL_SERVER_MODEL_NAME,
			mutates: true,
			name: MCP_INSTALL_SERVER_TOOL,
			parameters: z.toJSONSchema(mcpServerCreateSchema),
			parse: (raw) => mcpServerCreateSchema.parse(raw),
			run: async (current, input) => await current.create(input),
			summary: serverInputSummary,
		}),
		tool({
			description:
				"Update an MCP server by id. Omitted fields stay unchanged; an empty tool filter clears it.",
			modelName: MCP_UPDATE_SERVER_MODEL_NAME,
			mutates: true,
			name: MCP_UPDATE_SERVER_TOOL,
			parameters: z.toJSONSchema(mcpServerUpdateSchema),
			parse: (raw) => mcpServerUpdateSchema.parse(raw),
			run: async (current, input) => await current.update(input),
			summary: serverInputSummary,
		}),
		tool({
			description: "Enable or disable one MCP server by id and reconnect it accordingly.",
			modelName: MCP_TOGGLE_SERVER_MODEL_NAME,
			mutates: true,
			name: MCP_TOGGLE_SERVER_TOOL,
			parameters: z.toJSONSchema(mcpServerToggleInputSchema),
			parse: (raw) => mcpServerToggleInputSchema.parse(raw),
			run: async (current, input) => await current.toggle(input.id, input.enabled),
			summary: serverInputSummary,
		}),
		tool({
			description: "Reconnect one MCP server by id.",
			modelName: MCP_RECONNECT_SERVER_MODEL_NAME,
			mutates: true,
			name: MCP_RECONNECT_SERVER_TOOL,
			parameters: z.toJSONSchema(mcpServerIdInputSchema),
			parse: (raw) => mcpServerIdInputSchema.parse(raw),
			run: async (current, input) => await current.reconnect(input.id),
			summary: serverInputSummary,
		}),
		tool({
			description: "Remove one MCP server by id and disconnect it.",
			modelName: MCP_REMOVE_SERVER_MODEL_NAME,
			mutates: true,
			name: MCP_REMOVE_SERVER_TOOL,
			parameters: z.toJSONSchema(mcpServerIdInputSchema),
			parse: (raw) => mcpServerIdInputSchema.parse(raw),
			run: async (current, input) => await current.delete(input.id),
			summary: serverInputSummary,
		}),
	];
}

export function registerMcpTools(
	context: PluginContext,
	manager: McpManager,
	options: McpToolsOptions = {},
): void {
	for (const entry of createMcpTools(context, manager, options)) {
		context.tools.register(entry);
	}
}
