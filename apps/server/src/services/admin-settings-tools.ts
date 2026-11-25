import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { TsukaimaDatabase } from "@tsukaima/db";
import {
	conversationPolicyPatchSchema,
	personaUpsertInputSchema,
	runtimeSettingsPatchSchema,
	type ConversationPolicyPatch,
	type RuntimeSettings,
	type RuntimeSettingsPatch,
} from "@tsukaima/contracts";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import {
	patchRuntimeSettings,
	publicRuntimeSettings,
	readRuntimeSettings,
} from "../runtime-settings.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import { readGitIdentity, writeGitIdentity, type GitIdentity } from "./git-identity.ts";
import type { ResolvedImCallerContext } from "./im-caller-context.ts";
import type { PluginHostEntry } from "./plugin-host.ts";

export const ADMIN_SETTINGS_TOOLS_EXTENSION_NAME = "tsukaima-admin-settings-tools";
export const ADMIN_SETTINGS_TOOL_NAMES = [
	"settings_get",
	"settings_update",
	"policy_get",
	"policy_update",
	"plugin_list",
	"plugin_configure",
	"persona_manage",
] as const;

const RUNTIME_PATCH_KEYS = [
	"chatModel",
	"chatThinking",
	"gateModelId",
	"logLevel",
	"memoryModelId",
	"modelProviderId",
	"sidechatModelId",
	"workspaceModel",
	"workspaceThinking",
] as const;

export interface AdminSettingsAuthorization {
	readonly allowed: boolean;
	readonly callerId?: string;
	readonly channelId?: string;
	readonly chatKind?: string;
	readonly isAdmin?: boolean;
	readonly platformConversationId?: string;
	readonly reason?: string;
	readonly sessionId?: string;
}

/** Secret-free model summary returned by `settings_get`. */
export interface AdminSettingsModelSummary {
	readonly capabilities: readonly string[];
	readonly id: string;
	readonly providerId: string;
	readonly reasoningLevels?: readonly string[];
}

/** Host capabilities the admin settings tools depend on, kept narrow for testing. */
export interface AdminSettingsPluginPort {
	readonly configViews: () => Promise<
		readonly { config: Record<string, unknown>; id: string; secretsSet: string[] }[]
	>;
	readonly list: () => Promise<readonly PluginHostEntry[]>;
	readonly reload: (pluginId: string) => Promise<unknown>;
	readonly setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
	readonly updateConfig: (pluginId: string, config: Record<string, unknown>) => Promise<void>;
}

export interface AdminSettingsToolsOptions {
	readonly applyRuntimeSettings: (settings: RuntimeSettings) => Promise<void> | void;
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	/**
	 * Fail-closed runtime authorization. A tool never executes without this callback, so a
	 * missing or throwing authorization check denies the call instead of falling back to an
	 * allow.
	 */
	readonly authorize?: (
		durableConversationId: string,
		toolName: string,
	) => Promise<AdminSettingsAuthorization>;
	/** Optional active-provider model catalog; an unavailable catalog reports no models. */
	readonly availableModels?: () => Promise<readonly AdminSettingsModelSummary[]>;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	readonly plugins: AdminSettingsPluginPort;
	readonly policy: ConversationPolicyService;
	readonly resolveSessionId: (durableConversationId: string) => Promise<string | undefined>;
}

function baseAuthorization(
	caller: ResolvedImCallerContext,
): Omit<AdminSettingsAuthorization, "allowed"> {
	return {
		...(caller.senderPlatformId === undefined ? {} : { callerId: caller.senderPlatformId }),
		...(caller.channelId === undefined ? {} : { channelId: caller.channelId }),
		...(caller.chatKind === undefined ? {} : { chatKind: caller.chatKind }),
		...(caller.isAdmin === undefined ? {} : { isAdmin: caller.isAdmin }),
		...(caller.platformConversationId === undefined
			? {}
			: { platformConversationId: caller.platformConversationId }),
		...(caller.domainConversationId === undefined
			? {}
			: { sessionId: caller.domainConversationId }),
	};
}

