import type { PluginContext, PluginLogger, PluginTool, ToolResult } from "@tsukaima/sdk";
import { scheduledTaskKindSchema } from "./domain.ts";
import type { ProactiveSchedulerService } from "./service.ts";

const text = (value: unknown): ToolResult => ({
	content: [{ text: typeof value === "string" ? value : JSON.stringify(value), type: "text" }],
});

/** Extracts the plugin-level `{ error }` payload a tool returns for a denied/failed call. */
function toolResultError(result: ToolResult): string | undefined {
	const first = result.content[0];
	if (first === undefined) return undefined;
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

/** Wraps a tool registration with trace/debug timing without changing its behavior. */
function tracedTool(context: PluginContext, tool: PluginTool): PluginTool {
	const logger: PluginLogger = context.logger.child?.("tools") ?? context.logger;
	return {
		...tool,
		async execute(input, invocation) {
			const startedAtMs = Date.now();
			const conversationId = invocation.conversationId ?? null;
			logger.trace("plugin tool invoked", {
				actor: invocation.userId ?? null,
				conversationId,
				inputKeys: Object.keys(input ?? {}),
				isAdmin: invocation.isAdmin === true,
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

const asString = (input: Record<string, unknown>, key: string): string | undefined => {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const asNumber = (input: Record<string, unknown>, key: string): number | undefined => {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

function isAdmin(invocation: { readonly isAdmin?: boolean; readonly role?: string }): boolean {
	return invocation.isAdmin === true || invocation.role === "admin";
}

async function deny(
	context: PluginContext,
	reason: string,
	input: Record<string, unknown>,
	invocation: { readonly userId?: string },
): Promise<ToolResult> {
	const targetId =
		asString(input, "taskId") ?? asString(input, "conversationId") ?? invocation.userId;
	try {
		await context.audit?.record({
			action: "proactive.tool.denied",
			actorId: invocation.userId ?? "agent",
			actorKind: invocation.userId === undefined ? "agent" : "user",
			payload: {
				reason,
				...(asString(input, "conversationId") === undefined
					? {}
					: { conversationId: asString(input, "conversationId") }),
				...(asString(input, "taskId") === undefined ? {} : { taskId: asString(input, "taskId") }),
			},
			reason,
			result: "denied",
			...(targetId === undefined ? {} : { targetId }),
			targetKind: asString(input, "taskId") === undefined ? "conversation" : "proactive-task",
		});
	} catch {}
	return text({ error: reason });
}

function scheduleInput(input: Record<string, unknown>) {
	const repeatRecord =
		typeof input.repeat === "object" && input.repeat !== null
			? (input.repeat as Record<string, unknown>)
			: undefined;
	const repeat =
		repeatRecord === undefined
			? undefined
			: {
					intervalMs: Number(repeatRecord.intervalMs),
					...(typeof repeatRecord.maxOccurrences === "number"
						? { maxOccurrences: repeatRecord.maxOccurrences }
						: {}),
					...(typeof repeatRecord.untilMs === "number" ? { untilMs: repeatRecord.untilMs } : {}),
				};
	const kind = scheduledTaskKindSchema.safeParse(input.kind);
	return {
		...(input.cancelIfReplied === true ? { cancelIfReplied: true } : {}),
		conversationId: asString(input, "conversationId") ?? "",
		delayMs: Math.max(0, Math.floor(asNumber(input, "delayMs") ?? 0)),
		...(asNumber(input, "dueWindowMs") === undefined
			? {}
			: { dueWindowMs: Math.floor(asNumber(input, "dueWindowMs")!) }),
		kind: kind.success ? kind.data : "remind",
		...(asNumber(input, "maxAttempts") === undefined
			? {}
			: { maxAttempts: Math.floor(asNumber(input, "maxAttempts")!) }),
		prompt: asString(input, "prompt") ?? "",
		...(repeat === undefined ? {} : { repeat }),
	};
}

async function resolveConversationScope(
	context: PluginContext,
	conversationId: string | undefined,
): Promise<{ readonly canonicalId?: string; readonly aliases: ReadonlySet<string> }> {
	if (conversationId === undefined || conversationId.trim().length === 0) {
		return { aliases: new Set() };
	}
	const trimmed = conversationId.trim();
	const aliases = new Set<string>([trimmed]);
	try {
		const found = await context.conversations?.get(trimmed);
		if (found !== undefined) {
			aliases.add(found.id);
			aliases.add(found.durableConversationId);
			return { aliases, canonicalId: found.id };
		}
	} catch {}
	return { aliases, canonicalId: trimmed };
}

/** Registers the `proactive-scheduler.*` model tools under host-enforced ToolPolicy. */
export function registerProactiveSchedulerTools(
	context: PluginContext,
	service: ProactiveSchedulerService,
): void {
	const register = (tool: PluginTool): void => context.tools.register(tracedTool(context, tool));
	register({
		description:
			"Schedule a durable reminder, nudge, proactive message, or workflow follow-up in the current conversation. Bounds are enforced by policy.",
		async execute(input, invocation) {
			const scope = await resolveConversationScope(context, invocation.conversationId);
			const conversationId = scope.canonicalId;
			if (conversationId === undefined || conversationId.trim().length === 0) {
				return text({ error: "conversation_required" });
			}
			try {
				const requested = asString(input, "conversationId");
				if (requested !== undefined && !scope.aliases.has(requested)) {
					return await deny(context, "cross_conversation_denied", input, invocation);
				}
				const task = await service.createTask(
					{ ...scheduleInput(input), conversationId },
					conversationId,
					{ id: invocation.userId ?? "agent", kind: "agent" },
				);
				return text({
					conversationId: task.conversationId,
					dueAtMs: task.scheduledForMs,
					kind: task.kind,
					status: task.status,
					taskId: task.id,
				});
			} catch (error) {
				return text({ error: error instanceof Error ? error.message : String(error) });
			}
		},
		name: "proactive-scheduler.schedule",
		parameters: {
			properties: {
				cancelIfReplied: { type: "boolean" },
				delayMs: { minimum: 0, type: "integer" },
				dueWindowMs: { minimum: 1, type: "integer" },
				kind: { enum: ["remind", "nudge", "proactive", "workflow"], type: "string" },
				maxAttempts: { maximum: 10, minimum: 1, type: "integer" },
				prompt: { type: "string" },
				repeat: {
					properties: {
						intervalMs: { minimum: 1000, type: "integer" },
						maxOccurrences: { minimum: 1, type: "integer" },
						untilMs: { minimum: 0, type: "integer" },
					},
					required: ["intervalMs"],
					type: "object",
				},
			},
			required: ["prompt"],
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			lazy: false,
			maxConcurrent: 2,
			maxPayloadBytes: 16_384,
			surface: "both",
			timeoutMs: 15_000,
		},
		requiredPermissions: ["tasks.create", "conversation.read"],
	});
	register({
		description:
			"List durable proactive/scheduled tasks. Conversation-scoped by default; admins may query another conversation.",
		async execute(input, invocation) {
			const scope = await resolveConversationScope(context, invocation.conversationId);
			const requestedRaw = asString(input, "conversationId");
			const conversationId = scope.canonicalId;
			if (requestedRaw !== undefined && !scope.aliases.has(requestedRaw) && !isAdmin(invocation)) {
				return await deny(context, "cross_conversation_denied", input, invocation);
			}
			if (requestedRaw === undefined && conversationId === undefined && !isAdmin(invocation)) {
				return await deny(context, "conversation_required", input, invocation);
			}
			const requested =
				requestedRaw !== undefined && scope.aliases.has(requestedRaw)
					? (conversationId ?? requestedRaw)
					: requestedRaw;
			const kind = scheduledTaskKindSchema.safeParse(input.kind);
			const tasks = await service.listTasks({
				...(requested === undefined ? {} : { conversationId: requested }),
				...(requested === undefined && conversationId !== undefined && !isAdmin(invocation)
					? { conversationId }
					: {}),
				...(kind.success ? { kind: kind.data } : {}),
				limit: 50,
			});
			return text({
				tasks: tasks.map((task) => ({
					dueAtMs: task.scheduledForMs,
					kind: task.kind,
					status: task.status,
					taskId: task.id,
				})),
			});
		},
		name: "proactive-scheduler.list",
		parameters: {
			properties: {
				conversationId: { type: "string" },
				kind: { enum: ["remind", "nudge", "proactive", "workflow"], type: "string" },
			},
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			lazy: false,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "both",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tasks.list", "conversation.read"],
	});
	register({
		description:
			"Cancel one proactive/scheduled task, or every scheduled task in the current conversation. Cross-conversation bulk cancel is admin only.",
		async execute(input, invocation) {
			const scope = await resolveConversationScope(context, invocation.conversationId);
			const taskId = asString(input, "taskId");
			const requestedRaw = asString(input, "conversationId");
			const conversationId = scope.canonicalId;
			const global = input.scope === "global";
			if (global && !isAdmin(invocation)) {
				return await deny(context, "admin_required", input, invocation);
			}
			if (taskId !== undefined) {
				const found = await service.getTask(taskId);
				if (found === undefined) return text({ error: "unknown_task" });
				if (!scope.aliases.has(found.task.conversationId) && !isAdmin(invocation)) {
					return await deny(context, "cross_conversation_denied", input, invocation);
				}
				return text({ cancelled: await service.cancelTask(taskId, invocation.userId ?? "agent") });
			}
			if (requestedRaw !== undefined && !scope.aliases.has(requestedRaw) && !isAdmin(invocation)) {
				return await deny(context, "cross_conversation_denied", input, invocation);
			}
			const requested =
				requestedRaw !== undefined && scope.aliases.has(requestedRaw)
					? (conversationId ?? requestedRaw)
					: requestedRaw;
			const target = requested ?? conversationId;
			if (target === undefined) {
				if (!isAdmin(invocation)) {
					return await deny(context, "conversation_required", input, invocation);
				}
				const all = await service.listTasks({ status: ["scheduled", "running"], limit: 500 });
				const cancelled = [];
				for (const task of all) {
					const next = await service.cancelTask(task.id, invocation.userId ?? "admin");
					if (next !== undefined) cancelled.push(next.id);
				}
				return text({ cancelled });
			}
			const cancelled = await service.cancelConversation(target, invocation.userId ?? "agent");
			return text({ cancelled: cancelled.map((task) => task.id) });
		},
		name: "proactive-scheduler.cancel",
		parameters: {
			properties: {
				conversationId: { type: "string" },
				scope: { enum: ["conversation", "global"], type: "string" },
				taskId: { type: "string" },
			},
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			destructive: true,
			lazy: false,
			maxConcurrent: 2,
			maxPayloadBytes: 4_096,
			surface: "both",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tasks.cancel", "conversation.read"],
	});
	register({
		description: "Read the status and recent decision/run history for one scheduled task in scope.",
		async execute(input, invocation) {
			const scope = await resolveConversationScope(context, invocation.conversationId);
			const taskId = asString(input, "taskId");
			if (taskId === undefined) return text({ error: "taskId_required" });
			const result = await service.getTask(taskId);
			if (result === undefined) return text({ error: "unknown_task" });
			if (!scope.aliases.has(result.task.conversationId) && !isAdmin(invocation)) {
				return await deny(context, "cross_conversation_denied", input, invocation);
			}
			return text({
				decisions: result.decisions.map((decision) => ({
					createdAtMs: decision.createdAtMs,
					deliveryStatus: decision.deliveryStatus,
					gateResult: decision.gateResult,
					marker: decision.marker,
				})),
				task: {
					attempts: result.task.attempts,
					dueAtMs: result.task.scheduledForMs,
					kind: result.task.kind,
					lastError: result.task.lastError,
					occurrences: result.task.occurrences,
					status: result.task.status,
					taskId: result.task.id,
				},
			});
		},
		name: "proactive-scheduler.get",
		parameters: {
			properties: { taskId: { type: "string" } },
			required: ["taskId"],
			type: "object",
		},
		policy: {
			lazy: true,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "both",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tasks.get", "conversation.read"],
	});
}
