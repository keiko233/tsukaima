import type { PluginContext, ToolResult } from "@tsukaima/sdk";
import { scheduledTaskKindSchema } from "./domain.ts";
import type { ProactiveSchedulerService } from "./service.ts";

const text = (value: unknown): ToolResult => ({
	content: [{ text: typeof value === "string" ? value : JSON.stringify(value), type: "text" }],
});

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

/** Registers the `proactive-scheduler.*` model tools under host-enforced ToolPolicy. */
export function registerProactiveSchedulerTools(
	context: PluginContext,
	service: ProactiveSchedulerService,
): void {
	context.tools.register({
		description:
			"Schedule a durable reminder, nudge, proactive message, or workflow follow-up in the current conversation. Bounds are enforced by policy.",
		async execute(input, invocation) {
			const conversationId = invocation.conversationId;
			if (conversationId === undefined || conversationId.trim().length === 0) {
				return text({ error: "conversation_required" });
			}
			try {
				const requested = asString(input, "conversationId");
				if (requested !== undefined && requested !== conversationId) {
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
			maxConcurrent: 2,
			maxPayloadBytes: 16_384,
			timeoutMs: 15_000,
		},
		requiredPermissions: ["tasks.create", "conversation.read"],
	});
	context.tools.register({
		description:
			"List durable proactive/scheduled tasks. Conversation-scoped by default; admins may query another conversation.",
		async execute(input, invocation) {
			const requested = asString(input, "conversationId");
			const conversationId = invocation.conversationId;
			if (requested !== undefined && requested !== conversationId && !isAdmin(invocation)) {
				return await deny(context, "cross_conversation_denied", input, invocation);
			}
			if (requested === undefined && conversationId === undefined && !isAdmin(invocation)) {
				return await deny(context, "conversation_required", input, invocation);
			}
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
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tasks.list", "conversation.read"],
	});
	context.tools.register({
		description:
			"Cancel one proactive/scheduled task, or every scheduled task in the current conversation. Cross-conversation bulk cancel is admin only.",
		async execute(input, invocation) {
			const taskId = asString(input, "taskId");
			const requested = asString(input, "conversationId");
			const conversationId = invocation.conversationId;
			const global = input.scope === "global";
			if (global && !isAdmin(invocation)) {
				return await deny(context, "admin_required", input, invocation);
			}
			if (taskId !== undefined) {
				const task = await service.repository.getTask(taskId);
				if (task === undefined) return text({ error: "unknown_task" });
				if (task.conversationId !== conversationId && !isAdmin(invocation)) {
					return await deny(context, "cross_conversation_denied", input, invocation);
				}
				return text({ cancelled: await service.cancelTask(taskId, invocation.userId ?? "agent") });
			}
			if (requested !== undefined && requested !== conversationId && !isAdmin(invocation)) {
				return await deny(context, "cross_conversation_denied", input, invocation);
			}
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
			maxConcurrent: 2,
			maxPayloadBytes: 4_096,
			timeoutMs: 10_000,
		},
		requiredPermissions: ["tasks.cancel", "conversation.read"],
	});
	context.tools.register({
		description: "Read the status and recent decision/run history for one scheduled task in scope.",
		async execute(input, invocation) {
			const taskId = asString(input, "taskId");
			if (taskId === undefined) return text({ error: "taskId_required" });
			const result = await service.getTask(taskId);
			if (result === undefined) return text({ error: "unknown_task" });
			if (result.task.conversationId !== invocation.conversationId && !isAdmin(invocation)) {
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
		policy: { maxConcurrent: 4, maxPayloadBytes: 4_096, timeoutMs: 10_000 },
		requiredPermissions: ["tasks.get", "conversation.read"],
	});
}
