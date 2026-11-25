import type { RestartMode, RestartStatus } from "@tsukaima/contracts";
import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import { record } from "../records.ts";
import type { ResolvedImCallerContext } from "./im-caller-context.ts";

export const ADMIN_RUNTIME_TOOLS_EXTENSION_NAME = "tsukaima-admin-runtime-tools";
export const ADMIN_RUNTIME_TOOL_NAMES = [
	"runtime_restart",
	"runtime_restart_status",
	"runtime_restart_cancel",
] as const;

export const RUNTIME_RESTART_DEFAULT_DELAY_SECONDS = 60;
export const RUNTIME_RESTART_MAX_DELAY_SECONDS = 86_400;
export const RUNTIME_RESTART_MAX_REASON_LENGTH = 500;

export interface AdminRuntimeAuthorization {
	readonly allowed: boolean;
	readonly callerId?: string;
	readonly channelId?: string;
	readonly chatKind?: string;
	readonly isAdmin?: boolean;
	readonly platformConversationId?: string;
	readonly reason?: string;
	readonly sessionId?: string;
}

/** Narrow restart port so the tools stay decoupled from the coordinator implementation. */
export interface AdminRuntimeRestartPort {
	readonly cancel: (reason?: string) => Promise<boolean>;
	readonly schedule: (input: {
		readonly delaySeconds?: number;
		readonly mode?: RestartMode;
		readonly reason?: string;
		readonly requestedBy?: string;
	}) => Promise<RestartStatus>;
	readonly status: () => Promise<RestartStatus | null>;
}

export interface AdminRuntimeToolsOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	/**
	 * Fail-closed runtime authorization. A tool never executes without this callback, so a
	 * missing or throwing authorization check denies the call instead of falling back to an
	 * allow.
	 */
	readonly authorize?: (
		durableConversationId: string,
		toolName: string,
	) => Promise<AdminRuntimeAuthorization>;
	readonly logger: Logger;
	readonly restart: AdminRuntimeRestartPort;
}

