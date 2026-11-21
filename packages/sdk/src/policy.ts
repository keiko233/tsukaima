import {
	legacyProviderSafeToolName,
	providerSafeToolName,
	providerToolNameAliases,
} from "./bridges.ts";
import { hasPermission, type PluginPermission } from "./permissions.ts";
import type { PluginTool, ToolInvocationContext, ToolPolicy, ToolSurface } from "./types.ts";

/**
 * High-frequency IM chat tools loaded eagerly (`lazy: false`) so ordinary turns do not waste a
 * `tool_search` discovery round. Destructive group-admin, account-management, and rare
 * diagnostic tools remain deferred (`lazy: true`).
 */
export const CURATED_EAGER_CHAT_TOOLS: ReadonlySet<string> = new Set([
	"onebot-napcat.send",
	"onebot-napcat.readHistory",
	"onebot-napcat.viewImage",
	"onebot-napcat.poke",
	"onebot-napcat.react",
	"onebot-napcat.listTargets",
	"sticker-meme.send",
	"sticker-meme.search",
	"search-fetch.web",
	"search-fetch.fetch",
	"memory.recall",
	"memory.save",
	"memory.update",
	"memory.forget",
	"proactive-scheduler.schedule",
	"proactive-scheduler.list",
	"proactive-scheduler.cancel",
]);

export const DEFAULT_TOOL_POLICY: ToolPolicy = Object.freeze({
	lazy: true,
	maxConcurrent: 4,
	surface: "both",
	timeoutMs: 30_000,
	visibility: "model",
});

/** Fill safe defaults for a tool registration that omitted `policy`. */
export function resolveToolPolicy(tool: PluginTool): ToolPolicy {
	const policy = tool.policy ?? {};
	const defaultLazy = !CURATED_EAGER_CHAT_TOOLS.has(tool.name);
	return {
		...DEFAULT_TOOL_POLICY,
		...policy,
		lazy: tool.lazy ?? policy.lazy ?? policy.deferred ?? defaultLazy,
		maxConcurrent: Math.max(
			1,
			Math.floor(policy.maxConcurrent ?? DEFAULT_TOOL_POLICY.maxConcurrent),
		),
		surface: tool.surface ?? policy.surface ?? "both",
		timeoutMs: Math.max(1, Math.floor(policy.timeoutMs ?? DEFAULT_TOOL_POLICY.timeoutMs)),
	};
}

export interface ToolPolicyAccessContext extends ToolInvocationContext {
	/** Permissions granted to the owning plugin by its manifest/install record. */
	readonly grantedPermissions?: readonly PluginPermission[];
	/** Global or per-plugin tool allowlist. Empty/undefined means "no restriction". */
	readonly toolAllowlist?: readonly string[];
	/** Conversation policy allowlist (`pacing.allowedTools`). */
	readonly conversationAllowedTools?: readonly string[];
	/** Allocated model-facing names for the tool, including its historical aliases. */
	readonly toolNameAliases?: readonly string[];
	/** Channel capabilities for the current conversation. */
	readonly channelCapabilities?: readonly string[];
	/** Current execution surface; absent means no surface restriction. */
	readonly surface?: ToolSurface;
}

export interface ToolPolicyDecision {
	readonly allowed: boolean;
	readonly visible: boolean;
	readonly policy: ToolPolicy;
	readonly reason?: string;
}

function allowlistMatches(
	toolName: string,
	allowlist: readonly string[],
	aliases: readonly string[] = [],
): boolean {
	const cleanSafe = providerSafeToolName(toolName);
	const legacySafe = legacyProviderSafeToolName(toolName);
	const doubleUnderscore = toolName.replace(/\./gu, "__").replace(/-/gu, "_");
	return allowlist.some((entry) => {
		if (
			entry === "*" ||
			entry === toolName ||
			entry === cleanSafe ||
			entry === legacySafe ||
			aliases.includes(entry) ||
			entry.replace(/\./gu, "__").replace(/-/gu, "_") === doubleUnderscore
		) {
			return true;
		}
		if (entry.endsWith(".*")) return toolName.startsWith(`${entry.slice(0, -2)}.`);
		return false;
	});
}

