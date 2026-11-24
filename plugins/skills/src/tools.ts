import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
	SKILL_DOCUMENT_MAX_BYTES,
	SKILL_RESOURCE_MAX_BYTES,
	skillNameSchema,
	type SkillSurface,
} from "@tsukaima/contracts";
import type {
	PluginContext,
	PluginLogger,
	PluginTool,
	ToolInvocationContext,
	ToolResult,
} from "@tsukaima/sdk";
import type { SkillCatalog } from "./catalog.ts";
import { parseSkillDocument, validateSkillFields } from "./frontmatter.ts";
import {
	SKILLS_INSTALL_MODEL_NAME,
	SKILLS_INSTALL_TOOL,
	SKILLS_LOAD_MODEL_NAME,
	SKILLS_LOAD_TOOL,
	SKILLS_READ_RESOURCE_MODEL_NAME,
	SKILLS_READ_RESOURCE_TOOL,
	SKILLS_REMOVE_MODEL_NAME,
	SKILLS_REMOVE_TOOL,
	SKILLS_RESCAN_MODEL_NAME,
	SKILLS_RESCAN_TOOL,
} from "./manifest.ts";
import { isInside, normalizeRelative, resolveInside } from "./paths.ts";

const AUDIT_ACTION = "skills.resource.denied";
const ADMIN_AUDIT_ACTION = "skills.admin-tool";
const SCOPE_AUDIT_ACTION = "skills.tool.denied";
const ADMIN_POLICY = {
	lazy: true,
	maxConcurrent: 4,
	surface: "both",
	timeoutMs: 30_000,
	visibility: "model",
} as const;
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

async function denySkillScope(
	context: PluginContext,
	invocation: ToolInvocationContext,
	name: string,
	operation: string,
): Promise<ToolResult> {
	const caller = callerIdentity(invocation);
	try {
		await context.audit?.record({
			action: SCOPE_AUDIT_ACTION,
			...(invocation.senderPlatformId === undefined
				? {}
				: { actorId: invocation.senderPlatformId }),
			actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
			payload: { ...caller, name, operation, reason: "admin_required", scope: "admin" },
			reason: "admin_required",
			result: "denied",
			targetId: name,
			targetKind: "skill",
		});
	} catch {}
	return text({ error: "admin_required" });
}

export interface SkillsToolsOptions {
	readonly onChanged?: () => Promise<void> | void;
}

interface InstallFile {
	readonly content: string;
	readonly path: string;
}

interface InstallInput {
	readonly content: string;
	readonly files: readonly InstallFile[];
	readonly name: string;
	readonly overwrite: boolean;
}

type ParsedInstall =
	| { readonly ok: true; readonly value: InstallInput }
	| { readonly ok: false; readonly reason: string };

interface AdminOutcome {
	readonly ok: boolean;
	readonly reason?: string;
	readonly summary?: Record<string, unknown>;
	readonly value?: unknown;
}

function recordInput(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

/** Fail-closed runtime gate shared by every Skill management tool. */
export function isAdminSkillCaller(invocation: ToolInvocationContext): boolean {
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

function parseInstallInput(raw: unknown): ParsedInstall {
	const input = recordInput(raw);
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!skillNameSchema.safeParse(name).success) return { ok: false, reason: "invalid_name" };
	if (typeof input.content !== "string") return { ok: false, reason: "invalid_content" };
	if (Buffer.byteLength(input.content, "utf8") > SKILL_DOCUMENT_MAX_BYTES) {
		return { ok: false, reason: "too_large" };
	}
	const files: InstallFile[] = [];
	if (input.files !== undefined) {
		if (!Array.isArray(input.files)) return { ok: false, reason: "invalid_files" };
		for (const entry of input.files) {
			const file = recordInput(entry);
			if (typeof file.path !== "string" || typeof file.content !== "string") {
				return { ok: false, reason: "invalid_files" };
			}
			if (Buffer.byteLength(file.content, "utf8") > SKILL_RESOURCE_MAX_BYTES) {
				return { ok: false, reason: "too_large" };
			}
			files.push({ content: file.content, path: file.path });
		}
	}
	return {
		ok: true,
		value: {
			content: input.content,
			files,
			name,
			overwrite: input.overwrite === true,
		},
	};
}

async function lstatOrUndefined(candidate: string) {
	try {
		return await fs.lstat(candidate);
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { readonly code?: unknown }).code)
				: undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Validates one bundled file below the canonical skill directory before anything is written.
 * Absolute paths, dot segments, traversal, symlinks, a second SKILL.md, and oversized bodies
 * are rejected by stable reason codes without echoing the requested path.
 */
async function validateBundledFile(
	rootReal: string,
	file: InstallFile,
): Promise<
	| { readonly ok: true; readonly relative: string; readonly target: string }
	| { readonly ok: false; readonly reason: string }
> {
	const normalized = normalizeRelative(file.path);
	if (!normalized.ok) return { ok: false, reason: normalized.reason };
	if (normalized.value.path === "SKILL.md") {
		return { ok: false, reason: "duplicate_skill_document" };
	}
	const segments = normalized.value.segments;
	const resolved = await resolveInside(rootReal, normalized.value.path);
	if (!resolved.ok && resolved.reason !== "not_found") {
		return { ok: false, reason: resolved.reason };
	}
	let current = rootReal;
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		const stats = await lstatOrUndefined(current);
		if (stats === undefined) continue;
		if (stats.isSymbolicLink()) return { ok: false, reason: "symlink" };
		const last = index === segments.length - 1;
		if (last && !stats.isFile()) return { ok: false, reason: "not_file" };
		if (!last && !stats.isDirectory()) return { ok: false, reason: "invalid_path" };
	}
	return { ok: true, relative: normalized.value.path, target: current };
}

