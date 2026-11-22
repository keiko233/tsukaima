import type { ConversationPolicy } from "@tsukaima/contracts";
import {
	pluginManifestSchema,
	providerSafeToolName,
	type PluginContext,
	type PluginLogger,
	type PluginTool,
	type ToolInvocationContext,
	type ToolResult,
	type TsukaimaPlugin,
} from "@tsukaima/sdk";
import { previewText } from "../logging.ts";
import {
	CHAT_HISTORY_KINDS,
	CHAT_HISTORY_SERVICE_BINDING,
	type ChatHistoryDenial,
	type ChatHistoryKind,
	type ChatHistoryMessage,
	type ChatHistoryService,
	type ChatHistorySession,
} from "../services/chat-history-service.ts";

const SESSION_LIMIT_MAX = 30;
const SESSION_LIMIT_DEFAULT = 15;
const SEARCH_LIMIT_MAX = 30;
const SEARCH_LIMIT_DEFAULT = 15;
const READ_LIMIT_MAX = 50;
const READ_LIMIT_DEFAULT = 20;
const SEARCH_SNIPPET_CHARS = 300;
const READ_SNIPPET_CHARS = 500;
const MAX_PREVIEW_LENGTH = 120;

function toolsLogger(context: PluginContext): PluginLogger {
	return context.logger.child?.("tools") ?? context.logger;
}

function preview(value: string | undefined): string | undefined {
	return value === undefined ? undefined : previewText(value, MAX_PREVIEW_LENGTH);
}

function elapsedMs(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}

function text(value: string): ToolResult {
	return { content: [{ text: value, type: "text" }] };
}

