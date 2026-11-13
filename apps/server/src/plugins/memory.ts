import type { ConversationPolicy, MemoryScope, MemoryStatus } from "@tsukaima/contracts";
import {
	pluginManifestSchema,
	type TsukaimaPlugin,
	type PluginContext,
	type PluginTool,
	type ToolInvocationContext,
	type ToolResult,
} from "@tsukaima/sdk";
import type { MemoryService } from "../services/memory-service.ts";
import { MEMORY_SERVICE_BINDING } from "../services/memory-service.ts";

const MAX_RECALL_LIMIT = 20;

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

function inputScope(input: Record<string, unknown>): MemoryScope | undefined {
	const value = input.scope;
	return value === "global" ||
		value === "persona" ||
		value === "user" ||
		value === "conversation" ||
		value === "project" ||
		value === "ephemeral"
		? value
		: undefined;
}

interface ResolvedMemoryTool {
	readonly policy: ConversationPolicy;
	readonly service: MemoryService;
	readonly session: { id: string; kind: string };
}

function allowlistMatches(toolName: string, allowlist: readonly string[]): boolean {
	return allowlist.some((entry) => {
		if (entry === "*" || entry === toolName) return true;
		if (entry.endsWith(".*")) return toolName.startsWith(`${entry.slice(0, -2)}.`);
		return false;
	});
}

async function resolveMemoryTool(
	context: PluginContext,
	invocation: ToolInvocationContext,
	toolName: string,
): Promise<ResolvedMemoryTool | string> {
	const service = context.dependencies?.get<MemoryService>(MEMORY_SERVICE_BINDING);
	if (service === undefined) return "Memory service is not available.";
	const durableConversationId = invocation.conversationId;
	if (durableConversationId === undefined) return "Memory tools require a conversation.";
	const session = await service.sessionByDurableId(durableConversationId);
	if (session === undefined) return "Conversation not found.";
	const policy = await service.policyForConversation(session.id);
	if (policy === undefined) return "Conversation policy not available.";
	const allowedTools = policy.pacing.allowedTools;
	if (allowedTools !== undefined && !allowlistMatches(toolName, allowedTools)) {
		await context.audit?.record({
			action: "memory.tool.denied",
			actorKind: "agent",
			payload: { conversationId: session.id, reason: "conversation_tool_denied", tool: toolName },
			result: "denied",
			targetKind: "memory",
		});
		return "Memory tools are not allowed in this conversation.";
	}
	if (policy.memoryEnabled === false) {
		await context.audit?.record({
			action: "memory.tool.denied",
			actorKind: "agent",
			payload: { conversationId: session.id, reason: "memory_disabled", tool: toolName },
			result: "denied",
			targetKind: "memory",
		});
		return "Memory is disabled for this conversation.";
	}
	return { policy, service, session };
}

function ownedBySession(
	memory: { conversationId: string | null; scope: string },
	sessionId: string,
): boolean {
	return memory.conversationId === null || memory.conversationId === sessionId;
}

function effectiveWrite(
	resolved: ResolvedMemoryTool,
	requestedScope: MemoryScope | undefined,
): { scope: MemoryScope; status: MemoryStatus } {
	const sharedContext = resolved.session.kind === "group";
	const sharedWrites = sharedContext && resolved.policy.sharedMemoryWriteEnabled !== false;
	const reviewRequired =
		resolved.policy.memoryReviewRequired === true ||
		(sharedContext && resolved.policy.sharedMemoryWriteEnabled === false);
	const scope: MemoryScope = sharedWrites
		? (requestedScope ?? "global")
		: requestedScope === "global" || requestedScope === "persona"
			? "conversation"
			: (requestedScope ?? "conversation");
	return { scope, status: reviewRequired ? "pending" : "active" };
}

function recallTool(context: PluginContext): PluginTool {
	return {
		description: "Recall relevant long-term memories for this conversation.",
		execute: async (input, invocation) => {
			const resolved = await resolveMemoryTool(context, invocation, "memory.recall");
			if (typeof resolved === "string") return text(resolved);
			const query = inputString(input, "query") ?? "";
			const requested = inputNumber(input, "limit");
			const limit = Math.min(MAX_RECALL_LIMIT, Math.max(1, requested ?? 8));
			const ranked = await resolved.service.recordSearch(resolved.session.id, query, limit * 2);
			const visible = ranked
				.filter(
					(entry) =>
						resolved.policy.sharedMemoryEnabled !== false || entry.memory.visibility !== "shared",
				)
				.slice(0, limit);
			if (visible.length === 0) return text("No relevant memories.");
			return text(
				visible
					.map(
						(entry) =>
							`- [${entry.memory.scope}/${entry.memory.kind}] ${entry.memory.summary.slice(0, 240)}`,
					)
					.join("\n"),
			);
		},
		name: "memory.recall",
		parameters: {
			properties: {
				limit: { maximum: MAX_RECALL_LIMIT, minimum: 1, type: "integer" },
				query: { type: "string" },
			},
			type: "object",
		},
		policy: { maxPayloadBytes: 8_192, timeoutMs: 20_000 },
		requiredPermissions: ["memory.read"],
	};
}

