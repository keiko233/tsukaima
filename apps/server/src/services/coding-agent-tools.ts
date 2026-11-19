import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { WorkspaceTodoStatus } from "@tsukaima/contracts";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { SessionMessagingService } from "./session-messaging.ts";
import type { WorkspaceReferenceService } from "./workspace-references.ts";
import type { WorkspaceSqlService } from "./workspace-sql.ts";
import type { WorkspaceTodoService } from "./workspace-todos.ts";

export const CODING_AGENT_TOOLS_EXTENSION_NAME = "tsukaima-coding-agent-tools";
export const CODING_AGENT_TOOL_NAMES = [
	"session_context",
	"todo_write",
	"todo_list",
	"db_schema",
	"db_query",
] as const;

export interface CodingAgentToolsOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly logger: Logger;
	readonly messaging: SessionMessagingService;
	readonly references: WorkspaceReferenceService;
	readonly resolveSessionId: (durableConversationId: string) => Promise<string | undefined>;
	readonly sql: WorkspaceSqlService;
	readonly todos: WorkspaceTodoService;
}

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function text(value: unknown): { output: { text: string; type: "text" }[] } {
	return {
		output: [
			{
				text: typeof value === "string" ? value : JSON.stringify(value),
				type: "text",
			},
		],
	};
}

function failure(error: unknown): {
	isError: true;
	output: { text: string; type: "text" }[];
} {
	return {
		isError: true,
		output: [
			{
				text: JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				type: "text",
			},
		],
	};
}

function stringValue(
	input: Record<string, unknown>,
	key: string,
	required = false,
): string | undefined {
	const value = input[key];
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (required) throw new Error(`${key} is required`);
	return undefined;
}

function todoStatus(value: unknown): WorkspaceTodoStatus {
	return value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "cancelled"
		? value
		: "pending";
}

function tool(input: {
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: string;
	readonly parameters: Record<string, unknown>;
}): DurableToolRegistration {
	return {
		deferred: true,
		description: input.description,
		execute: input.execute,
		name: input.name,
		parameters: input.parameters,
		surface: "coding",
	};
}

/**
 * Coding-agent-only tools. Visibility is filtered by the lifecycle so chat, IM, task, and plugin
 * conversations never receive them even though the extension is installed process-wide.
 */
export function createCodingAgentToolsExtension(
	options: CodingAgentToolsOptions,
): DurableExtension {
	const resolveCurrentSession = async (durableConversationId: string): Promise<string> => {
		const sessionId = await options.resolveSessionId(durableConversationId);
		if (sessionId === undefined) {
			throw new Error("Current session is not mapped to a domain session");
		}
		return sessionId;
	};
	const run = async (
		name: string,
		conversationId: string,
		body: () => Promise<unknown>,
	): Promise<
		| { output: { text: string; type: "text" }[] }
		| { isError: true; output: { text: string; type: "text" }[] }
	> => {
		try {
			const result = await body();
			await options.audit?.({
				action: `coding-tool.${name}`,
				actorKind: "agent",
				payload: { conversationId },
				result: "ok",
				targetKind: "coding-tool",
			});
			return text(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await options.audit?.({
				action: `coding-tool.${name}`,
				actorKind: "agent",
				payload: { conversationId },
				reason: message,
				result: "failed",
				targetKind: "coding-tool",
			});
			options.logger.warn("coding tool failed", { conversationId, error: message, tool: name });
			return failure(error);
		}
	};

	const sessionContext = tool({
		description:
			"Read bounded context from a conversation the user referenced in this turn. Only sessions explicitly selected with @ are allowed.",
		name: "session_context",
		parameters: {
			properties: {
				messageId: { type: "string" },
				sessionId: { type: "string" },
			},
			required: ["sessionId"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return run("session_context", String(api.conversationId), async () => {
				const currentSessionId = await resolveCurrentSession(String(api.conversationId));
				const references = await options.references.list(currentSessionId);
				const sessionId = stringValue(input, "sessionId", true)!;
				if (!references.some((reference) => reference.sessionId === sessionId)) {
					throw new Error("Session is not referenced by this workspace");
				}
				const rendered = await options.references.render(currentSessionId, [
					{
						...(stringValue(input, "messageId") === undefined
							? {}
							: { messageId: stringValue(input, "messageId")! }),
						sessionId,
					},
				]);
				return { context: rendered ?? "", sessionId };
			});
		},
	});

	const writeTodos = tool({
		description:
			"Replace the workspace todo list. Use this to keep a multi-step coding plan visible; at most one item may be in_progress.",
		name: "todo_write",
		parameters: {
			properties: {
				items: {
					items: {
						properties: {
							content: { type: "string" },
							status: {
								enum: ["pending", "in_progress", "completed", "cancelled"],
								type: "string",
							},
						},
						required: ["content"],
						type: "object",
					},
					type: "array",
				},
			},
			required: ["items"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return run("todo_write", String(api.conversationId), async () => {
				const sessionId = await resolveCurrentSession(String(api.conversationId));
				const items = Array.isArray(input.items) ? input.items : [];
				return {
					todos: await options.todos.replace(
						sessionId,
						items.map((item) => {
							const value = record(item);
							return {
								content: stringValue(value, "content", true)!,
								status: todoStatus(value.status),
							};
						}),
					),
				};
			});
		},
	});

	const listTodos = tool({
		description: "Read the current workspace todo list.",
		name: "todo_list",
		parameters: { properties: {}, type: "object" },
		async execute(_args, api) {
			return run("todo_list", String(api.conversationId), async () => {
				const sessionId = await resolveCurrentSession(String(api.conversationId));
				return { todos: await options.todos.list(sessionId) };
			});
		},
	});

	const schema = tool({
		description:
			"Inspect the allowlisted domain database schema. Call this before writing a db_query.",
		name: "db_schema",
		parameters: {
			properties: { table: { type: "string" } },
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return run("db_schema", String(api.conversationId), async () =>
				options.sql.schema(stringValue(input, "table")),
			);
		},
	});

	const query = tool({
		description:
			"Run one read-only SELECT/WITH (or EXPLAIN QUERY PLAN) query against allowlisted workspace, coding, audit, schedule, and prompt-hook tables. Results are capped at 500 rows and 256 KiB. EXPLAIN QUERY PLAN requires no FROM clause.",
		name: "db_query",
		parameters: {
			properties: {
				params: { items: {}, type: "array" },
				sql: { type: "string" },
			},
			required: ["sql"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return run("db_query", String(api.conversationId), async () =>
				options.sql.query({
					...(Array.isArray(input.params) ? { params: input.params } : {}),
					sql: stringValue(input, "sql", true)!,
				}),
			);
		},
	});

	return {
		name: CODING_AGENT_TOOLS_EXTENSION_NAME,
		tools: [sessionContext, writeTodos, listTodos, schema, query],
	};
}