/**
 * Fail-closed admin authorization shared by the admin settings extension.
 *
 * `webui` is the single-admin authenticated surface. A coding `workspace` turn is admin-gated
 * by its resolved caller; a sandbox workspace always resolves `isAdmin: false` and is denied.
 * IM (`private`/`group`) requires a runtime-resolved trusted admin sender. A proactive/background
 * turn has no turn-bound sender, so `resolveImCallerContext` cannot resolve an admin and every
 * tool call is denied. Unknown kinds, missing callers, and transient read failures deny as well.
 */
export function authorizeAdminSettingsToolCall(input: {
	readonly caller: ResolvedImCallerContext;
	readonly toolName: string;
}): AdminSettingsAuthorization {
	const { caller, toolName } = input;
	const base = baseAuthorization(caller);
	if (!(ADMIN_SETTINGS_TOOL_NAMES as readonly string[]).includes(toolName)) {
		return { ...base, allowed: false, reason: "unknown_admin_tool" };
	}
	const chatKind = caller.chatKind;
	if (chatKind === "webui") {
		return { ...base, allowed: true };
	}
	if (chatKind === "workspace") {
		return caller.isAdmin === true
			? { ...base, allowed: true }
			: { ...base, allowed: false, reason: "admin_required" };
	}
	if (chatKind !== "private" && chatKind !== "group") {
		return { ...base, allowed: false, reason: "disallowed_chat_kind" };
	}
	if (caller.isAdmin !== true || caller.senderPlatformId === undefined) {
		return { ...base, allowed: false, reason: "admin_required" };
	}
	return { ...base, allowed: true };
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
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
		if (!required && value.length === 0) return value;
	}
	if (required) throw new Error(`${key} is required`);
	return undefined;
}

function booleanValue(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}

function positiveInteger(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${key} must be a positive integer`);
	}
	return value;
}

function stringArray(input: Record<string, unknown>, key: string): string[] | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
	const entries: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(`${key} must contain non-empty strings`);
		}
		entries.push(entry.trim());
	}
	return entries;
}

function objectValue(
	input: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${key} must be an object`);
	}
	return value as Record<string, unknown>;
}

function gitIdentityValue(value: unknown): GitIdentity | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("gitIdentity must be an object");
	}
	const identity = value as Record<string, unknown>;
	for (const key of Object.keys(identity)) {
		if (key !== "name" && key !== "email") {
			throw new Error("gitIdentity contains unsupported fields");
		}
	}
	const name = identity.name;
	const email = identity.email;
	if (typeof name !== "string" || typeof email !== "string") {
		throw new Error("gitIdentity.name and gitIdentity.email are required strings");
	}
	return { email, name };
}

function callerPayload(
	conversationId: string,
	auth: AdminSettingsAuthorization | undefined,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		conversationId,
		...(auth?.sessionId === undefined ? {} : { originSessionId: auth.sessionId }),
		...(auth?.chatKind === undefined ? {} : { chatKind: auth.chatKind }),
		...(auth?.channelId === undefined ? {} : { channelId: auth.channelId }),
		...(auth?.platformConversationId === undefined
			? {}
			: { platformConversationId: auth.platformConversationId }),
		...(auth?.callerId === undefined ? {} : { callerId: auth.callerId }),
		...(auth?.isAdmin === undefined ? {} : { isAdmin: auth.isAdmin }),
		...extra,
	};
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
		surface: "both",
	};
}

const PERSONA_SCOPES = ["global", "chat-kind", "chat-object", "conversation"] as const;
const CHAT_KINDS = ["group", "private", "webui"] as const;

/**
 * Admin-only runtime settings, conversation policy, plugin configuration, and persona tools.
 * Every call has a fail-closed runtime authorization check plus a durable audit record, and
 * plugin secret values never cross into tool output, logs, or audit payloads.
 */