function saveTool(context: PluginContext): PluginTool {
	return {
		description:
			"Save a durable memory (preference, fact, person, todo, event, setting, or summary).",
		execute: async (input, invocation) => {
			const resolved = await resolveMemoryTool(context, invocation, "memory.save");
			if (typeof resolved === "string") return text(resolved);
			const summary = inputString(input, "summary");
			if (summary === undefined) return text("summary is required");
			const kind = inputString(input, "kind") ?? "fact";
			const requestedScope = inputScope(input);
			const target = effectiveWrite(resolved, requestedScope);
			const result = await resolved.service.create({
				confidence: Math.min(1, Math.max(0, inputNumber(input, "confidence") ?? 0.7)),
				content: inputString(input, "content") ?? summary,
				...(target.scope === "conversation" ? { conversationId: resolved.session.id } : {}),
				createdBy: "agent",
				...(inputString(input, "expiresAt") === undefined
					? {}
					: { expiresAt: inputString(input, "expiresAt") }),
				importance: Math.min(1, Math.max(0, inputNumber(input, "importance") ?? 0.5)),
				kind,
				scope: target.scope,
				status: target.status,
				summary,
				...(target.scope === "global" ? { visibility: "shared" } : { visibility: "private" }),
			});
			return text(
				`Memory ${result.merged ? "merged" : "saved"}: ${result.memory.id} (${result.memory.scope}/${result.memory.kind}, ${result.memory.status})`,
			);
		},
		name: "memory.save",
		parameters: {
			properties: {
				confidence: { maximum: 1, minimum: 0, type: "number" },
				content: { type: "string" },
				expiresAt: { type: "string" },
				importance: { maximum: 1, minimum: 0, type: "number" },
				kind: { type: "string" },
				scope: {
					enum: ["global", "persona", "user", "conversation", "project", "ephemeral"],
					type: "string",
				},
				summary: { type: "string" },
			},
			required: ["summary"],
			type: "object",
		},
		policy: { maxPayloadBytes: 16_384, timeoutMs: 20_000 },
		requiredPermissions: ["memory.write"],
	};
}

function updateTool(context: PluginContext): PluginTool {
	return {
		description: "Update a durable memory owned by this conversation.",
		execute: async (input, invocation) => {
			const resolved = await resolveMemoryTool(context, invocation, "memory.update");
			if (typeof resolved === "string") return text(resolved);
			const id = inputString(input, "id");
			if (id === undefined) return text("id is required");
			const existing = await resolved.service.get(id);
			if (existing === undefined) return text("Memory not found.");
			if (!ownedBySession(existing, resolved.session.id)) {
				return text("That memory belongs to another conversation.");
			}
			if (
				(existing.scope === "global" || existing.scope === "persona") &&
				resolved.session.kind === "group" &&
				resolved.policy.sharedMemoryWriteEnabled === false
			) {
				return text("Shared memory writes are disabled for this conversation.");
			}
			const summary = inputString(input, "summary");
			if (summary !== undefined) {
				const result = await resolved.service.update({
					...(inputString(input, "content") === undefined
						? {}
						: { content: inputString(input, "content") }),
					confidence: Math.min(
						1,
						Math.max(0, inputNumber(input, "confidence") ?? existing.confidence),
					),
					...(inputString(input, "expiresAt") === undefined
						? {}
						: { expiresAt: inputString(input, "expiresAt") }),
					id,
					importance: Math.min(
						1,
						Math.max(0, inputNumber(input, "importance") ?? existing.importance),
					),
					...(inputString(input, "kind") === undefined ? {} : { kind: inputString(input, "kind") }),
					summary,
				});
				return text(`Memory updated: ${result.id} (${result.status})`);
			}
			return text("summary is required for memory.update");
		},
		name: "memory.update",
		parameters: {
			properties: {
				confidence: { maximum: 1, minimum: 0, type: "number" },
				content: { type: "string" },
				expiresAt: { type: "string" },
				id: { type: "string" },
				importance: { maximum: 1, minimum: 0, type: "number" },
				kind: { type: "string" },
				summary: { type: "string" },
			},
			required: ["id", "summary"],
			type: "object",
		},
		policy: { maxPayloadBytes: 16_384, timeoutMs: 20_000 },
		requiredPermissions: ["memory.write"],
	};
}

function forgetTool(context: PluginContext): PluginTool {
	return {
		description: "Forget a durable memory owned by this conversation (tombstone retained).",
		execute: async (input, invocation) => {
			const resolved = await resolveMemoryTool(context, invocation, "memory.forget");
			if (typeof resolved === "string") return text(resolved);
			const id = inputString(input, "id");
			if (id === undefined) return text("id is required");
			const existing = await resolved.service.get(id);
			if (existing === undefined) return text("Memory not found.");
			if (!ownedBySession(existing, resolved.session.id)) {
				return text("That memory belongs to another conversation.");
			}
			if (
				(existing.scope === "global" || existing.scope === "persona") &&
				resolved.session.kind === "group" &&
				resolved.policy.sharedMemoryWriteEnabled === false
			) {
				return text("Shared memory writes are disabled for this conversation.");
			}
			const result = await resolved.service.revoke(id);
			return text(`Memory forgotten: ${result.id}`);
		},
		name: "memory.forget",
		parameters: {
			properties: { id: { type: "string" } },
			required: ["id"],
			type: "object",
		},
		policy: { destructive: true, maxPayloadBytes: 2_048, timeoutMs: 20_000 },
		requiredPermissions: ["memory.write"],
	};
}

/**
 * Built-in memory tools. The manifest is namespaced `memory.*`; every call resolves the
 * conversation policy first, so model access cannot bypass `memoryEnabled`,
 * `sharedMemoryWriteEnabled`, or the tool allowlist enforced by the plugin-host adapter.
 */
export const memoryPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "builtin",
		name: "memory",
		permissions: ["memory.read", "memory.write"],
		version: "0.1.0",
	}),
	setup(context) {
		for (const tool of [
			recallTool(context),
			saveTool(context),
			updateTool(context),
			forgetTool(context),
		]) {
			context.tools.register(tool);
		}
	},
};