function baseAuthorization(
	caller: ResolvedImCallerContext,
): Omit<AdminRuntimeAuthorization, "allowed"> {
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
 * Fail-closed admin authorization shared by the runtime maintenance extension.
 *
 * `webui` is the single-admin authenticated surface. A coding `workspace` turn is admin-gated
 * by its resolved caller; a sandbox workspace always resolves `isAdmin: false` and is denied.
 * IM (`private`/`group`) requires a runtime-resolved trusted admin sender. A proactive/background
 * turn has no turn-bound sender, so `resolveImCallerContext` cannot resolve an admin and every
 * tool call is denied. Unknown kinds, missing callers, and transient read failures deny as well.
 */
export function authorizeAdminRuntimeToolCall(input: {
	readonly caller: ResolvedImCallerContext;
	readonly toolName: string;
}): AdminRuntimeAuthorization {
	const { caller, toolName } = input;
	const base = baseAuthorization(caller);
	if (!(ADMIN_RUNTIME_TOOL_NAMES as readonly string[]).includes(toolName)) {
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

function text(value: unknown) {
	return {
		output: [
			{
				text: typeof value === "string" ? value : JSON.stringify(value),
				type: "text" as const,
			},
		],
	};
}

function failure(error: unknown) {
	return {
		isError: true as const,
		output: [
			{
				text: JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				type: "text" as const,
			},
		],
	};
}

function delaySecondsValue(input: Record<string, unknown>): number | undefined {
	const value = input.delaySeconds;
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > RUNTIME_RESTART_MAX_DELAY_SECONDS
	) {
		throw new Error(
			`delaySeconds must be an integer between 1 and ${RUNTIME_RESTART_MAX_DELAY_SECONDS}`,
		);
	}
	return value;
}

function modeValue(input: Record<string, unknown>): RestartMode | undefined {
	const value = input.mode;
	if (value === undefined) return undefined;
	if (value !== "restart" && value !== "update") {
		throw new Error("mode must be restart or update");
	}
	return value;
}

function reasonValue(input: Record<string, unknown>): string | undefined {
	const value = input.reason;
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("reason must be a string");
	const reason = value.trim();
	if (reason.length === 0) throw new Error("reason must not be empty");
	if (reason.length > RUNTIME_RESTART_MAX_REASON_LENGTH) {
		throw new Error(`reason must be at most ${RUNTIME_RESTART_MAX_REASON_LENGTH} characters`);
	}
	return reason;
}

function callerPayload(
	conversationId: string,
	auth: AdminRuntimeAuthorization | undefined,
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

function requestedBy(auth: AdminRuntimeAuthorization): string {
	if (auth.chatKind === "workspace") return "workspace-agent";
	if (auth.chatKind === "webui") return "webui-admin";
	return "im-admin";
}

function tool(input: {
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: (typeof ADMIN_RUNTIME_TOOL_NAMES)[number];
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

/**
 * Admin-only runtime maintenance tools. Scheduling and cancellation are owned by the durable
 * restart coordinator, so a tool call only creates intent: the process shutdown itself stays in
 * the lifecycle/supervisor path. Every call is fail-closed and audited.
 */
export function createAdminRuntimeToolsExtension(
	options: AdminRuntimeToolsOptions,
): DurableExtension {
	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.(entry);
		} catch (error) {
			options.logger.warn("admin runtime audit failed", {
				error: error instanceof Error ? error.message : String(error),
				tool: entry.action,
			});
		}
	};

	const run = async (
		name: (typeof ADMIN_RUNTIME_TOOL_NAMES)[number],
		conversationId: string,
		body: (auth: AdminRuntimeAuthorization) => Promise<unknown>,
		extraAudit?: (result: unknown) => Record<string, unknown>,
	): Promise<
		| { output: { text: string; type: "text" }[] }
		| { isError: true; output: { text: string; type: "text" }[] }
	> => {
		let auth: AdminRuntimeAuthorization | undefined;
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
			const reason = auth?.reason ?? "admin_runtime_denied";
			await audit({
				action: `admin-runtime.${name}`,
				...(auth?.callerId === undefined ? {} : { actorId: auth.callerId }),
				actorKind: auth?.callerId === undefined ? "agent" : "user",
				payload: callerPayload(conversationId, auth, { reason }),
				reason,
				result: "denied",
				...(auth?.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-runtime",
			});
			options.logger.warn("admin runtime tool denied", {
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
			const result = await body(auth);
			await audit({
				action: `admin-runtime.${name}`,
				...(isImCaller && auth.callerId !== undefined ? { actorId: auth.callerId } : {}),
				actorKind: isImCaller && auth.callerId !== undefined ? "user" : "agent",
				payload: callerPayload(conversationId, auth, extraAudit?.(result)),
				result: "ok",
				...(auth.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-runtime",
			});
			return text(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await audit({
				action: `admin-runtime.${name}`,
				...(isImCaller && auth.callerId !== undefined ? { actorId: auth.callerId } : {}),
				actorKind: isImCaller && auth.callerId !== undefined ? "user" : "agent",
				payload: callerPayload(conversationId, auth),
				reason: message,
				result: "failed",
				...(auth.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-runtime",
			});
			options.logger.warn("admin runtime tool failed", {
				conversationId,
				error: message,
				tool: name,
			});
			return failure(error);
		}
	};

	const restart = tool({
		description:
			"Admin-only graceful restart. Schedules a durable maintenance window (default 60 seconds) that shows every new chat turn the countdown, then stops the runtime in lifecycle order so a supervisor can start it again. `mode: update` also runs dependency preparation before restarting. An existing scheduled intent is superseded.",
		name: "runtime_restart",
		parameters: {
			properties: {
				delaySeconds: {
					maximum: RUNTIME_RESTART_MAX_DELAY_SECONDS,
					minimum: 1,
					type: "integer",
				},
				mode: { enum: ["restart", "update"], type: "string" },
				reason: {
					maxLength: RUNTIME_RESTART_MAX_REASON_LENGTH,
					minLength: 1,
					type: "string",
				},
			},
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"runtime_restart",
				String(api.conversationId),
				async (auth) => {
					const delaySeconds = delaySecondsValue(input);
					const mode = modeValue(input);
					const reason = reasonValue(input);
					return await options.restart.schedule({
						...(delaySeconds === undefined
							? { delaySeconds: RUNTIME_RESTART_DEFAULT_DELAY_SECONDS }
							: { delaySeconds }),
						...(mode === undefined ? { mode: "restart" } : { mode }),
						...(reason === undefined ? {} : { reason }),
						requestedBy: requestedBy(auth),
					});
				},
				(result) => {
					const value = record(result);
					return {
						executeAt: value.executeAt,
						mode: value.mode,
						restartId: value.id,
					};
				},
			);
		},
	});

	const restartStatus = tool({
		description:
			"Admin-only graceful restart status. Returns the newest restart intent, including whether it is scheduled, executing, or terminal.",
		name: "runtime_restart_status",
		parameters: { properties: {}, type: "object" },
		async execute(_args, api) {
			return await run(
				"runtime_restart_status",
				String(api.conversationId),
				async () => await options.restart.status(),
				(result) => {
					const value = record(result);
					return typeof value.id === "string" ? { restartId: value.id, status: value.status } : {};
				},
			);
		},
	});

	const cancel = tool({
		description:
			"Admin-only graceful restart cancellation. Cancels the active scheduled restart intent and its countdown hook; a restart that is already executing cannot be cancelled here.",
		name: "runtime_restart_cancel",
		parameters: {
			properties: {
				reason: {
					maxLength: RUNTIME_RESTART_MAX_REASON_LENGTH,
					minLength: 1,
					type: "string",
				},
			},
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"runtime_restart_cancel",
				String(api.conversationId),
				async () => {
					const reason = reasonValue(input);
					const cancelled = await options.restart.cancel(
						reason ?? "cancelled by admin runtime tool",
					);
					return { cancelled, restart: await options.restart.status() };
				},
				(result) => {
					const value = record(result);
					return {
						cancelled: value.cancelled,
						restartId: record(value.restart).id,
					};
				},
			);
		},
	});

	return {
		name: ADMIN_RUNTIME_TOOLS_EXTENSION_NAME,
		tools: [restart, restartStatus, cancel],
	};
}