function inputString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function inputNumber(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inputKind(input: Record<string, unknown>): ChatHistoryKind | undefined {
	const value = input.kind;
	return typeof value === "string" && (CHAT_HISTORY_KINDS as readonly string[]).includes(value)
		? (value as ChatHistoryKind)
		: undefined;
}

function allowlistMatches(toolName: string, allowlist: readonly string[]): boolean {
	const cleanSafe = providerSafeToolName(toolName);
	return allowlist.some((entry) => {
		if (entry === "*" || entry === toolName || entry === cleanSafe) return true;
		if (entry.endsWith(".*")) return toolName.startsWith(`${entry.slice(0, -2)}.`);
		return false;
	});
}

interface ResolvedHistoryTool {
	readonly policy: ConversationPolicy;
	readonly service: ChatHistoryService;
	readonly session: { id: string; kind: string };
}

async function resolveHistoryTool(
	context: PluginContext,
	log: PluginLogger,
	invocation: ToolInvocationContext,
	toolName: string,
): Promise<ResolvedHistoryTool | string> {
	const service = context.dependencies?.get<ChatHistoryService>(CHAT_HISTORY_SERVICE_BINDING);
	const durableConversationId = invocation.conversationId;
	if (service === undefined) {
		log.warn("history tool denied", {
			conversationId: durableConversationId,
			reason: "service_unavailable",
			tool: toolName,
		});
		return "Chat history service is not available.";
	}
	if (durableConversationId === undefined) {
		log.warn("history tool denied", { reason: "conversation_missing", tool: toolName });
		return "Chat history tools require a conversation.";
	}
	const session = await service.sessionByDurableId(durableConversationId);
	if (session === undefined) {
		log.warn("history tool denied", {
			conversationId: durableConversationId,
			reason: "session_missing",
			tool: toolName,
		});
		return "Conversation not found.";
	}
	// Workspace coding sessions are an isolated execution surface: repository agents must not
	// read chat transcripts. Other non-chat surfaces (task, plugin) are denied by the same rule.
	if (session.kind === "workspace") {
		log.warn("history tool denied", {
			conversationId: durableConversationId,
			reason: "workspace_surface",
			sessionId: session.id,
			tool: toolName,
		});
		return "Chat history tools are not available in workspace sessions.";
	}
	if (!(CHAT_HISTORY_KINDS as readonly string[]).includes(session.kind)) {
		log.warn("history tool denied", {
			conversationId: durableConversationId,
			reason: "not_chat_surface",
			sessionId: session.id,
			tool: toolName,
		});
		return "Chat history tools are not available in this session.";
	}
	const policy = await service.policyForConversation(session.id);
	if (policy === undefined) {
		log.warn("history tool denied", {
			conversationId: durableConversationId,
			reason: "policy_missing",
			sessionId: session.id,
			tool: toolName,
		});
		return "Conversation policy not available.";
	}
	const allowedTools = policy.pacing.allowedTools;
	if (allowedTools !== undefined && !allowlistMatches(toolName, allowedTools)) {
		log.warn("history tool denied", {
			conversationId: durableConversationId,
			reason: "conversation_tool_denied",
			sessionId: session.id,
			tool: toolName,
		});
		await context.audit?.record({
			action: "history.tool.denied",
			actorKind: "agent",
			payload: { conversationId: session.id, reason: "conversation_tool_denied", tool: toolName },
			result: "denied",
			targetKind: "history",
		});
		return "Chat history tools are not allowed in this conversation.";
	}
	return { policy, service, session };
}

function formatTimestamp(iso: string): string {
	const timestamp = Date.parse(iso);
	const value = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : iso;
	return value.slice(0, 16).replace("T", " ");
}

function truncate(value: string, limit: number): string {
	const singleLine = value.replace(/\s+/gu, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}…`;
}

function sessionLabel(session: ChatHistorySession): string {
	if (session.redacted) return `${session.kind} (title hidden)`;
	return `${session.kind} "${session.title ?? "(untitled)"}"`;
}

function searchTargetLabel(message: ChatHistoryMessage): string {
	if (message.redacted) return `${message.sessionKind} (content hidden)`;
	return `${message.sessionKind} "${message.sessionTitle ?? "(untitled)"}"`;
}

function senderName(message: ChatHistoryMessage): string {
	if (message.senderDisplayName !== null) return message.senderDisplayName;
	if (message.senderExternalId !== null) return message.senderExternalId;
	if (message.senderUserId !== null) return message.senderUserId;
	if (message.direction === "outbound") return "assistant";
	if (message.direction === "system") return "system";
	return "unknown";
}

function denialText(denial: ChatHistoryDenial): string {
	return denial.message;
}

function formatSessions(sessions: readonly ChatHistorySession[]): string {
	if (sessions.length === 0) return "No chat sessions found.";
	return sessions
		.map(
			(session) =>
				`- [session:${session.id}] ${sessionLabel(session)} (updated ${formatTimestamp(session.updatedAt)})${session.redacted ? " [redacted]" : ""}`,
		)
		.join("\n");
}

function formatSearch(messages: readonly ChatHistoryMessage[]): string {
	if (messages.length === 0) return "No matching messages.";
	return messages
		.map((message) => {
			const prefix = `- [msg:${message.id}] [${formatTimestamp(message.occurredAt)}] [session:${message.sessionId}] ${searchTargetLabel(message)}`;
			if (message.redacted) return `${prefix} — content hidden by privacy policy`;
			return `${prefix} — ${senderName(message)}: ${truncate(message.contentText ?? "", SEARCH_SNIPPET_CHARS)}`;
		})
		.join("\n");
}

function formatRead(session: ChatHistorySession, messages: readonly ChatHistoryMessage[]): string {
	const header = `Session [session:${session.id}] ${sessionLabel(session)}`;
	if (messages.length === 0) return `${header}\nNo messages in that range.`;
	return [
		header,
		...messages.map(
			(message) =>
				`[${formatTimestamp(message.occurredAt)}] ${senderName(message)} [msg:${message.id}]: ${truncate(message.contentText ?? "", READ_SNIPPET_CHARS)}`,
		),
	].join("\n");
}

function sessionsTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description:
			"List or search accessible chat sessions (private, group, WebUI) by title/id. Use the returned [session:<id>] with history.search and history.read.",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const resolved = await resolveHistoryTool(context, log, invocation, "history.sessions");
			if (typeof resolved === "string") return text(resolved);
			const query = inputString(input, "query");
			const kind = inputKind(input);
			const limit = Math.min(
				SESSION_LIMIT_MAX,
				Math.max(1, inputNumber(input, "limit") ?? SESSION_LIMIT_DEFAULT),
			);
			log.trace("history.sessions start", {
				conversationId: invocation.conversationId,
				kind,
				limit,
				query: preview(query),
				sessionId: resolved.session.id,
			});
			const sessions = await resolved.service.listSessions(resolved.session.id, {
				...(kind === undefined ? {} : { kind }),
				limit,
				...(query === undefined ? {} : { query }),
			});
			log.debug("history.sessions complete", {
				conversationId: invocation.conversationId,
				durationMs: elapsedMs(startedAt),
				limit,
				resultCount: sessions.length,
				sessionId: resolved.session.id,
			});
			return text(formatSessions(sessions));
		},
		name: "history.sessions",
		parameters: {
			properties: {
				kind: {
					description: "Optional chat kind filter.",
					enum: [...CHAT_HISTORY_KINDS],
					type: "string",
				},
				limit: { maximum: SESSION_LIMIT_MAX, minimum: 1, type: "integer" },
				query: {
					description: "Optional case-insensitive substring on session title, id, or platform id.",
					type: "string",
				},
			},
			type: "object",
		},
		policy: { lazy: false, maxPayloadBytes: 16_384, surface: "chat", timeoutMs: 20_000 },
		requiredPermissions: ["history.read"],
	};
}

function searchTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description:
			"Search raw chat messages across accessible sessions or within one session by keywords, sender, kind, and time range. Returns [msg:<id>] hits for history.read.",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const resolved = await resolveHistoryTool(context, log, invocation, "history.search");
			if (typeof resolved === "string") return text(resolved);
			const query = inputString(input, "query");
			const sessionId = inputString(input, "sessionId");
			const sender = inputString(input, "sender");
			const kind = inputKind(input);
			const after = inputString(input, "after");
			const before = inputString(input, "before");
			const limit = Math.min(
				SEARCH_LIMIT_MAX,
				Math.max(1, inputNumber(input, "limit") ?? SEARCH_LIMIT_DEFAULT),
			);
			log.trace("history.search start", {
				after,
				before,
				conversationId: invocation.conversationId,
				kind,
				limit,
				query: preview(query),
				sender: preview(sender),
				sessionId: resolved.session.id,
				targetSessionId: sessionId,
			});
			const result = await resolved.service.searchMessages(resolved.session.id, {
				...(after === undefined ? {} : { after }),
				...(before === undefined ? {} : { before }),
				...(kind === undefined ? {} : { kind }),
				limit,
				...(query === undefined ? {} : { query }),
				...(sender === undefined ? {} : { sender }),
				...(sessionId === undefined ? {} : { sessionId }),
			});
			log.debug("history.search complete", {
				conversationId: invocation.conversationId,
				denied: result.denied?.reason,
				durationMs: elapsedMs(startedAt),
				limit,
				resultCount: result.messages.length,
				sessionId: resolved.session.id,
				targetSessionId: sessionId,
			});
			if (result.denied !== undefined) return text(denialText(result.denied));
			return text(formatSearch(result.messages));
		},
		name: "history.search",
		parameters: {
			properties: {
				after: {
					description: "Only messages at or after this ISO-8601 timestamp.",
					type: "string",
				},
				before: {
					description: "Only messages at or before this ISO-8601 timestamp.",
					type: "string",
				},
				kind: {
					description: "Optional chat kind filter.",
					enum: [...CHAT_HISTORY_KINDS],
					type: "string",
				},
				limit: { maximum: SEARCH_LIMIT_MAX, minimum: 1, type: "integer" },
				query: {
					description: "Keywords; whitespace-separated terms must all appear in the message text.",
					type: "string",
				},
				sender: {
					description: "Optional sender display name, external id, or user id substring.",
					type: "string",
				},
				sessionId: {
					description: "Optional [session:<id>] target; omit to search every accessible session.",
					type: "string",
				},
			},
			type: "object",
		},
		policy: { lazy: false, maxPayloadBytes: 16_384, surface: "chat", timeoutMs: 20_000 },
		requiredPermissions: ["history.read"],
	};
}

function readTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description:
			"Read chronological raw chat messages from the current or another accessible session, with aroundMessageId/before/after pagination.",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const resolved = await resolveHistoryTool(context, log, invocation, "history.read");
			if (typeof resolved === "string") return text(resolved);
			const sessionId = inputString(input, "sessionId");
			const before = inputString(input, "before");
			const after = inputString(input, "after");
			const aroundMessageId = inputString(input, "aroundMessageId");
			const limit = Math.min(
				READ_LIMIT_MAX,
				Math.max(1, inputNumber(input, "limit") ?? READ_LIMIT_DEFAULT),
			);
			log.trace("history.read start", {
				after,
				aroundMessageId,
				before,
				conversationId: invocation.conversationId,
				limit,
				sessionId: resolved.session.id,
				targetSessionId: sessionId,
			});
			const result = await resolved.service.readMessages(resolved.session.id, {
				...(after === undefined ? {} : { after }),
				...(aroundMessageId === undefined ? {} : { aroundMessageId }),
				...(before === undefined ? {} : { before }),
				limit,
				...(sessionId === undefined ? {} : { sessionId }),
			});
			log.debug("history.read complete", {
				conversationId: invocation.conversationId,
				denied: result.ok ? undefined : result.denied.reason,
				durationMs: elapsedMs(startedAt),
				limit,
				resultCount: result.ok ? result.messages.length : 0,
				sessionId: resolved.session.id,
				targetSessionId: sessionId,
			});
			if (!result.ok) return text(denialText(result.denied));
			return text(formatRead(result.session, result.messages));
		},
		name: "history.read",
		parameters: {
			properties: {
				after: {
					description:
						"ISO-8601 timestamp or [msg:<id>] cursor; returns messages strictly after it in chronological order.",
					type: "string",
				},
				aroundMessageId: {
					description: "Message id to center a window around.",
					type: "string",
				},
				before: {
					description:
						"ISO-8601 timestamp or [msg:<id>] cursor; returns messages strictly before it in chronological order.",
					type: "string",
				},
				limit: { maximum: READ_LIMIT_MAX, minimum: 1, type: "integer" },
				sessionId: {
					description: "Optional [session:<id>] target; omit to read the current session.",
					type: "string",
				},
			},
			type: "object",
		},
		policy: { lazy: false, maxPayloadBytes: 16_384, surface: "chat", timeoutMs: 20_000 },
		requiredPermissions: ["history.read"],
	};
}

/**
 * Built-in read-only chat history tools. Every call resolves the conversation policy first,
 * denies coding surfaces, and enforces the cross-session privacy rules in the domain service.
 */
export const chatHistoryPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "builtin",
		name: "history",
		permissions: ["history.read"],
		version: "0.1.0",
	}),
	setup(context) {
		const log = toolsLogger(context);
		const tools = [sessionsTool(context, log), searchTool(context, log), readTool(context, log)];
		for (const tool of tools) {
			context.tools.register(tool);
		}
		context.logger.info("history plugin ready", {
			count: tools.length,
			tools: tools.map((tool) => tool.name),
		});
	},
};