function isAdmin(context: ToolPolicyAccessContext): boolean {
	return context.isAdmin === true || context.role === "admin";
}

/**
 * Layered tool-policy resolution. Order is deliberate and monotonic: every layer can only
 * narrow access, never grant more than the plugin manifest already allows.
 */
export function resolveToolPolicyAccess(
	tool: PluginTool,
	context: ToolPolicyAccessContext = {},
): ToolPolicyDecision {
	const policy = resolveToolPolicy(tool);
	const deny = (reason: string): ToolPolicyDecision => ({
		allowed: false,
		policy,
		reason,
		visible: false,
	});

	if (policy.visibility === "hidden") return deny("hidden_tool");

	// 0. Surface: a chat turn never reaches coding tools, even through discovery.
	if (
		context.surface !== undefined &&
		policy.surface !== "both" &&
		policy.surface !== context.surface
	) {
		return deny("surface_mismatch");
	}

	// 1. Plugin manifest permissions.
	if (context.grantedPermissions !== undefined) {
		for (const permission of tool.requiredPermissions) {
			if (!hasPermission(context.grantedPermissions, permission)) {
				return deny(`permission_denied:${permission}`);
			}
		}
	}

	const aliases = new Set([...providerToolNameAliases(tool), ...(context.toolNameAliases ?? [])]);

	// 2. Global/plugin tool allowlist.
	if (
		context.toolAllowlist !== undefined &&
		!allowlistMatches(tool.name, [...context.toolAllowlist], [...aliases])
	) {
		return deny("tool_not_allowlisted");
	}

	// 3. Conversation policy + channel capability match.
	if (
		context.conversationAllowedTools !== undefined &&
		!allowlistMatches(tool.name, [...context.conversationAllowedTools], [...aliases])
	) {
		return deny("conversation_tool_denied");
	}
	const requiredCapabilities = policy.requiredConversationCapabilities ?? [];
	if (requiredCapabilities.length > 0) {
		const available = new Set([
			...(context.channelCapabilities ?? []),
			...(context.conversationCapabilities ?? []),
		]);
		const missing = requiredCapabilities.find((capability) => !available.has(capability));
		if (missing !== undefined) return deny(`missing_capability:${missing}`);
	}
	if (policy.conversationAllowlist === true && context.conversationId === undefined) {
		return deny("conversation_required");
	}

	// 4. User/admin role.
	if ((policy.visibility === "admin" || policy.visibility === "ui") && !isAdmin(context)) {
		return deny("admin_required");
	}

	// 5. Task kind.
	if (
		policy.allowedTaskKinds !== undefined &&
		policy.allowedTaskKinds.length > 0 &&
		(context.taskKind === undefined || !policy.allowedTaskKinds.includes(context.taskKind))
	) {
		return deny("task_kind_denied");
	}
	if (
		policy.destructive === true &&
		(context.taskKind === "scheduled" || context.taskKind === "proactive") &&
		!isAdmin(context)
	) {
		return deny("destructive_task_kind_denied");
	}

	return {
		allowed: true,
		policy,
		visible: policy.visibility === "model",
	};
}

/** True when the tool should be offered to the model in this context. */
export function isModelVisibleTool(
	tool: PluginTool,
	context: ToolPolicyAccessContext = {},
): boolean {
	return resolveToolPolicyAccess(tool, context).visible;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/** Size check shared by the tool adapter and worker bridge. */
export function toolPayloadTooLarge(tool: PluginTool, input: unknown): boolean {
	const policy = resolveToolPolicy(tool);
	if (policy.maxPayloadBytes === undefined) return false;
	try {
		return byteLength(JSON.stringify(input ?? null)) > policy.maxPayloadBytes;
	} catch {
		return true;
	}
}
