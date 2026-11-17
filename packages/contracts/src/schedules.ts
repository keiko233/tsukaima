import { z } from "zod";

export const scheduleActionKindSchema = z.enum(["agent_turn", "workspace_turn", "notify"]);
export type ScheduleActionKind = z.infer<typeof scheduleActionKindSchema>;

export const scheduleStatusSchema = z.enum([
	"active",
	"paused",
	"completed",
	"cancelled",
	"failed",
]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduleOccurrenceStatusSchema = z.enum([
	"pending",
	"claimed",
	"running",
	"succeeded",
	"failed",
	"skipped",
	"uncertain",
	"cancelled",
]);
export type ScheduleOccurrenceStatus = z.infer<typeof scheduleOccurrenceStatusSchema>;

export const scheduleCatchUpSchema = z.enum(["skip", "latest", "all"]);
export type ScheduleCatchUp = z.infer<typeof scheduleCatchUpSchema>;

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const scheduleRecurrenceSchema = z.discriminatedUnion("kind", [
	z
		.object({
			at: isoDateTimeSchema,
			kind: z.literal("once"),
		})
		.strict(),
	z
		.object({
			anchorAt: isoDateTimeSchema,
			everyMs: z.number().int().min(60_000),
			kind: z.literal("interval"),
			until: isoDateTimeSchema.optional(),
		})
		.strict(),
	z
		.object({
			daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
			kind: z.literal("calendar"),
			startDate: localDateSchema,
			time: localTimeSchema,
			until: isoDateTimeSchema.optional(),
		})
		.strict(),
]);
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;

export const scheduleSummarySchema = z.object({
	actionKind: scheduleActionKindSchema,
	catchUp: scheduleCatchUpSchema,
	createdAt: z.string(),
	id: z.string(),
	lastRunAt: z.string().nullable(),
	maxRuns: z.number().int().positive().nullable(),
	nextRunAt: z.string().nullable(),
	ownerKind: z.enum(["user", "agent", "plugin", "system"]),
	recurrence: scheduleRecurrenceSchema,
	runCount: z.number().int().nonnegative(),
	source: z.string(),
	status: scheduleStatusSchema,
	targetChatObjectId: z.string().nullable(),
	targetSessionId: z.string(),
	targetSessionTitle: z.string(),
	timeZone: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;

export const scheduleOccurrenceSchema = z.object({
	attempt: z.number().int().nonnegative(),
	error: z.string().nullable(),
	finishedAt: z.string().nullable(),
	id: z.string(),
	messageId: z.string().nullable(),
	scheduledFor: z.string(),
	startedAt: z.string().nullable(),
	status: scheduleOccurrenceStatusSchema,
	triggerKind: z.enum(["scheduled", "manual", "catch_up"]),
});
export type ScheduleOccurrence = z.infer<typeof scheduleOccurrenceSchema>;

export const scheduleDetailSchema = scheduleSummarySchema.extend({
	ownerId: z.string(),
	ownerPluginId: z.string().nullable(),
	graceMs: z.number().int().nonnegative(),
	maxAttempts: z.number().int().positive(),
	prompt: z.string(),
	respectQuietHours: z.boolean(),
	revision: z.number().int().positive(),
	occurrences: z.array(scheduleOccurrenceSchema),
});
export type ScheduleDetail = z.infer<typeof scheduleDetailSchema>;

export const scheduleCreateInputSchema = z
	.object({
		actionKind: scheduleActionKindSchema.default("agent_turn"),
		catchUp: scheduleCatchUpSchema.optional(),
		dedupeKey: z.string().min(1).max(200).optional(),
		graceMs: z
			.number()
			.int()
			.min(0)
			.max(7 * 24 * 3_600_000)
			.optional(),
		maxAttempts: z.number().int().min(1).max(10).optional(),
		maxRuns: z.number().int().min(1).max(10_000).optional(),
		prompt: z.string().trim().min(1).max(10_000),
		recurrence: scheduleRecurrenceSchema,
		respectQuietHours: z.boolean().optional(),
		targetSessionId: z.string().min(1),
		timeZone: z.string().min(1).max(100),
		title: z.string().trim().min(1).max(200),
	})
	.strict();
export type ScheduleCreateInput = z.infer<typeof scheduleCreateInputSchema>;

export const scheduleIdInputSchema = z.object({ scheduleId: z.string().min(1) }).strict();
export type ScheduleIdInput = z.infer<typeof scheduleIdInputSchema>;

export const scheduleGetInputSchema = scheduleIdInputSchema;
export type ScheduleGetInput = z.infer<typeof scheduleGetInputSchema>;

export const scheduleListInputSchema = z
	.object({
		limit: z.number().int().min(1).max(500).optional(),
		sessionId: z.string().min(1).optional(),
		status: scheduleStatusSchema.optional(),
	})
	.strict();
export type ScheduleListInput = z.infer<typeof scheduleListInputSchema>;

export const scheduleListOutputSchema = z.object({ schedules: z.array(scheduleSummarySchema) });
export type ScheduleListOutput = z.infer<typeof scheduleListOutputSchema>;

export const scheduleUpdateInputSchema = z
	.object({
		catchUp: scheduleCatchUpSchema.optional(),
		graceMs: z
			.number()
			.int()
			.min(0)
			.max(7 * 24 * 3_600_000)
			.optional(),
		maxAttempts: z.number().int().min(1).max(10).optional(),
		maxRuns: z.number().int().min(1).max(10_000).nullable().optional(),
		prompt: z.string().trim().min(1).max(10_000).optional(),
		recurrence: scheduleRecurrenceSchema.optional(),
		respectQuietHours: z.boolean().optional(),
		scheduleId: z.string().min(1),
		timeZone: z.string().min(1).max(100).optional(),
		title: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateInputSchema>;

export const scheduleCancelInputSchema = z
	.object({
		confirm: z.literal(true),
		scheduleId: z.string().min(1),
	})
	.strict();
export type ScheduleCancelInput = z.infer<typeof scheduleCancelInputSchema>;

export const scheduleOccurrencesInputSchema = z
	.object({
		limit: z.number().int().min(1).max(200).optional(),
		scheduleId: z.string().min(1),
	})
	.strict();
export type ScheduleOccurrencesInput = z.infer<typeof scheduleOccurrencesInputSchema>;

export const scheduleOccurrencesOutputSchema = z.object({
	occurrences: z.array(scheduleOccurrenceSchema),
});
export type ScheduleOccurrencesOutput = z.infer<typeof scheduleOccurrencesOutputSchema>;

export const schedulePreviewInputSchema = z
	.object({
		count: z.number().int().min(1).max(10).optional(),
		recurrence: scheduleRecurrenceSchema,
		timeZone: z.string().min(1).max(100),
	})
	.strict();
export type SchedulePreviewInput = z.infer<typeof schedulePreviewInputSchema>;

export const schedulePreviewOutputSchema = z.object({
	nextRuns: z.array(z.string()),
});
export type SchedulePreviewOutput = z.infer<typeof schedulePreviewOutputSchema>;

export const scheduleSummaryInputSchema = z
	.object({
		sessionIds: z.array(z.string().min(1)).max(100).optional(),
	})
	.strict();
export type ScheduleSummaryInput = z.infer<typeof scheduleSummaryInputSchema>;

export const scheduleSummaryOutputSchema = z.object({
	active: z.number().int().nonnegative(),
	dueSoon: z.number().int().nonnegative(),
	overdue: z.number().int().nonnegative(),
	sessions: z.array(
		z.object({
			active: z.number().int().nonnegative(),
			nextRunAt: z.string().nullable(),
			sessionId: z.string(),
		}),
	),
});
export type ScheduleSummaryOutput = z.infer<typeof scheduleSummaryOutputSchema>;