async function adminExecute(input: {
	readonly body: (input: Record<string, unknown>) => Promise<AdminOutcome>;
	readonly context: PluginContext;
	readonly invocation: ToolInvocationContext;
	readonly operation: string;
	readonly raw: unknown;
	readonly onChanged?: (() => Promise<void> | void) | undefined;
}): Promise<ToolResult> {
	const { context, invocation, operation } = input;
	const caller = callerIdentity(invocation);
	const audit = async (entry: {
		readonly payload: Record<string, unknown>;
		readonly reason?: string;
		readonly result: "ok" | "denied" | "failed";
		readonly targetId?: string;
	}) => {
		try {
			await context.audit?.record({
				action: ADMIN_AUDIT_ACTION,
				...(invocation.senderPlatformId === undefined
					? {}
					: { actorId: invocation.senderPlatformId }),
				actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
				payload: { ...caller, operation, ...entry.payload },
				...(entry.reason === undefined ? {} : { reason: entry.reason }),
				result: entry.result,
				...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
				targetKind: "skill-admin",
			});
		} catch {}
	};
	if (!isAdminSkillCaller(invocation)) {
		await audit({
			payload: { reason: "admin_required" },
			reason: "admin_required",
			result: "denied",
		});
		return text({ error: "admin_required" });
	}
	try {
		const inputRecord = recordInput(input.raw);
		const parsedName =
			typeof inputRecord.name === "string" ? inputRecord.name.trim().slice(0, 128) : undefined;
		const outcome = await input.body(inputRecord);
		if (outcome.ok) await input.onChanged?.();
		await audit({
			payload: {
				...(parsedName === undefined ? {} : { name: parsedName }),
				...outcome.summary,
				...(outcome.ok ? {} : { reason: outcome.reason ?? "operation_failed" }),
			},
			...(outcome.ok ? {} : { reason: outcome.reason ?? "operation_failed" }),
			result: outcome.ok ? "ok" : "failed",
			...(parsedName === undefined ? {} : { targetId: parsedName }),
		});
		return text(outcome.ok ? outcome.value : { error: outcome.reason ?? "operation_failed" });
	} catch {
		await audit({
			payload: { reason: "operation_failed" },
			reason: "operation_failed",
			result: "failed",
		});
		return text({ error: "operation_failed" });
	}
}

