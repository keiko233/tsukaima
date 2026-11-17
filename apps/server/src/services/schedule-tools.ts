import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ScheduleService } from "./schedule-service.ts";
import type { SessionMessagingService } from "./session-messaging.ts";

export const SCHEDULE_TOOLS_EXTENSION_NAME = "tsukaima-schedule-tools";
export const SCHEDULE_TOOL_NAMES = [
	"schedule_create",
	"schedule_list",
	"schedule_get",
	"schedule_update",
	"schedule_cancel",
] as const;

export interface ScheduleToolsOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly logger: Logger;
	readonly messaging: SessionMessagingService;
	readonly resolveSessionId: (durableConversationId: string) => Promise<string | undefined>;
	readonly schedules: ScheduleService;
}

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
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

function stringValue(input: Record<string, unknown>, key: string, required = false) {
	const value = input[key];
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (required) throw new Error(`${key} is required`);
	return undefined;
}

function numberValue(input: Record<string, unknown>, key: string) {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tool(input: {
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: string;
	readonly parameters: Record<string, unknown>;
	readonly surface: "chat" | "coding" | "both";
}): DurableToolRegistration {
	return {
		deferred: true,
		description: input.description,
		execute: input.execute,
		name: input.name,
		parameters: input.parameters,
		surface: input.surface,
	};
}

const recurrenceParameter = {
	description: "once, interval, or calendar recurrence; all timestamps are ISO-8601.",
	properties: {
		anchorAt: { type: "string" },
		at: { type: "string" },
		daysOfWeek: { items: { maximum: 6, minimum: 0, type: "integer" }, type: "array" },
		everyMs: { minimum: 60_000, type: "integer" },
		kind: { enum: ["once", "interval", "calendar"], type: "string" },
		startDate: { type: "string" },
		time: { type: "string" },
		until: { type: "string" },
	},
	required: ["kind"],
	type: "object",
};

/**
 * Model-visible schedule tools. They always operate on the invocation's session; cross-session
 * administration belongs to the authenticated WebUI, not to a model.
 */
export function createScheduleToolsExtension(options: ScheduleToolsOptions): DurableExtension {
	const resolveCurrentSession = async (durableConversationId: string): Promise<string> => {
		const sessionId = await options.resolveSessionId(durableConversationId);
		if (sessionId === undefined) throw new Error("Current session is not mapped to a session");
		return sessionId;
	};
	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.(entry);
		} catch (error) {
			options.logger.warn("schedule tool audit failed", {
				error: error instanceof Error ? error.message : String(error),
				tool: entry.action,
			});
		}
	};
	const run = async <T>(name: string, conversationId: string, body: () => Promise<T>) => {
		try {
			const result = await body();
			await audit({
				action: `schedule-tool.${name}`,
				actorKind: "agent",
				payload: { conversationId },
				result: "ok",
				targetKind: "schedule-tool",
			});
			return text(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await audit({
				action: `schedule-tool.${name}`,
				actorKind: "agent",
				payload: { conversationId },
				reason: message,
				result: "failed",
				targetKind: "schedule-tool",
			});
			return failure(error);
		}
	};
	const ownedSchedule = async (sessionId: string, scheduleId: string) => {
		const detail = await options.schedules.get(scheduleId);
		if (detail === null) throw new Error("Schedule not found");
		if (detail.targetSessionId !== sessionId) throw new Error("Schedule is outside this session");
		if (detail.ownerKind !== "agent")
			throw new Error("Agent tools may only change agent schedules");
		return detail;
	};

	const create = tool({
		description:
			"Create a durable reminder, recurring check-in, or delayed agent turn in the current session. Use this instead of promising to remember something later.",
		name: "schedule_create",
		parameters: {
			properties: {
				actionKind: { enum: ["agent_turn", "notify"], type: "string" },
				dedupeKey: { type: "string" },
				maxRuns: { minimum: 1, type: "integer" },
				prompt: { type: "string" },
				recurrence: recurrenceParameter,
				timeZone: { type: "string" },
				title: { type: "string" },
			},
			required: ["prompt", "recurrence", "title", "timeZone"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			const conversationId = String(api.conversationId);
			return run("schedule_create", conversationId, async () => {
				const sessionId = await resolveCurrentSession(conversationId);
				const session = await options.messaging.session(sessionId);
				const actionKind = input.actionKind === "notify" ? "notify" : "agent_turn";
				if (session.session.kind === "workspace" && actionKind !== "notify") {
					const detail = await options.schedules.create({
						actionKind: "workspace_turn",
						...(stringValue(input, "dedupeKey") === undefined
							? {}
							: { dedupeKey: stringValue(input, "dedupeKey")! }),
						...(numberValue(input, "maxRuns") === undefined
							? {}
							: { maxRuns: numberValue(input, "maxRuns")! }),
						ownerId: api.userId ?? "agent",
						ownerKind: "agent",
						prompt: stringValue(input, "prompt", true)!,
						recurrence: input.recurrence as never,
						source: "workspace-tool",
						targetSessionId: sessionId,
						timeZone: stringValue(input, "timeZone", true)!,
						title: stringValue(input, "title", true)!,
					});
					return {
						nextRunAt: detail.nextRunAt,
						scheduleId: detail.id,
						status: detail.status,
					};
				}
				const detail = await options.schedules.create({
					actionKind,
					...(stringValue(input, "dedupeKey") === undefined
						? {}
						: { dedupeKey: stringValue(input, "dedupeKey")! }),
					...(numberValue(input, "maxRuns") === undefined
						? {}
						: { maxRuns: numberValue(input, "maxRuns")! }),
					ownerId: api.userId ?? "agent",
					ownerKind: "agent",
					prompt: stringValue(input, "prompt", true)!,
					recurrence: input.recurrence as never,
					source: session.session.kind === "workspace" ? "workspace-tool" : "chat-tool",
					targetSessionId: sessionId,
					timeZone: stringValue(input, "timeZone", true)!,
					title: stringValue(input, "title", true)!,
				});
				return {
					nextRunAt: detail.nextRunAt,
					scheduleId: detail.id,
					status: detail.status,
				};
			});
		},
	});

	const list = tool({
		description: "List durable schedules for the current session, including their next run.",
		name: "schedule_list",
		parameters: {
			properties: {
				status: { enum: ["active", "paused", "completed", "cancelled", "failed"], type: "string" },
			},
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			const conversationId = String(api.conversationId);
			return run("schedule_list", conversationId, async () => {
				const sessionId = await resolveCurrentSession(conversationId);
				const status =
					input.status === "active" ||
					input.status === "paused" ||
					input.status === "completed" ||
					input.status === "cancelled" ||
					input.status === "failed"
						? input.status
						: undefined;
				const rows = await options.schedules.list({
					limit: 50,
					sessionId,
					...(status === undefined ? {} : { status }),
				});
				return {
					schedules: rows.map((row) => ({
						actionKind: row.actionKind,
						id: row.id,
						nextRunAt: row.nextRunAt,
						status: row.status,
						title: row.title,
					})),
				};
			});
		},
	});

	const get = tool({
		description: "Read one durable schedule and its recent occurrence history.",
		name: "schedule_get",
		parameters: {
			properties: { scheduleId: { type: "string" } },
			required: ["scheduleId"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			const conversationId = String(api.conversationId);
			return run("schedule_get", conversationId, async () => {
				const sessionId = await resolveCurrentSession(conversationId);
				const detail = await ownedSchedule(sessionId, stringValue(input, "scheduleId", true)!);
				return {
					occurrences: detail.occurrences.slice(0, 10),
					schedule: detail,
				};
			});
		},
	});

	const update = tool({
		description: "Update an agent-created schedule in the current session.",
		name: "schedule_update",
		parameters: {
			properties: {
				prompt: { type: "string" },
				recurrence: recurrenceParameter,
				scheduleId: { type: "string" },
				title: { type: "string" },
			},
			required: ["scheduleId"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			const conversationId = String(api.conversationId);
			return run("schedule_update", conversationId, async () => {
				const sessionId = await resolveCurrentSession(conversationId);
				const scheduleId = stringValue(input, "scheduleId", true)!;
				await ownedSchedule(sessionId, scheduleId);
				const detail = await options.schedules.update({
					scheduleId,
					...(stringValue(input, "prompt") === undefined
						? {}
						: { prompt: stringValue(input, "prompt")! }),
					...(input.recurrence === undefined ? {} : { recurrence: input.recurrence as never }),
					...(stringValue(input, "title") === undefined
						? {}
						: { title: stringValue(input, "title")! }),
				});
				return { nextRunAt: detail.nextRunAt, scheduleId: detail.id, status: detail.status };
			});
		},
	});

	const cancel = tool({
		description: "Cancel an agent-created schedule in the current session.",
		name: "schedule_cancel",
		parameters: {
			properties: { scheduleId: { type: "string" } },
			required: ["scheduleId"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			const conversationId = String(api.conversationId);
			return run("schedule_cancel", conversationId, async () => {
				const sessionId = await resolveCurrentSession(conversationId);
				const scheduleId = stringValue(input, "scheduleId", true)!;
				await ownedSchedule(sessionId, scheduleId);
				const summary = await options.schedules.cancel(scheduleId);
				return { scheduleId: summary.id, status: summary.status };
			});
		},
	});

	return {
		name: SCHEDULE_TOOLS_EXTENSION_NAME,
		tools: [create, list, get, update, cancel],
	};
}
