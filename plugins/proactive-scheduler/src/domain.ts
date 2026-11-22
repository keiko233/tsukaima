import {
	PROACTIVE_LURK_MARKER,
	PROACTIVE_SCHEDULE_LATER_MARKER,
	PROACTIVE_SKIP_MARKER,
} from "@tsukaima/contracts";
import { isUndefined, omitBy } from "es-toolkit";
import { z } from "zod";

export const scheduledTaskKindSchema = z.enum(["remind", "nudge", "proactive", "workflow"]);
export type ScheduledTaskKind = z.infer<typeof scheduledTaskKindSchema>;

export const scheduledTaskStatusSchema = z.enum([
	"scheduled",
	"running",
	"completed",
	"cancelled",
	"failed",
	"skipped",
]);
export type ScheduledTaskStatus = z.infer<typeof scheduledTaskStatusSchema>;

export const repeatSchema = z
	.object({
		intervalMs: z.number().int().min(1_000),
		maxOccurrences: z.number().int().min(1).max(1_000).optional(),
		untilMs: z.number().int().nonnegative().optional(),
	})
	.strict();
export type ScheduledTaskRepeat = z.infer<typeof repeatSchema>;

export interface ScheduledTask {
	readonly id: string;
	readonly taskId: string;
	/** Stable origin key for a task materialized from a durable follow-up intent. */
	readonly dedupeKey: string | null;
	readonly conversationId: string;
	readonly chatObjectId: string | null;
	readonly kind: ScheduledTaskKind;
	readonly prompt: string;
	readonly scheduledForMs: number;
	readonly dueWindowMs: number | null;
	readonly repeat: ScheduledTaskRepeat | null;
	readonly cancelIfReplied: boolean;
	readonly maxAttempts: number;
	readonly attempts: number;
	readonly occurrences: number;
	readonly status: ScheduledTaskStatus;
	readonly lastError: string | null;
	readonly createdByKind: "user" | "agent" | "admin";
	readonly createdById: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export const quietRangeSchema = z
	.object({
		start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
		end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
	})
	.strict();
export type QuietRange = z.infer<typeof quietRangeSchema>;

export const quietHoursSchema = z
	.object({
		enabled: z.boolean().default(false),
		timezoneOffsetMinutes: z.number().int().min(-840).max(840).default(0),
		ranges: z.array(quietRangeSchema).max(12).default([]),
	})
	.strict();
export type ProactiveQuietHours = z.infer<typeof quietHoursSchema>;

export const proactivePolicySchema = z
	.object({
		enabled: z.boolean().default(false),
		allowRemind: z.boolean().default(true),
		allowNudge: z.boolean().default(true),
		allowProactive: z.boolean().default(true),
		quietHours: quietHoursSchema.default({
			enabled: false,
			ranges: [],
			timezoneOffsetMinutes: 0,
		}),
		dailyCap: z.number().int().min(0).max(1_000).default(5),
		hourlyCap: z.number().int().min(0).max(1_000).default(2),
		cooldownMs: z
			.number()
			.int()
			.min(0)
			.max(7 * 24 * 3_600_000)
			.default(15 * 60_000),
		backoffMs: z
			.number()
			.int()
			.min(0)
			.max(7 * 24 * 3_600_000)
			.default(10 * 60_000),
		minMessages: z.number().int().min(0).max(1_000).default(3),
		minIdleMs: z
			.number()
			.int()
			.min(0)
			.max(30 * 24 * 3_600_000)
			.default(20 * 60_000),
		maxIdleMs: z
			.number()
			.int()
			.min(0)
			.max(30 * 24 * 3_600_000)
			.default(6 * 3_600_000),
		minWarmness: z.number().min(0).max(1).default(0.25),
		probability: z.number().min(0).max(1).default(0.15),
		bubbleGate: z.boolean().default(false),
		maxDelayMs: z
			.number()
			.int()
			.min(1_000)
			.max(30 * 24 * 3_600_000)
			.default(86_400_000),
		maxPendingPerConversation: z.number().int().min(1).max(200).default(10),
		maxAttempts: z.number().int().min(1).max(10).default(3),
	})
	.strict();
export type ProactivePolicy = z.infer<typeof proactivePolicySchema>;

export const proactivePolicyPatchSchema = proactivePolicySchema.partial();
export type ProactivePolicyPatch = z.infer<typeof proactivePolicyPatchSchema>;

export const DEFAULT_PROACTIVE_POLICY: ProactivePolicy = proactivePolicySchema.parse({});
export const GLOBAL_POLICY_SCOPE = "global";
export const CONVERSATION_POLICY_SCOPE = "conversation";
export const PERSONA_POLICY_SCOPE = "persona";

export interface ProactiveState {
	readonly conversationId: string;
	readonly lastMessageAtMs: number | null;
	readonly lastInboundAtMs: number | null;
	readonly lastOutboundAtMs: number | null;
	readonly inboundCount: number;
	readonly unansweredStreak: number;
	readonly refusedCount: number;
	readonly silenceUntilMs: number | null;
	readonly activeHoursHistogram: Readonly<Record<string, number>>;
	readonly warmness: number;
	readonly openers: readonly string[];
	readonly dailyCountDate: string | null;
	readonly dailyCount: number;
	readonly hourlyWindowMs: number | null;
	readonly hourlyCount: number;
	readonly updatedAtMs: number;
}

export function emptyState(conversationId: string, nowMs: number): ProactiveState {
	return {
		activeHoursHistogram: {},
		conversationId,
		dailyCount: 0,
		dailyCountDate: null,
		hourlyCount: 0,
		hourlyWindowMs: null,
		inboundCount: 0,
		lastInboundAtMs: null,
		lastMessageAtMs: null,
		lastOutboundAtMs: null,
		openers: [],
		refusedCount: 0,
		silenceUntilMs: null,
		unansweredStreak: 0,
		updatedAtMs: nowMs,
		warmness: 0,
	};
}

export type GateStatus = "passed" | "blocked" | "info";

export interface GateResult {
	readonly gate: string;
	readonly status: GateStatus;
	readonly reason?: string;
	readonly detail?: string;
}

export interface DecisionRecord {
	readonly id: string;
	readonly taskId: string | null;
	readonly kind: string;
	readonly conversationId: string;
	readonly gates: readonly GateResult[];
	readonly gateResult: "eligible" | "skipped" | "delivered" | "failed" | "suppressed";
	readonly marker: string | null;
	readonly deliveryStatus: string | null;
	readonly skippedReason: string | null;
	readonly createdAtMs: number;
}

export interface TaskCreateRequest {
	readonly conversationId: string;
	readonly chatObjectId?: string;
	readonly kind: ScheduledTaskKind;
	readonly prompt: string;
	readonly delayMs: number;
	readonly dueWindowMs?: number;
	readonly repeat?: ScheduledTaskRepeat;
	readonly cancelIfReplied?: boolean;
	readonly maxAttempts?: number;
	readonly createdBy: { readonly kind: "user" | "agent" | "admin"; readonly id: string };
}

export const taskCreateInputSchema = z
	.object({
		at: z.string().datetime({ offset: true }).optional(),
		cancelIfReplied: z.boolean().optional(),
		chatObjectId: z.string().min(1).optional(),
		conversationId: z.string().min(1),
		delayMs: z.number().int().min(0),
		dueWindowMs: z
			.number()
			.int()
			.min(1)
			.max(24 * 3_600_000)
			.optional(),
		kind: scheduledTaskKindSchema.default("remind"),
		maxAttempts: z.number().int().min(1).max(10).optional(),
		prompt: z.string().trim().min(1).max(100_000),
		repeat: repeatSchema.optional(),
		timeZone: z.string().min(1).max(100).optional(),
	})
	.strict();

/** Parse a `HH:MM` string into minutes since local midnight. */
export function minutesOfDay(value: string): number {
	const [hours, minutes] = value.split(":").map((part) => Number(part));
	return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Quiet-hours match with wrap-around support (`22:00-07:00`). The timezone offset is applied
 * before reading UTC hours so tests and deployments stay deterministic.
 */
export function isQuietHours(
	quiet: ProactiveQuietHours,
	nowMs: number,
	timezoneOffsetMinutes = quiet.timezoneOffsetMinutes,
): boolean {
	if (!quiet.enabled || quiet.ranges.length === 0) return false;
	const localMs = nowMs + timezoneOffsetMinutes * 60_000;
	const date = new Date(localMs);
	const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
	for (const range of quiet.ranges) {
		const start = minutesOfDay(range.start);
		const end = minutesOfDay(range.end);
		if (start === end) return true;
		if (start < end) {
			if (minutes >= start && minutes < end) return true;
		} else if (minutes >= start || minutes < end) {
			return true;
		}
	}
	return false;
}

/**
 * Compute the next UTC instant after `nowMs` when configured quiet hours end, respecting
 * `timezoneOffsetMinutes` and wrap-around or adjacent ranges. Returns `undefined` if quiet hours
 * are disabled, `nowMs` is not in quiet hours, or the configured ranges cover all 24 hours.
 */
export function nextQuietHoursEndMs(
	quiet: ProactiveQuietHours,
	nowMs: number,
	timezoneOffsetMinutes = quiet.timezoneOffsetMinutes,
): number | undefined {
	if (!quiet.enabled || quiet.ranges.length === 0) return undefined;
	if (!isQuietHours(quiet, nowMs, timezoneOffsetMinutes)) return undefined;
	const offsetMs = timezoneOffsetMinutes * 60_000;
	const dayMs = 24 * 60 * 60_000;
	let cursorMs = nowMs;
	for (let step = 0; step <= quiet.ranges.length; step += 1) {
		const localMs = cursorMs + offsetMs;
		const localDate = new Date(localMs);
		const localMidnightUtcMs =
			Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()) -
			offsetMs;
		const minutes = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();
		let nextEndMs: number | undefined;
		for (const range of quiet.ranges) {
			const start = minutesOfDay(range.start);
			const end = minutesOfDay(range.end);
			if (start === end) return undefined;
			const matches =
				start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
			if (!matches) continue;
			const endDayOffsetMs = start > end && minutes >= start ? dayMs : 0;
			const candidate = localMidnightUtcMs + endDayOffsetMs + end * 60_000;
			if (nextEndMs === undefined || candidate > nextEndMs) nextEndMs = candidate;
		}
		if (nextEndMs === undefined) return cursorMs > nowMs ? cursorMs : undefined;
		if (nextEndMs <= cursorMs) return undefined;
		cursorMs = nextEndMs;
		if (!isQuietHours(quiet, cursorMs, timezoneOffsetMinutes)) return cursorMs;
	}
	return undefined;
}

export function dailyKey(nowMs: number, timezoneOffsetMinutes: number): string {
	const local = new Date(nowMs + timezoneOffsetMinutes * 60_000);
	return local.toISOString().slice(0, 10);
}

export function activeHourBucket(nowMs: number, timezoneOffsetMinutes: number): string {
	const local = new Date(nowMs + timezoneOffsetMinutes * 60_000);
	return String(local.getUTCHours());
}

function mergeQuietHours(
	base: ProactiveQuietHours,
	patch: Partial<ProactiveQuietHours> | undefined,
): ProactiveQuietHours {
	if (patch === undefined) return { ...base, ranges: [...base.ranges] };
	return {
		enabled: patch.enabled ?? base.enabled,
		ranges: patch.ranges ?? base.ranges,
		timezoneOffsetMinutes: patch.timezoneOffsetMinutes ?? base.timezoneOffsetMinutes,
	};
}

export function mergePolicy(
	base: ProactivePolicy,
	patch: ProactivePolicyPatch | undefined,
): ProactivePolicy {
	if (patch === undefined) return base;
	return proactivePolicySchema.parse({
		...base,
		...omitBy(patch, isUndefined),
		quietHours: mergeQuietHours(base.quietHours, patch.quietHours),
	});
}

/** Persona override, then conversation override; global enablement is still required. */
export function composePolicy(input: {
	global: ProactivePolicy;
	persona?: ProactivePolicy;
	conversation?: ProactivePolicy;
}): ProactivePolicy {
	const merged = mergePolicy(mergePolicy(input.global, input.persona), input.conversation);
	return { ...merged, enabled: input.global.enabled && merged.enabled };
}

export function promptWithGuardrails(prompt: string): string {
	return [
		"Proactive/background turn. Send at most one short, natural message.",
		`If silence is better, reply with exactly ${PROACTIVE_SKIP_MARKER}.`,
		`If you should lurk instead, reply with exactly ${PROACTIVE_LURK_MARKER}.`,
		`If now is a bad time, reply with exactly ${PROACTIVE_SCHEDULE_LATER_MARKER} or ${PROACTIVE_SCHEDULE_LATER_MARKER} 15m.`,
		"Never explain these markers. Never send them to the chat.",
		"",
		prompt,
	].join("\n");
}

export function compactStateContext(input: {
	state: ProactiveState;
	recent: readonly { readonly direction: string; readonly textPreview: string }[];
	conversationKind: string;
}): string {
	const lines = [
		`Operational state: conversation=${input.conversationKind}, inbound=${input.state.inboundCount}, unanswered=${input.state.unansweredStreak}, warmness=${input.state.warmness.toFixed(2)}.`,
	];
	if (input.recent.length > 0) {
		lines.push("Recent bounded context:");
		for (const message of input.recent) {
			lines.push(`- ${message.direction}: ${message.textPreview}`);
		}
	}
	return lines.join("\n");
}

export function parseRepeat(value: string | null): ScheduledTaskRepeat | null {
	if (value === null || value.trim().length === 0 || value === "null") return null;
	try {
		const parsed = repeatSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function parseGates(value: string): readonly GateResult[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) return [];
			const gate = (entry as { gate?: unknown }).gate;
			const status = (entry as { status?: unknown }).status;
			if (typeof gate !== "string") return [];
			if (status !== "passed" && status !== "blocked" && status !== "info") return [];
			const reason = (entry as { reason?: unknown }).reason;
			const detail = (entry as { detail?: unknown }).detail;
			return [
				{
					gate,
					status,
					...(typeof reason === "string" ? { reason } : {}),
					...(typeof detail === "string" ? { detail } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}
