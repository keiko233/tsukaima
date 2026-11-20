import { type ScheduleRecurrence, scheduleRecurrenceSchema } from "@tsukaima/contracts";
import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ScheduleService } from "./schedule-service.ts";
import { isValidTimeZone } from "./schedule-time.ts";
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

function booleanValue(input: Record<string, unknown>, key: string): boolean | undefined {
	const value = input[key];
	return typeof value === "boolean" ? value : undefined;
}

function defaultTimeZone(): string {
	const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return typeof detected === "string" && isValidTimeZone(detected) ? detected : "UTC";
}

function defaultTitleFromPrompt(prompt: string): string {
	const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "Scheduled reminder";
	return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

/**
 * Normalize explicit `recurrence` or IM convenience shorthands (`at` ISO timestamp or `delayMs`
 * relative delay) into a canonical host `ScheduleRecurrence`.
 */
function resolveRecurrence(input: Record<string, unknown>, nowMs: number): ScheduleRecurrence {
	if (typeof input.recurrence === "object" && input.recurrence !== null) {
		return scheduleRecurrenceSchema.parse(input.recurrence);
	}
	const at = stringValue(input, "at");
	if (at !== undefined) {
		const parsed = Date.parse(at);
		if (!Number.isFinite(parsed)) throw new Error("at must be a valid ISO-8601 timestamp");
		return { at: new Date(parsed).toISOString(), kind: "once" };
	}
	const delayMs = numberValue(input, "delayMs");
	if (delayMs !== undefined) {
		if (delayMs < 0) throw new Error("delayMs must be non-negative");
		return { at: new Date(nowMs + Math.floor(delayMs)).toISOString(), kind: "once" };
	}
	throw new Error("recurrence, at, or delayMs is required");
}

function tool(input: {
	readonly deferred?: boolean;
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: string;
	readonly parameters: Record<string, unknown>;
	readonly surface: "chat" | "coding" | "both";
}): DurableToolRegistration {
	return {
		...(input.deferred === false ? {} : { deferred: true }),
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
		deferred: false,
		description:
			"Create a durable reminder, recurring check-in, or delayed agent turn in the current session. Supports absolute ISO-8601 timestamps (`at` or `recurrence`), IANA `timeZone`, recurrence (`once`, `interval`, `calendar`), `cancelIfReplied`, `flexWindowMs`, and quiet-hours deferral for one-off reminders.",
		name: "schedule_create",
		parameters: {
			properties: {
				actionKind: { enum: ["agent_turn", "notify"], type: "string" },
				at: {
					description:
						"Shorthand ISO-8601 timestamp with offset for a one-off reminder (alternative to recurrence).",
					type: "string",
				},
				cancelIfReplied: {
					description:
						"If true, automatically cancel this reminder/check-in if the user replies before it fires.",
					type: "boolean",
				},
				dedupeKey: { type: "string" },
				delayMs: {
					description:
						"Shorthand relative delay in milliseconds for a one-off reminder (alternative to recurrence/at).",
					minimum: 0,
					type: "integer",
				},
				dueWindowMs: {
					description: "Alias for flexWindowMs: skip if firing falls past this window in ms.",
					minimum: 1,
					type: "integer",
				},
				flexWindowMs: {
					description: "Optional flex window in ms after the scheduled time before expiring.",
					minimum: 1,
					type: "integer",
				},
				maxRuns: { minimum: 1, type: "integer" },
				prompt: { type: "string" },
				recurrence: recurrenceParameter,
				respectQuietHours: {
					description:
						"Whether to honor conversation quiet hours. Defaults to true for IM conversations; one-off reminders defer to quiet-hours end.",
					type: "boolean",
				},
				timeZone: {
					description: "IANA time zone (e.g. Asia/Shanghai, UTC). Defaults to the host time zone.",
					type: "string",
				},
				title: { type: "string" },
			},
			required: ["prompt"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			const conversationId = String(api.conversationId);
			return run("schedule_create", conversationId, async () => {
				const sessionId = await resolveCurrentSession(conversationId);
				const session = await options.messaging.session(sessionId);
				const isImChat = session.chat.kind === "private" || session.chat.kind === "group";
				const prompt = stringValue(input, "prompt", true)!;
				const title = stringValue(input, "title") ?? defaultTitleFromPrompt(prompt);
				const timeZone = stringValue(input, "timeZone") ?? defaultTimeZone();
				const recurrence = resolveRecurrence(input, Date.now());
				const cancelIfReplied = booleanValue(input, "cancelIfReplied");
				const flexWindowMs =
					numberValue(input, "flexWindowMs") ?? numberValue(input, "dueWindowMs");
				const respectQuietHours = booleanValue(input, "respectQuietHours") ?? isImChat;
				const actionKind = input.actionKind === "notify" ? "notify" : "agent_turn";
				const resolvedActionKind =
					session.session.kind === "workspace" && actionKind !== "notify"
						? ("workspace_turn" as const)
						: actionKind;
				const detail = await options.schedules.create({
					actionKind: resolvedActionKind,
					...(cancelIfReplied === undefined ? {} : { cancelIfReplied }),
					...(stringValue(input, "dedupeKey") === undefined
						? {}
						: { dedupeKey: stringValue(input, "dedupeKey")! }),
					...(flexWindowMs === undefined ? {} : { flexWindowMs: Math.floor(flexWindowMs) }),
					...(numberValue(input, "maxRuns") === undefined
						? {}
						: { maxRuns: numberValue(input, "maxRuns")! }),
					ownerId: "agent",
					ownerKind: "agent",
					prompt,
					recurrence,
					respectQuietHours,
					source: session.session.kind === "workspace" ? "workspace-tool" : "chat-tool",
					targetSessionId: sessionId,
					timeZone,
					title,
				});
				return {
					cancelIfReplied: detail.cancelIfReplied,
					flexWindowMs: detail.flexWindowMs,
					nextRunAt: detail.nextRunAt,
					respectQuietHours: detail.respectQuietHours,
					scheduleId: detail.id,
					status: detail.status,
					timeZone: detail.timeZone,
				};
			});
		},
	});

	const list = tool({
		deferred: false,
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
				cancelIfReplied: { type: "boolean" },
				flexWindowMs: { minimum: 1, type: "integer" },
				prompt: { type: "string" },
				recurrence: recurrenceParameter,
				respectQuietHours: { type: "boolean" },
				scheduleId: { type: "string" },
				timeZone: { type: "string" },
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
				const cancelIfReplied = booleanValue(input, "cancelIfReplied");
				const flexWindowMs = numberValue(input, "flexWindowMs");
				const respectQuietHours = booleanValue(input, "respectQuietHours");
				const detail = await options.schedules.update({
					scheduleId,
					...(cancelIfReplied === undefined ? {} : { cancelIfReplied }),
					...(flexWindowMs === undefined ? {} : { flexWindowMs: Math.floor(flexWindowMs) }),
					...(stringValue(input, "prompt") === undefined
						? {}
						: { prompt: stringValue(input, "prompt")! }),
					...(input.recurrence === undefined
						? {}
						: { recurrence: scheduleRecurrenceSchema.parse(input.recurrence) }),
					...(respectQuietHours === undefined ? {} : { respectQuietHours }),
					...(stringValue(input, "timeZone") === undefined
						? {}
						: { timeZone: stringValue(input, "timeZone")! }),
					...(stringValue(input, "title") === undefined
						? {}
						: { title: stringValue(input, "title")! }),
				});
				return { nextRunAt: detail.nextRunAt, scheduleId: detail.id, status: detail.status };
			});
		},
	});

	const cancel = tool({
		deferred: false,
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