export function createAdminSettingsToolsExtension(
	options: AdminSettingsToolsOptions,
): DurableExtension {
	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.(entry);
		} catch (error) {
			options.logger.warn("admin settings audit failed", {
				error: error instanceof Error ? error.message : String(error),
				tool: entry.action,
			});
		}
	};

	const requireDatabase = (): TsukaimaDatabase => {
		const database = options.database();
		if (database === undefined) throw new Error("domain database is unavailable");
		return database;
	};

	const run = async (
		name: string,
		conversationId: string,
		body: () => Promise<unknown>,
		extraAudit?: (result: unknown) => Record<string, unknown>,
	): Promise<
		| { output: { text: string; type: "text" }[] }
		| { isError: true; output: { text: string; type: "text" }[] }
	> => {
		let auth: AdminSettingsAuthorization | undefined;
		if (options.authorize === undefined) {
			auth = { allowed: false, reason: "authorization_unavailable" };
		} else {
			try {
				auth = await options.authorize(conversationId, name);
			} catch {
				auth = { allowed: false, reason: "authorization_check_failed" };
			}
		}
		if (auth === undefined || !auth.allowed) {
			const reason = auth?.reason ?? "admin_settings_denied";
			await audit({
				action: `admin-settings.${name}`,
				...(auth?.callerId === undefined ? {} : { actorId: auth.callerId }),
				actorKind: auth?.callerId === undefined ? "agent" : "user",
				payload: callerPayload(conversationId, auth, { reason }),
				reason,
				result: "denied",
				...(auth?.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-settings",
			});
			options.logger.warn("admin settings tool denied", {
				callerId: auth?.callerId ?? null,
				chatKind: auth?.chatKind ?? null,
				conversationId,
				reason,
				tool: name,
			});
			return failure(new Error(reason));
		}
		const isImCaller = auth.chatKind === "private" || auth.chatKind === "group";
		try {
			const result = await body();
			await audit({
				action: `admin-settings.${name}`,
				...(isImCaller && auth.callerId !== undefined ? { actorId: auth.callerId } : {}),
				actorKind: isImCaller && auth.callerId !== undefined ? "user" : "agent",
				payload: callerPayload(conversationId, auth, extraAudit?.(result)),
				result: "ok",
				...(auth.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-settings",
			});
			return text(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await audit({
				action: `admin-settings.${name}`,
				...(isImCaller && auth.callerId !== undefined ? { actorId: auth.callerId } : {}),
				actorKind: isImCaller && auth.callerId !== undefined ? "user" : "agent",
				payload: callerPayload(conversationId, auth),
				reason: message,
				result: "failed",
				...(auth.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-settings",
			});
			options.logger.warn("admin settings tool failed", {
				conversationId,
				error: message,
				tool: name,
			});
			return failure(error);
		}
	};

	const settingsGet = tool({
		description:
			"Admin-only runtime settings inspection. Returns public runtime settings, the Git identity, and the active provider's available models.",
		name: "settings_get",
		parameters: { properties: {}, type: "object" },
		async execute(_args, api) {
			return await run(
				"settings_get",
				String(api.conversationId),
				async () => {
					const database = options.database();
					const settings = await readRuntimeSettings(database);
					const gitIdentity = await readGitIdentity(database);
					let availableModels: readonly AdminSettingsModelSummary[] = [];
					if (options.availableModels !== undefined) {
						try {
							availableModels = await options.availableModels();
						} catch (error) {
							options.logger.warn("admin settings model catalog unavailable", {
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					return {
						availableModels,
						gitIdentity,
						settings: publicRuntimeSettings(settings),
					};
				},
				(result) => {
					const value = record(result);
					const models = Array.isArray(value.availableModels) ? value.availableModels : [];
					return { availableModelCount: models.length };
				},
			);
		},
	});

	const settingsUpdate = tool({
		description:
			"Admin-only runtime settings update. Applies a runtime settings patch immediately and can write the Git identity. Clearing a value accepts null or an empty string.",
		name: "settings_update",
		parameters: {
			properties: {
				chatModel: { type: ["object", "null"] },
				chatThinking: { type: ["string", "null"] },
				gateModelId: { type: ["string", "null"] },
				gitIdentity: {
					properties: {
						email: { type: "string" },
						name: { type: "string" },
					},
					required: ["name", "email"],
					type: "object",
				},
				logLevel: { type: "string" },
				memoryModelId: { type: ["string", "null"] },
				modelProviderId: { type: ["string", "null"] },
				sidechatModelId: { type: ["string", "null"] },
				workspaceModel: { type: ["object", "null"] },
				workspaceThinking: { type: ["string", "null"] },
			},
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			const runtimeInput: Record<string, unknown> = {};
			for (const key of RUNTIME_PATCH_KEYS) {
				if (input[key] !== undefined) runtimeInput[key] = input[key];
			}
			const changedKeys = Object.keys(runtimeInput);
			return await run(
				"settings_update",
				String(api.conversationId),
				async () => {
					const database = requireDatabase();
					const gitIdentity = gitIdentityValue(input.gitIdentity);
					let patch: RuntimeSettingsPatch | undefined;
					if (changedKeys.length > 0) {
						patch = runtimeSettingsPatchSchema.parse(runtimeInput);
					}
					if (patch === undefined && gitIdentity === undefined) {
						throw new Error("at least one setting must be provided");
					}
					let settings = await readRuntimeSettings(database);
					if (patch !== undefined) {
						settings = await patchRuntimeSettings(database, patch);
						await options.applyRuntimeSettings(settings);
					}
					if (gitIdentity !== undefined) {
						await writeGitIdentity(database, gitIdentity);
					}
					return {
						gitIdentity: await readGitIdentity(database),
						settings: publicRuntimeSettings(settings),
					};
				},
				() => ({
					changedKeys,
					gitIdentity: input.gitIdentity !== undefined,
				}),
			);
		},
	});

	const policyGet = tool({
		description:
			"Admin-only conversation policy inspection. Omit the target to read the current conversation; `scope: global` reads the global default.",
		name: "policy_get",
		parameters: {
			properties: {
				chatObjectId: { type: "string" },
				conversationId: { type: "string" },
				scope: { enum: ["global", "conversation"], type: "string" },
			},
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"policy_get",
				String(api.conversationId),
				async () => {
					const scope = input.scope;
					if (scope !== undefined && scope !== "global" && scope !== "conversation") {
						throw new Error("scope must be global or conversation");
					}
					if (scope === "global") return await options.policy.view({});
					const conversationId = stringValue(input, "conversationId");
					const chatObjectId = stringValue(input, "chatObjectId");
					const resolvedConversationId =
						conversationId === undefined && chatObjectId === undefined
							? await options.resolveSessionId(String(api.conversationId))
							: conversationId;
					return await options.policy.view({
						...(resolvedConversationId === undefined
							? {}
							: { conversationId: resolvedConversationId }),
						...(chatObjectId === undefined ? {} : { chatObjectId }),
					});
				},
				() => ({
					scope: typeof input.scope === "string" ? input.scope : "conversation",
				}),
			);
		},
	});

	const policyUpdate = tool({
		description:
			"Admin-only conversation policy update. A conversation update omitting `conversationId` targets the current conversation and syncs its tool policy immediately.",
		name: "policy_update",
		parameters: {
			properties: {
				conversationId: { type: "string" },
				policy: { type: "object" },
				scope: { enum: ["global", "conversation"], type: "string" },
			},
			required: ["scope", "policy"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"policy_update",
				String(api.conversationId),
				async () => {
					const scope = input.scope;
					if (scope !== "global" && scope !== "conversation") {
						throw new Error("scope must be global or conversation");
					}
					const policyInput = objectValue(input, "policy");
					if (policyInput === undefined) throw new Error("policy is required");
					const patch: ConversationPolicyPatch = conversationPolicyPatchSchema.parse(policyInput);
					const conversationId = stringValue(input, "conversationId");
					const resolvedConversationId =
						conversationId === undefined && scope === "conversation"
							? await options.resolveSessionId(String(api.conversationId))
							: conversationId;
					if (scope === "conversation" && resolvedConversationId === undefined) {
						throw new Error("conversationId is required for a conversation policy update");
					}
					return await options.policy.update({
						...(resolvedConversationId === undefined
							? {}
							: { conversationId: resolvedConversationId }),
						policy: patch,
						scope,
					});
				},
				() => (typeof input.scope === "string" ? { scope: input.scope } : {}),
			);
		},
	});

	const pluginList = tool({
		description:
			"Admin-only installed plugin inventory. Plugin configuration is returned secret-free and `secretsSet` lists secret key names only, never values.",
		name: "plugin_list",
		parameters: { properties: {}, type: "object" },
		async execute(_args, api) {
			return await run(
				"plugin_list",
				String(api.conversationId),
				async () => {
					const entries = await options.plugins.list();
					const views = await options.plugins.configViews();
					const viewById = new Map(views.map((view) => [view.id, view]));
					return {
						plugins: entries.map((entry) => {
							const view = viewById.get(entry.id);
							return {
								config: view?.config ?? entry.config,
								enabled: entry.enabled === 1,
								id: entry.id,
								kind: entry.kind,
								secretsSet: view?.secretsSet ?? [...entry.secretsSet],
								status: entry.status,
								version: entry.version,
							};
						}),
					};
				},
				(result) => {
					const value = record(result);
					const plugins = Array.isArray(value.plugins) ? value.plugins : [];
					return { pluginCount: plugins.length };
				},
			);
		},
	});

	const pluginConfigure = tool({
		description:
			"Admin-only plugin configuration and lifecycle control. Updates config, toggles enablement, and can reload the plugin. Secret values are accepted but never echoed back.",
		name: "plugin_configure",
		parameters: {
			properties: {
				config: { type: "object" },
				enabled: { type: "boolean" },
				pluginId: { type: "string" },
				reload: { type: "boolean" },
			},
			required: ["pluginId"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"plugin_configure",
				String(api.conversationId),
				async () => {
					const pluginId = stringValue(input, "pluginId", true)!;
					const config = objectValue(input, "config");
					const enabled = booleanValue(input, "enabled");
					const reload = booleanValue(input, "reload") === true;
					const entries = await options.plugins.list();
					if (!entries.some((entry) => entry.id === pluginId)) {
						throw new Error(`unknown plugin ${pluginId}`);
					}
					if (config !== undefined) {
						await options.plugins.updateConfig(pluginId, config);
					}
					if (enabled !== undefined) {
						await options.plugins.setEnabled(pluginId, enabled);
					}
					if (reload) {
						await options.plugins.reload(pluginId);
					}
					const views = await options.plugins.configViews();
					const updatedEntries = await options.plugins.list();
					const entry = updatedEntries.find((candidate) => candidate.id === pluginId);
					const view = views.find((candidate) => candidate.id === pluginId);
					return {
						config: view?.config ?? entry?.config ?? {},
						enabled: entry === undefined ? enabled === true : entry.enabled === 1,
						pluginId,
						reloaded: reload,
						secretsSet: [...(view?.secretsSet ?? entry?.secretsSet ?? [])],
					};
				},
				() => ({
					configKeys: Object.keys(record(input.config)),
					enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
					pluginId: typeof input.pluginId === "string" ? input.pluginId : undefined,
					reload: input.reload === true,
				}),
			);
		},
	});

	const personaManage = tool({
		description:
			"Admin-only persona inventory, upsert, and binding. Binding scope `conversation` defaults to the current conversation when no id is given.",
		name: "persona_manage",
		parameters: {
			properties: {
				action: { enum: ["list", "upsert", "bind"], type: "string" },
				chatKind: { enum: [...CHAT_KINDS], type: "string" },
				chatObjectId: { type: "string" },
				conversationId: { type: "string" },
				id: { type: "string" },
				isActive: { type: "boolean" },
				name: { type: "string" },
				personaId: { type: "string" },
				prompt: { type: "string" },
				scope: { enum: [...PERSONA_SCOPES], type: "string" },
				selfAliases: { items: { type: "string" }, type: "array" },
				summary: { type: "string" },
				version: { type: "integer" },
			},
			required: ["action"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			const action = input.action;
			return await run(
				"persona_manage",
				String(api.conversationId),
				async () => {
					if (action === "list") {
						return {
							bindings: await options.policy.listBindings(),
							personas: await options.policy.listPersonas(),
						};
					}
					if (action === "upsert") {
						const name = stringValue(input, "name", true)!;
						const summary = stringValue(input, "summary", true)!;
						const prompt = stringValue(input, "prompt", true)!;
						const id = stringValue(input, "id");
						const isActive = booleanValue(input, "isActive");
						const selfAliases = stringArray(input, "selfAliases");
						const version = positiveInteger(input, "version");
						const parseInput = {
							...(id === undefined ? {} : { id }),
							...(isActive === undefined ? {} : { isActive }),
							name,
							prompt,
							...(selfAliases === undefined ? {} : { selfAliases }),
							summary,
							...(version === undefined ? {} : { version }),
						};
						const personaInput = personaUpsertInputSchema.parse(parseInput);
						const persona = await options.policy.upsertPersona({
							...(personaInput.id === undefined ? {} : { id: personaInput.id }),
							...(personaInput.isActive === undefined ? {} : { isActive: personaInput.isActive }),
							name: personaInput.name,
							prompt: personaInput.prompt,
							...(personaInput.selfAliases === undefined
								? {}
								: { selfAliases: personaInput.selfAliases }),
							summary: personaInput.summary,
							...(personaInput.version === undefined ? {} : { version: personaInput.version }),
						});
						return { persona };
					}
					if (action === "bind") {
						const personaId = stringValue(input, "personaId", true)!;
						const scope = input.scope;
						if (
							typeof scope !== "string" ||
							!(PERSONA_SCOPES as readonly string[]).includes(scope)
						) {
							throw new Error("scope must be a valid persona binding scope");
						}
						const chatKindInput = input.chatKind;
						if (
							chatKindInput !== undefined &&
							(typeof chatKindInput !== "string" ||
								!(CHAT_KINDS as readonly string[]).includes(chatKindInput))
						) {
							throw new Error("chatKind must be group, private, or webui");
						}
						const chatObjectId = stringValue(input, "chatObjectId");
						let conversationId = stringValue(input, "conversationId");
						if (scope === "conversation" && conversationId === undefined) {
							conversationId = await options.resolveSessionId(String(api.conversationId));
						}
						if (scope === "conversation" && conversationId === undefined) {
							throw new Error("conversationId is required for a conversation binding");
						}
						const chatKind =
							chatKindInput === "private" || chatKindInput === "group" ? chatKindInput : undefined;
						if (scope === "chat-kind" && chatKind === undefined) {
							throw new Error("chatKind must be private or group for a chat-kind binding");
						}
						const binding = await options.policy.bindPersona({
							...(chatKind === undefined ? {} : { chatKind }),
							...(chatObjectId === undefined ? {} : { chatObjectId }),
							...(conversationId === undefined ? {} : { conversationId }),
							personaId,
							scope: scope as (typeof PERSONA_SCOPES)[number],
						});
						return { binding };
					}
					throw new Error("action must be list, upsert, or bind");
				},
				(result) => {
					const value = record(result);
					const persona = record(value.persona);
					const binding = record(value.binding);
					return {
						action,
						...(typeof persona.id === "string" ? { personaId: persona.id } : {}),
						...(typeof binding.personaId === "string" ? { boundPersonaId: binding.personaId } : {}),
					};
				},
			);
		},
	});

	return {
		name: ADMIN_SETTINGS_TOOLS_EXTENSION_NAME,
		tools: [
			settingsGet,
			settingsUpdate,
			policyGet,
			policyUpdate,
			pluginList,
			pluginConfigure,
			personaManage,
		],
	};
}
