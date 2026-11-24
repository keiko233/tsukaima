import { skillNameSchema, type SkillSurface } from "@tsukaima/contracts";
import type {
	PluginContext,
	PluginLogger,
	PluginTool,
	ToolInvocationContext,
	ToolResult,
} from "@tsukaima/sdk";
import type { SkillCatalog } from "./catalog.ts";
import {
	SKILLS_LOAD_MODEL_NAME,
	SKILLS_LOAD_TOOL,
	SKILLS_READ_RESOURCE_MODEL_NAME,
	SKILLS_READ_RESOURCE_TOOL,
} from "./manifest.ts";

const AUDIT_ACTION = "skills.resource.denied";
const RESOURCE_DENIAL_REASONS = new Set([
	"absolute_path",
	"escapes_root",
	"invalid_path",
	"not_text",
	"resources_disabled",
	"too_large",
	"traversal",
]);

const text = (value: unknown): ToolResult => ({
	content: [{ text: typeof value === "string" ? value : JSON.stringify(value), type: "text" }],
});

/** Extracts the plugin-level `{ error }` payload a tool returns for a denied/failed call. */
function toolResultError(result: ToolResult): string | undefined {
	const first = result.content[0];
	if (first === undefined || !first.text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(first.text);
		if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
			return String((parsed as { error: unknown }).error);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Wraps a tool registration with trace/debug timing, never logging input values or bodies. */
function tracedTool(context: PluginContext, tool: PluginTool): PluginTool {
	const logger: PluginLogger = context.logger.child?.("tools") ?? context.logger;
	return {
		...tool,
		async execute(input, invocation) {
			const startedAtMs = Date.now();
			const conversationId = invocation.conversationId ?? null;
			logger.trace("plugin tool invoked", {
				conversationId,
				inputKeys: Object.keys(input ?? {}),
				tool: tool.name,
			});
			try {
				const result = await tool.execute(input, invocation);
				const failure = toolResultError(result);
				logger.debug("plugin tool finished", {
					conversationId,
					durationMs: Date.now() - startedAtMs,
					error: failure ?? null,
					ok: failure === undefined,
					tool: tool.name,
				});
				return result;
			} catch (error) {
				logger.debug("plugin tool failed", {
					conversationId,
					durationMs: Date.now() - startedAtMs,
					error: error instanceof Error ? error.message : String(error),
					tool: tool.name,
				});
				throw error;
			}
		},
	};
}

function surfaceFor(invocation: ToolInvocationContext): SkillSurface {
	return invocation.chatKind === "workspace" ? "workspace" : "chat";
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Records a denied resource lookup. The requested path is omitted when it looked absolute,
 * because an absolute path must never reach logs or the audit trail.
 */
async function denyResource(
	context: PluginContext,
	invocation: ToolInvocationContext,
	reason: string,
	input: { readonly name?: string | undefined; readonly path?: string | undefined },
): Promise<ToolResult> {
	const path = reason === "absolute_path" ? undefined : input.path?.slice(0, 256);
	const name = input.name;
	try {
		await context.audit?.record({
			action: AUDIT_ACTION,
			actorId: invocation.userId ?? "agent",
			actorKind: invocation.userId === undefined ? "agent" : "user",
			payload: {
				reason,
				...(name === undefined ? {} : { name }),
				...(path === undefined || path.length === 0 ? {} : { path }),
			},
			reason,
			result: "denied",
			targetId: name ?? "skill-catalog",
			targetKind: "skill-resource",
		});
	} catch {}
	return text({ error: reason });
}

/** Registers the read-only `load_skill` and `read_skill_resource` model tools. */
export function registerSkillsTools(context: PluginContext, catalog: SkillCatalog): void {
	const register = (tool: PluginTool): void => context.tools.register(tracedTool(context, tool));
	register({
		description:
			"Load an Agent Skill by name and return its SKILL.md instructions. Call without a name to list the available skills.",
		async execute(input, invocation) {
			if (!catalog.surfaceAllowed(surfaceFor(invocation))) {
				return text({ error: "surface_disabled" });
			}
			const name = stringInput(input, "name");
			if (name === undefined) {
				const snapshot = await catalog.current();
				const available = snapshot.skills.filter((skill) => skill.enabled);
				if (available.length === 0) return text({ error: "no_skills" });
				return text(
					[
						"Available skills:",
						...available.map((skill) => `- ${skill.name}: ${skill.description}`),
					].join("\n"),
				);
			}
			if (!skillNameSchema.safeParse(name).success) {
				return await denyResource(context, invocation, "invalid_name", { name });
			}
			const detail = await catalog.loadDetail(name);
			if (detail === undefined) return text({ error: "unknown_skill" });
			const lines = [detail.body.trim()];
			const metadata = detail.metadata;
			if (metadata !== undefined && Object.keys(metadata).length > 0) {
				const entries = Object.entries(metadata)
					.toSorted(([left], [right]) => left.localeCompare(right))
					.slice(0, 12);
				lines.push(
					"",
					"Skill metadata:",
					...entries.map(([key, value]) => `- ${key}: ${value.slice(0, 256)}`),
				);
			}
			if (detail.resources.length > 0) {
				lines.push("", "Bundled files:", ...detail.resources.map((entry) => `- ${entry.path}`));
			}
			return text(lines.join("\n").trim());
		},
		modelName: SKILLS_LOAD_MODEL_NAME,
		name: SKILLS_LOAD_TOOL,
		parameters: {
			properties: { name: { type: "string" } },
			type: "object",
		},
		policy: {
			lazy: false,
			maxConcurrent: 8,
			maxPayloadBytes: 8_192,
			surface: "both",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tools"],
	});
	register({
		description:
			"Read one bundled text file from a loaded Agent Skill. Paths are relative to the skill directory.",
		async execute(input, invocation) {
			if (!catalog.surfaceAllowed(surfaceFor(invocation))) {
				return text({ error: "surface_disabled" });
			}
			const name = stringInput(input, "name");
			const rawPath = stringInput(input, "path");
			if (name === undefined || !skillNameSchema.safeParse(name).success) {
				return await denyResource(context, invocation, "invalid_name", { name });
			}
			if (rawPath === undefined) {
				return await denyResource(context, invocation, "invalid_path", { name });
			}
			const result = await catalog.readResource(name, rawPath);
			if (!result.ok) {
				if (result.reason === "unknown_skill") return text({ error: "unknown_skill" });
				if (RESOURCE_DENIAL_REASONS.has(result.reason)) {
					return await denyResource(context, invocation, result.reason, {
						name,
						path: rawPath,
					});
				}
				return text({ error: result.reason });
			}
			return text(result.text);
		},
		modelName: SKILLS_READ_RESOURCE_MODEL_NAME,
		name: SKILLS_READ_RESOURCE_TOOL,
		parameters: {
			properties: { name: { type: "string" }, path: { type: "string" } },
			required: ["name", "path"],
			type: "object",
		},
		policy: {
			lazy: false,
			maxConcurrent: 8,
			maxPayloadBytes: 8_192,
			surface: "both",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tools"],
	});
}