/** Registers the read-only `load_skill` and `read_skill_resource` model tools. */
export function registerSkillsTools(
	context: PluginContext,
	catalog: SkillCatalog,
	options: SkillsToolsOptions = {},
): void {
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
				const isAdmin = isAdminSkillCaller(invocation);
				const snapshot = await catalog.current();
				const available = snapshot.skills.filter(
					(skill) => skill.enabled && (isAdmin || skill.scope === "everyone"),
				);
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
			const record = catalog.find(name);
			if (record === undefined) return text({ error: "unknown_skill" });
			if (record.scope === "admin" && !isAdminSkillCaller(invocation)) {
				return await denySkillScope(context, invocation, name, "load");
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
			const record = catalog.find(name);
			if (record === undefined) return text({ error: "unknown_skill" });
			if (record.scope === "admin" && !isAdminSkillCaller(invocation)) {
				return await denySkillScope(context, invocation, name, "read_resource");
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

	register({
		description:
			"Install an Agent Skill for administrators. Content must be a valid SKILL.md with matching frontmatter; bundled files stay inside the skill directory.",
		async execute(raw, invocation) {
			return await adminExecute({
				body: async (input) => {
					const parsed = parseInstallInput(input);
					if (!parsed.ok) return { ok: false, reason: parsed.reason };
					const document = parseSkillDocument(parsed.value.content);
					if (!document.ok) return { ok: false, reason: "invalid_frontmatter" };
					const fields = validateSkillFields(document.document.frontmatter, parsed.value.name);
					if (fields.fields === undefined) return { ok: false, reason: "invalid_frontmatter" };
					if (fields.fields.name !== parsed.value.name) {
						return { ok: false, reason: "skill_name_mismatch" };
					}
					const root = catalog.config.paths[0];
					if (root === undefined) return { ok: false, reason: "no_skill_root_configured" };
					await fs.mkdir(root, { recursive: true });
					const rootReal = await fs.realpath(root);
					const target = join(rootReal, parsed.value.name);
					const existing = await lstatOrUndefined(target);
					if (existing !== undefined) {
						if (existing.isSymbolicLink()) return { ok: false, reason: "skill_path_unsafe" };
						if (!existing.isDirectory()) return { ok: false, reason: "skill_not_directory" };
						if (!parsed.value.overwrite) return { ok: false, reason: "skill_already_exists" };
					}
					const validated: { readonly content: string; readonly target: string }[] = [];
					const seen = new Set<string>();
					for (const file of parsed.value.files) {
						const checked = await validateBundledFile(target, file);
						if (!checked.ok) return { ok: false, reason: checked.reason };
						if (seen.has(checked.relative)) return { ok: false, reason: "duplicate_file_path" };
						seen.add(checked.relative);
						validated.push({ content: file.content, target: checked.target });
					}
					await fs.mkdir(target, { recursive: true });
					await fs.writeFile(join(target, "SKILL.md"), parsed.value.content, "utf8");
					for (const file of validated) {
						await fs.mkdir(dirname(file.target), { recursive: true });
						await fs.writeFile(file.target, file.content, "utf8");
					}
					const snapshot = await catalog.rescan();
					const filesWritten = validated.length + 1;
					return {
						ok: true,
						summary: { filesWritten },
						value: {
							filesWritten,
							installed: true,
							name: parsed.value.name,
							root,
							snapshot: {
								enabled: snapshot.skills.filter((skill) => skill.enabled).length,
								skills: snapshot.skills.length,
							},
						},
					};
				},
				context,
				invocation,
				operation: "install",
				onChanged: options.onChanged,
				raw,
			});
		},
		modelName: SKILLS_INSTALL_MODEL_NAME,
		name: SKILLS_INSTALL_TOOL,
		parameters: {
			properties: {
				content: { type: "string" },
				files: {
					items: {
						properties: { content: { type: "string" }, path: { type: "string" } },
						required: ["path", "content"],
						type: "object",
					},
					type: "array",
				},
				name: { type: "string" },
				overwrite: { type: "boolean" },
			},
			required: ["name", "content"],
			type: "object",
		},
		policy: ADMIN_POLICY,
		requiredPermissions: ["tools"],
	});
	register({
		description: "Remove an installed Agent Skill by name for administrators.",
		async execute(raw, invocation) {
			return await adminExecute({
				body: async (input) => {
					const name = typeof input.name === "string" ? input.name.trim() : "";
					if (!skillNameSchema.safeParse(name).success) {
						return { ok: false, reason: "invalid_name" };
					}
					const record = catalog.findAny(name);
					for (const root of catalog.config.paths) {
						let rootReal: string;
						try {
							rootReal = await fs.realpath(root);
						} catch {
							continue;
						}
						const target = record?.directory ?? join(rootReal, name);
						const stats = await lstatOrUndefined(target);
						if (stats === undefined) continue;
						if (stats.isSymbolicLink()) return { ok: false, reason: "skill_path_unsafe" };
						if (!stats.isDirectory()) continue;
						const targetReal = await fs.realpath(target);
						if (!isInside(rootReal, targetReal)) {
							return { ok: false, reason: "skill_path_unsafe" };
						}
						await fs.rm(targetReal, { force: false, recursive: true });
						await catalog.rescan();
						return { ok: true, summary: { removed: true }, value: { name, removed: true } };
					}
					return { ok: false, reason: "skill_not_found" };
				},
				context,
				invocation,
				operation: "remove",
				onChanged: options.onChanged,
				raw,
			});
		},
		modelName: SKILLS_REMOVE_MODEL_NAME,
		name: SKILLS_REMOVE_TOOL,
		parameters: {
			properties: { name: { type: "string" } },
			required: ["name"],
			type: "object",
		},
		policy: ADMIN_POLICY,
		requiredPermissions: ["tools"],
	});
	register({
		description: "Rescan configured Agent Skill roots and report the current catalog.",
		async execute(raw, invocation) {
			return await adminExecute({
				body: async () => {
					const snapshot = await catalog.rescan();
					return {
						ok: true,
						summary: {
							diagnostics: snapshot.diagnostics.length,
							skills: snapshot.skills.length,
						},
						value: {
							diagnostics: snapshot.diagnostics,
							roots: catalog.config.paths,
							skills: snapshot.skills.map((skill) => ({
								description: skill.description,
								enabled: skill.enabled,
								name: skill.name,
							})),
						},
					};
				},
				context,
				invocation,
				operation: "rescan",
				onChanged: options.onChanged,
				raw,
			});
		},
		modelName: SKILLS_RESCAN_MODEL_NAME,
		name: SKILLS_RESCAN_TOOL,
		parameters: { properties: {}, type: "object" },
		policy: ADMIN_POLICY,
		requiredPermissions: ["tools"],
	});
}
