import type { ConversationPolicy, MemoryScope, MemoryStatus } from "@tsukaima/contracts";
import {
	pluginManifestSchema,
	providerSafeToolName,
	type TsukaimaPlugin,
	type PluginContext,
	type PluginLogger,
	type PluginTool,
	type ToolInvocationContext,
	type ToolResult,
} from "@tsukaima/sdk";
import { previewText } from "../logging.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { MEMORY_SERVICE_BINDING } from "../services/memory-service.ts";

const MAX_RECALL_LIMIT = 20;
const MAX_PREVIEW_LENGTH = 120;

/**
 * Plugin tools log under `tsukaima::plugin::memory::tools`; `child` is optional in the SDK,
 * so fall back to the plugin-scoped logger when a host does not provide it.
 */
function toolsLogger(context: PluginContext): PluginLogger {
	return context.logger.child?.("tools") ?? context.logger;
}

/** Bounded single-line preview for `trace` fields; never log raw multiline content. */
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
	const cleanSafe = providerSafeToolName(toolName);
	return allowlist.some((entry) => {
		if (entry === "*" || entry === toolName || entry === cleanSafe) return true;
		if (entry.endsWith(".*")) return toolName.startsWith(`${entry.slice(0, -2)}.`);
		return false;
	});
}

async function resolveMemoryTool(
	context: PluginContext,
	log: PluginLogger,
	invocation: ToolInvocationContext,
	toolName: string,
): Promise<ResolvedMemoryTool | string> {
	const service = context.dependencies?.get<MemoryService>(MEMORY_SERVICE_BINDING);
	const durableConversationId = invocation.conversationId;
	if (service === undefined) {
		log.warn("memory tool denied", {
			conversationId: durableConversationId,
			reason: "service_unavailable",
			tool: toolName,
		});
		return "Memory service is not available.";
	}
	if (durableConversationId === undefined) {
		log.warn("memory tool denied", { reason: "conversation_missing", tool: toolName });
		return "Memory tools require a conversation.";
	}
	const session = await service.sessionByDurableId(durableConversationId);
	if (session === undefined) {
		log.warn("memory tool denied", {
			conversationId: durableConversationId,
			reason: "session_missing",
			tool: toolName,
		});
		return "Conversation not found.";
	}
	// Workspace coding sessions are an isolated execution surface: chat memories (especially
	// shared global/user rows) must not leak into a repository-mutating agent's tool context.
	if (session.kind === "workspace") {
		log.warn("memory tool denied", {
			conversationId: durableConversationId,
			reason: "workspace_surface",
			sessionId: session.id,
			tool: toolName,
		});
		return "Memory tools are not available in workspace sessions.";
	}
	const policy = await service.policyForConversation(session.id);
	if (policy === undefined) {
		log.warn("memory tool denied", {
			conversationId: durableConversationId,
			reason: "policy_missing",
			sessionId: session.id,
			tool: toolName,
		});
		return "Conversation policy not available.";
	}
	const allowedTools = policy.pacing.allowedTools;
	if (allowedTools !== undefined && !allowlistMatches(toolName, allowedTools)) {
		log.warn("memory tool denied", {
			conversationId: durableConversationId,
			reason: "conversation_tool_denied",
			sessionId: session.id,
			tool: toolName,
		});
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
		log.warn("memory tool denied", {
			conversationId: durableConversationId,
			reason: "memory_disabled",
			sessionId: session.id,
			tool: toolName,
		});
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
	const sharedWritesAllowed = resolved.policy.sharedMemoryWriteEnabled !== false;
	const reviewRequired =
		resolved.policy.memoryReviewRequired === true || (sharedContext && !sharedWritesAllowed);
	const defaultScope: MemoryScope =
		sharedContext && sharedWritesAllowed ? "global" : "conversation";
	const scope: MemoryScope = sharedWritesAllowed
		? (requestedScope ?? defaultScope)
		: requestedScope === "global" || requestedScope === "persona"
			? "conversation"
			: (requestedScope ?? "conversation");
	return { scope, status: reviewRequired ? "pending" : "active" };
}

function recallTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description:
			"Proactively query long-term memories (facts, persona notes, learned memes/glossary, preferences, people) by keywords and/or kind/scope. Returns matching memory IDs for update or deletion.",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const query = inputString(input, "query") ?? "";
			const kind = inputString(input, "kind");
			const scope = inputScope(input);
			const requested = inputNumber(input, "limit");
			const limit = Math.min(MAX_RECALL_LIMIT, Math.max(1, requested ?? 8));
			const resolved = await resolveMemoryTool(context, log, invocation, "memory.recall");
			if (typeof resolved === "string") return text(resolved);
			log.trace("memory.recall start", {
				conversationId: invocation.conversationId,
				kind,
				limit,
				query: preview(query),
				scope,
				sessionId: resolved.session.id,
			});
			const ranked = await resolved.service.recordSearch(resolved.session.id, query, limit * 2, {
				...(kind === undefined ? {} : { kind }),
				...(scope === undefined ? {} : { scope }),
			});
			const visible = ranked
				.filter(
					(entry) =>
						resolved.policy.sharedMemoryEnabled !== false || entry.memory.visibility !== "shared",
				)
				.slice(0, limit);
			log.debug("memory.recall complete", {
				candidateCount: ranked.length,
				conversationId: invocation.conversationId,
				durationMs: elapsedMs(startedAt),
				limit,
				resultCount: visible.length,
				sessionId: resolved.session.id,
			});
			if (visible.length === 0) return text("No relevant memories.");
			return text(
				visible
					.map(
						(entry) =>
							`- [id:${entry.memory.id}] [${entry.memory.scope}/${entry.memory.kind}] ${entry.memory.summary.slice(0, 240)}`,
					)
					.join("\n"),
			);
		},
		name: "memory.recall",
		parameters: {
			properties: {
				kind: {
					description:
						"Optional kind filter, e.g. fact, preference, person, relationship, event, todo, glossary, style, persona.",
					type: "string",
				},
				limit: { maximum: MAX_RECALL_LIMIT, minimum: 1, type: "integer" },
				query: {
					description: "Keywords or topic to search; omit or leave empty to list top memories.",
					type: "string",
				},
				scope: {
					description: "Optional scope filter.",
					enum: ["global", "persona", "user", "conversation", "project", "ephemeral"],
					type: "string",
				},
			},
			type: "object",
		},
		policy: { lazy: false, maxPayloadBytes: 8_192, surface: "both", timeoutMs: 20_000 },
		requiredPermissions: ["memory.read"],
	};
}

function saveTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description:
			"Proactively save a durable memory: persona/character settings (scope='persona'), hot memes/slang/in-jokes (kind='glossary'), user preferences, facts, people, relationships, events, or todos.",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const resolved = await resolveMemoryTool(context, log, invocation, "memory.save");
			if (typeof resolved === "string") return text(resolved);
			const summary = inputString(input, "summary");
			if (summary === undefined) {
				log.debug("memory.save rejected", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					reason: "summary_required",
					sessionId: resolved.session.id,
					tool: "memory.save",
				});
				return text("summary is required");
			}
			const kind = inputString(input, "kind") ?? "fact";
			const requestedScope = inputScope(input);
			const subjectUserId = inputString(input, "subjectUserId");
			const target = effectiveWrite(resolved, requestedScope);
			log.trace("memory.save start", {
				conversationId: invocation.conversationId,
				kind,
				scope: target.scope,
				sessionId: resolved.session.id,
				summary: preview(summary),
			});
			if (requestedScope !== undefined && requestedScope !== target.scope) {
				const sharedWriteBlocked =
					resolved.session.kind === "group" && resolved.policy.sharedMemoryWriteEnabled === false;
				log.debug("memory.save scope adjusted", {
					conversationId: invocation.conversationId,
					kind,
					reason: sharedWriteBlocked ? "shared_write_disabled" : "scope_restricted",
					requestedScope,
					scope: target.scope,
					sessionId: resolved.session.id,
					status: target.status,
				});
			}
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
				...(subjectUserId === undefined ? {} : { subjectUserId }),
				summary,
				...(target.scope === "global" ? { visibility: "shared" } : { visibility: "private" }),
			});
			log.debug("memory.save complete", {
				conversationId: invocation.conversationId,
				durationMs: elapsedMs(startedAt),
				kind: result.memory.kind,
				memoryId: result.memory.id,
				merged: result.merged,
				scope: result.memory.scope,
				sessionId: resolved.session.id,
				status: result.memory.status,
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
				subjectUserId: {
					description:
						"Optional unique user ID of the person this memory is about (for scope='user'). Never use display names or nicknames.",
					type: "string",
				},
				summary: { type: "string" },
			},
			required: ["summary"],
			type: "object",
		},
		policy: { lazy: false, maxPayloadBytes: 16_384, surface: "both", timeoutMs: 20_000 },
		requiredPermissions: ["memory.write"],
	};
}

function updateTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description: "Update a durable memory owned by this conversation.",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const resolved = await resolveMemoryTool(context, log, invocation, "memory.update");
			if (typeof resolved === "string") return text(resolved);
			const id = inputString(input, "id");
			const summary = inputString(input, "summary");
			log.trace("memory.update start", {
				conversationId: invocation.conversationId,
				id,
				sessionId: resolved.session.id,
				summary: preview(summary),
			});
			if (id === undefined) {
				log.debug("memory.update rejected", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					reason: "id_required",
					sessionId: resolved.session.id,
					tool: "memory.update",
				});
				return text("id is required");
			}
			const existing = await resolved.service.get(id);
			if (existing === undefined) {
				log.debug("memory.update rejected", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: id,
					reason: "not_found",
					sessionId: resolved.session.id,
					tool: "memory.update",
				});
				return text("Memory not found.");
			}
			if (!ownedBySession(existing, resolved.session.id)) {
				log.warn("memory.update denied", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: id,
					ownerConversationId: existing.conversationId,
					reason: "not_owned",
					scope: existing.scope,
					sessionId: resolved.session.id,
				});
				return text("That memory belongs to another conversation.");
			}
			if (
				(existing.scope === "global" || existing.scope === "persona") &&
				resolved.session.kind === "group" &&
				resolved.policy.sharedMemoryWriteEnabled === false
			) {
				log.warn("memory.update denied", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: id,
					reason: "shared_write_disabled",
					scope: existing.scope,
					sessionId: resolved.session.id,
				});
				return text("Shared memory writes are disabled for this conversation.");
			}
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
				log.debug("memory.update complete", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: result.id,
					scope: result.scope,
					sessionId: resolved.session.id,
					status: result.status,
				});
				return text(`Memory updated: ${result.id} (${result.status})`);
			}
			log.debug("memory.update rejected", {
				conversationId: invocation.conversationId,
				durationMs: elapsedMs(startedAt),
				memoryId: id,
				reason: "summary_required",
				sessionId: resolved.session.id,
				tool: "memory.update",
			});
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
		policy: { lazy: false, maxPayloadBytes: 16_384, surface: "both", timeoutMs: 20_000 },
		requiredPermissions: ["memory.write"],
	};
}

function forgetTool(context: PluginContext, log: PluginLogger): PluginTool {
	return {
		description: "Forget a durable memory owned by this conversation (tombstone retained).",
		execute: async (input, invocation) => {
			const startedAt = performance.now();
			const resolved = await resolveMemoryTool(context, log, invocation, "memory.forget");
			if (typeof resolved === "string") return text(resolved);
			const id = inputString(input, "id");
			log.trace("memory.forget start", {
				conversationId: invocation.conversationId,
				id,
				sessionId: resolved.session.id,
			});
			if (id === undefined) {
				log.debug("memory.forget rejected", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					reason: "id_required",
					sessionId: resolved.session.id,
					tool: "memory.forget",
				});
				return text("id is required");
			}
			const existing = await resolved.service.get(id);
			if (existing === undefined) {
				log.debug("memory.forget rejected", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: id,
					reason: "not_found",
					sessionId: resolved.session.id,
					tool: "memory.forget",
				});
				return text("Memory not found.");
			}
			if (!ownedBySession(existing, resolved.session.id)) {
				log.warn("memory.forget denied", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: id,
					ownerConversationId: existing.conversationId,
					reason: "not_owned",
					scope: existing.scope,
					sessionId: resolved.session.id,
				});
				return text("That memory belongs to another conversation.");
			}
			if (
				(existing.scope === "global" || existing.scope === "persona") &&
				resolved.session.kind === "group" &&
				resolved.policy.sharedMemoryWriteEnabled === false
			) {
				log.warn("memory.forget denied", {
					conversationId: invocation.conversationId,
					durationMs: elapsedMs(startedAt),
					memoryId: id,
					reason: "shared_write_disabled",
					scope: existing.scope,
					sessionId: resolved.session.id,
				});
				return text("Shared memory writes are disabled for this conversation.");
			}
			const result = await resolved.service.revoke(id);
			log.debug("memory.forget complete", {
				conversationId: invocation.conversationId,
				durationMs: elapsedMs(startedAt),
				memoryId: result.id,
				scope: result.scope,
				sessionId: resolved.session.id,
				status: result.status,
			});
			return text(`Memory forgotten: ${result.id}`);
		},
		name: "memory.forget",
		parameters: {
			properties: { id: { type: "string" } },
			required: ["id"],
			type: "object",
		},
		policy: {
			destructive: true,
			lazy: false,
			maxPayloadBytes: 2_048,
			surface: "both",
			timeoutMs: 20_000,
		},
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
		const log = toolsLogger(context);
		const tools = [
			recallTool(context, log),
			saveTool(context, log),
			updateTool(context, log),
			forgetTool(context, log),
		];
		for (const tool of tools) {
			context.tools.register(tool);
		}
		context.logger.info("memory plugin ready", {
			count: tools.length,
			tools: tools.map((tool) => tool.name),
		});
	},
};
