import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope, ScheduleRecurrence, ScheduleSummary } from "@tsukaima/contracts";
import type { AuditEntry, ChannelAdapter, ChannelDiagnostics, SendResult } from "@tsukaima/sdk";
import {
	auditLog,
	chatObjects,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	pluginTasks,
	scheduleOccurrences,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import { createApp } from "../src/app.ts";
import type { TsukaimaLifecycle } from "../src/lifecycle.ts";
import { createLogger } from "../src/logging.ts";
import { ChannelRegistry } from "../src/services/channel-registry.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { PluginTaskService } from "../src/services/plugin-task-service.ts";
import { ScheduleExecutionService } from "../src/services/schedule-executor.ts";
import { ScheduleService } from "../src/services/schedule-service.ts";
import {
	createScheduleToolsExtension,
	SCHEDULE_TOOL_NAMES,
} from "../src/services/schedule-tools.ts";
import {
	isInQuietHours,
	nextOccurrence,
	nextQuietHoursEndMs,
} from "../src/services/schedule-time.ts";
import type { SessionMessagingService } from "../src/services/session-messaging.ts";

const databases: TsukaimaDatabase[] = [];
const directories: string[] = [];
const lifecycles: TsukaimaLifecycle[] = [];
const logger = createLogger({ level: "error" });

afterEach(async () => {
	await Promise.all(
		lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
	);
	for (const database of databases.splice(0)) database.$client.close();
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const SHANGHAI_QUIET = { enabled: true, endHour: 7, startHour: 22 };

function quietWindow(startHour: number, endHour: number) {
	return { enabled: true, endHour, startHour };
}

describe("schedule time zone and DST arithmetic", () => {
	test("wrap-around quiet hours resolve to the next local quiet-hours end across IANA zones", () => {
		const cases = [
			{
				at: "2026-11-17T15:30:00.000Z",
				end: "2026-11-17T23:00:00.000Z",
				quiet: quietWindow(22, 7),
				timeZone: "Asia/Shanghai",
			},
			{
				at: "2026-11-17T20:30:00.000Z",
				end: "2026-11-17T22:00:00.000Z",
				quiet: quietWindow(1, 6),
				timeZone: "Asia/Shanghai",
			},
			{
				at: "2026-11-18T04:30:00.000Z",
				end: "2026-11-18T12:00:00.000Z",
				quiet: quietWindow(22, 7),
				timeZone: "America/New_York",
			},
			{
				at: "2026-11-17T18:00:00.000Z",
				end: "2026-11-18T01:30:00.000Z",
				quiet: quietWindow(22, 7),
				timeZone: "Asia/Kolkata",
			},
		] as const;
		for (const entry of cases) {
			const atMs = Date.parse(entry.at);
			expect(isInQuietHours(atMs, entry.quiet, entry.timeZone)).toBe(true);
			const endMs = nextQuietHoursEndMs(atMs, entry.quiet, entry.timeZone);
			expect(new Date(endMs ?? 0).toISOString()).toBe(entry.end);
			expect(isInQuietHours(endMs ?? 0, entry.quiet, entry.timeZone)).toBe(false);
		}
	});

	test("spring-forward and fall-back boundaries resolve to the first valid local instant", () => {
		expect(
			new Date(
				nextQuietHoursEndMs(
					Date.parse("2026-03-08T06:30:00.000Z"),
					quietWindow(22, 7),
					"America/New_York",
				) ?? 0,
			).toISOString(),
		).toBe("2026-03-08T11:00:00.000Z");
		expect(
			new Date(
				nextQuietHoursEndMs(
					Date.parse("2026-11-01T05:30:00.000Z"),
					quietWindow(22, 7),
					"America/New_York",
				) ?? 0,
			).toISOString(),
		).toBe("2026-11-01T12:00:00.000Z");
		const missingLocalTime = nextOccurrence({
			afterMs: Date.parse("2026-03-08T00:00:00.000Z"),
			recurrence: { kind: "calendar", startDate: "2026-03-01", time: "02:30" },
			timeZone: "America/New_York",
		});
		expect(new Date(missingLocalTime ?? 0).toISOString()).toBe("2026-03-08T07:00:00.000Z");
		const repeatedLocalTime = nextOccurrence({
			afterMs: Date.parse("2026-11-01T00:00:00.000Z"),
			recurrence: { kind: "calendar", startDate: "2026-11-01", time: "01:30" },
			timeZone: "America/New_York",
		});
		expect(new Date(repeatedLocalTime ?? 0).toISOString()).toBe("2026-11-01T05:30:00.000Z");
	});

	test("a 24-hour quiet window is detected but yields no deferral target, and disabled hours stay inert", () => {
		expect(isInQuietHours(0, quietWindow(8, 8), "UTC")).toBe(true);
		expect(nextQuietHoursEndMs(0, quietWindow(8, 8), "UTC")).toBeUndefined();
		expect(isInQuietHours(0, { ...quietWindow(22, 7), enabled: false }, "UTC")).toBe(false);
		expect(
			nextQuietHoursEndMs(0, { ...quietWindow(22, 7), enabled: false }, "UTC"),
		).toBeUndefined();
		expect(
			nextQuietHoursEndMs(Date.parse("2026-11-17T12:00:00.000Z"), SHANGHAI_QUIET, "Asia/Shanghai"),
		).toBeUndefined();
	});
});

interface SchedulingHarness {
	readonly clock: { now: number };
	readonly database: TsukaimaDatabase;
	readonly durableConversationId: string;
	readonly policy: ConversationPolicyService;
	readonly schedules: ScheduleService;
	readonly scheduleTools: ReturnType<typeof createScheduleToolsExtension>;
	readonly sessionId: string;
	readonly submitted: readonly unknown[];
}

async function createSchedulingHarness(): Promise<SchedulingHarness> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-4-scheduling-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	databases.push(database);
	migrateDomainDatabase(database);
	const sessionId = randomUUID();
	const chatId = randomUUID();
	const durableConversationId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: "private",
		platformConversationId: "10001",
		title: "Synthetic private chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "private",
		platformConversationId: "10001",
		title: "Synthetic private chat",
		updatedAt: now,
	});
	const clock = { now: Date.parse("2026-11-17T00:00:00.000Z") };
	const submitted: unknown[] = [];
	const audit = async (entry: AuditEntry) => {
		await database.insert(auditLog).values({
			action: entry.action,
			actorId: entry.actorId ?? "test-admin",
			actorKind: entry.actorKind ?? "user",
			id: randomUUID(),
			occurredAt: new Date(clock.now).toISOString(),
			payloadJson: entry.payload === undefined ? null : JSON.stringify(entry.payload),
			reason: entry.reason ?? null,
			result: entry.result,
			targetId: entry.targetId ?? null,
			targetKind: entry.targetKind,
		});
	};
	const policy = new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
	const messaging = {
		sendAgentMessage: async (input: { readonly messageId?: string; readonly text: string }) => {
			const messageId = input.messageId ?? randomUUID();
			const occurredAt = new Date(clock.now).toISOString();
			await database.insert(messages).values({
				chatObjectId: chatId,
				contentText: input.text,
				conversationId: sessionId,
				direction: "system",
				deliveryStatus: "pending",
				id: messageId,
				ingestedAt: occurredAt,
				kind: "scheduler",
				occurredAt,
				partsJson: JSON.stringify([{ text: input.text, type: "text" }]),
				senderDisplayName: "Tsukaima scheduler",
				senderExternalId: "tsukaima-scheduler",
				updatedAt: occurredAt,
			});
			submitted.push(input);
			return {
				chatObjectId: chatId,
				durableConversationId,
				messageId,
				mode: "follow-up",
			};
		},
		session: async () => ({
			chat: { kind: "private" },
			session: { kind: "private" },
		}),
	} as unknown as SessionMessagingService;
	const channels = new ChannelRegistry();
	const executor = new ScheduleExecutionService({
		audit,
		channels,
		database: () => database,
		logger,
		messaging,
		now: () => clock.now,
		policy,
	});
	const schedules = new ScheduleService({
		audit,
		database: () => database,
		executor,
		logger,
		now: () => clock.now,
	});
	const scheduleTools = createScheduleToolsExtension({
		audit,
		logger,
		messaging,
		resolveSessionId: async () => sessionId,
		schedules,
	});
	return {
		clock,
		database,
		durableConversationId,
		policy,
		schedules,
		scheduleTools,
		sessionId,
		submitted,
	};
}

function scheduleTool(
	tools: ReturnType<typeof createScheduleToolsExtension>,
	name: (typeof SCHEDULE_TOOL_NAMES)[number],
) {
	const tool = (tools.tools ?? []).find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`Schedule tool ${name} missing`);
	return tool;
}

async function executeScheduleTool(
	tools: ReturnType<typeof createScheduleToolsExtension>,
	name: (typeof SCHEDULE_TOOL_NAMES)[number],
	args: Record<string, unknown>,
	durableConversationId: string,
) {
	const tool = scheduleTool(tools, name);
	return await tool.execute(
		args,
		{ conversationId: Number(durableConversationId) } as unknown as Parameters<
			typeof tool.execute
		>[1],
		undefined as never,
	);
}

function resultText(result: unknown): string {
	const output = (result as { readonly output?: readonly unknown[] }).output;
	for (const part of output ?? []) {
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
		) {
			return part.text;
		}
	}
	return "";
}

function parseToolOutput(result: unknown): Record<string, unknown> {
	const first = resultText(result) || "{}";
	const parsed: unknown = JSON.parse(first);
	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

describe("ScheduleService + ScheduleExecutionService quiet-hours behavior", () => {
	test("a daily reminder sends a fresh dated instruction at each occurrence", async () => {
		const { clock, schedules, sessionId, submitted } = await createSchedulingHarness();
		const first = "2026-11-17T12:00:00.000Z";
		const second = "2026-11-18T12:00:00.000Z";
		const prompt = "Synthetic daily reminder";
		await schedules.create({
			actionKind: "agent_turn",
			ownerId: "webui-admin",
			ownerKind: "user",
			prompt,
			recurrence: { kind: "calendar", startDate: "2026-11-17", time: "20:00" },
			source: "webui",
			targetSessionId: sessionId,
			timeZone: "Asia/Taipei",
			title: "Synthetic daily schedule",
		});
		for (const due of [first, second]) {
			clock.now = Date.parse(due);
			await schedules.tick();
		}
		expect(submitted).toHaveLength(2);
		const turns = submitted as readonly { context: string; requestId: string; text: string }[];
		expect(turns[0]?.requestId).not.toBe(turns[1]?.requestId);
		for (const [index, at] of [first, second].entries()) {
			expect(turns[index]?.text).toBe(prompt);
			expect(turns[index]?.context).toContain(at);
			expect(turns[index]?.context).toContain("send the reminder anew");
		}
	});

	test("a one-off reminder inside quiet hours stays active, defers without burning attempts, then executes after quiet end", async () => {
		const harness = await createSchedulingHarness();
		const { clock, database, policy, schedules, sessionId, submitted } = harness;
		await policy.update({
			conversationId: sessionId,
			policy: { pacing: { quietHours: SHANGHAI_QUIET } },
			scope: "conversation",
		});
		clock.now = Date.parse("2026-11-17T15:30:00.000Z");
		const created = await schedules.create({
			actionKind: "agent_turn",
			ownerId: "agent",
			ownerKind: "agent",
			prompt: "Synthetic quiet reminder",
			recurrence: { at: "2026-11-17T15:31:00.000Z", kind: "once" },
			respectQuietHours: true,
			source: "chat-tool",
			targetSessionId: sessionId,
			timeZone: "Asia/Shanghai",
			title: "Quiet reminder",
		});
		clock.now = Date.parse("2026-11-17T15:31:05.000Z");
		expect(await schedules.tick()).toEqual({ executed: 1, materialized: 1 });
		const deferred = await schedules.get(created.id);
		expect(deferred).toEqual(
			expect.objectContaining({
				nextRunAt: "2026-11-17T23:00:00.000Z",
				status: "active",
			}),
		);
		const [occurrence] = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, created.id));
		expect(occurrence).toEqual(
			expect.objectContaining({
				attempt: 0,
				scheduledForMs: Date.parse("2026-11-17T23:00:00.000Z"),
				status: "pending",
			}),
		);
		const audits = await database.select().from(auditLog);
		expect(
			audits.some(
				(row) =>
					row.action === "schedule.deferred" &&
					row.payloadJson !== null &&
					JSON.parse(row.payloadJson).reason === "quiet_hours",
			),
		).toBe(true);
		expect(submitted).toHaveLength(0);
		expect(await schedules.get(created.id)).toEqual(
			expect.objectContaining({ nextRunAt: "2026-11-17T23:00:00.000Z", status: "active" }),
		);

		clock.now = Date.parse("2026-11-17T23:00:30.000Z");
		expect(await schedules.tick()).toEqual({ executed: 1, materialized: 0 });
		const completed = await schedules.get(created.id);
		expect(completed?.status).toBe("completed");
		expect(completed?.nextRunAt).toBeNull();
		const [settled] = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, created.id));
		expect(settled?.status).toBe("succeeded");
		expect(submitted).toHaveLength(1);
	});

	test("same-day and DST-boundary quiet windows defer to the exact computed end and then execute", async () => {
		const cases = [
			{
				at: "2026-11-17T07:30:00.000Z",
				expectedEnd: "2026-11-17T11:00:00.000Z",
				quiet: quietWindow(1, 6),
				timeZone: "America/New_York",
			},
			{
				at: "2026-03-08T06:31:00.000Z",
				expectedEnd: "2026-03-08T11:00:00.000Z",
				quiet: quietWindow(22, 7),
				timeZone: "America/New_York",
			},
			{
				at: "2026-11-01T05:31:00.000Z",
				expectedEnd: "2026-11-01T12:00:00.000Z",
				quiet: quietWindow(22, 7),
				timeZone: "America/New_York",
			},
		] as const;
		for (const entry of cases) {
			const harness = await createSchedulingHarness();
			const { clock, database, policy, schedules, sessionId, submitted } = harness;
			await policy.update({
				conversationId: sessionId,
				policy: { pacing: { quietHours: entry.quiet } },
				scope: "conversation",
			});
			const atMs = Date.parse(entry.at);
			clock.now = atMs - 60_000;
			const created = await schedules.create({
				actionKind: "agent_turn",
				ownerId: "agent",
				ownerKind: "agent",
				prompt: `Synthetic ${entry.timeZone} quiet reminder`,
				recurrence: { at: entry.at, kind: "once" },
				respectQuietHours: true,
				source: "chat-tool",
				targetSessionId: sessionId,
				timeZone: entry.timeZone,
				title: "Quiet boundary reminder",
			});
			clock.now = atMs + 90_000;
			expect(await schedules.tick()).toEqual({ executed: 1, materialized: 1 });
			expect(await schedules.get(created.id)).toEqual(
				expect.objectContaining({ nextRunAt: entry.expectedEnd, status: "active" }),
			);
			expect(submitted).toHaveLength(0);
			clock.now = Date.parse(entry.expectedEnd) + 30_000;
			expect(await schedules.tick()).toEqual({ executed: 1, materialized: 0 });
			expect((await schedules.get(created.id))?.status).toBe("completed");
			expect(submitted).toHaveLength(1);
			const [occurrence] = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id));
			expect(occurrence?.status).toBe("succeeded");
		}
	});

	test("a 24-hour quiet window skips a one-off safely once and never loops", async () => {
		const harness = await createSchedulingHarness();
		const { clock, database, policy, schedules, sessionId, submitted } = harness;
		await policy.update({
			conversationId: sessionId,
			policy: { pacing: { quietHours: quietWindow(8, 8) } },
			scope: "conversation",
		});
		clock.now = Date.parse("2026-11-17T00:00:00.000Z");
		const created = await schedules.create({
			actionKind: "agent_turn",
			ownerId: "agent",
			ownerKind: "agent",
			prompt: "Synthetic all-day quiet reminder",
			recurrence: { at: "2026-11-17T00:01:00.000Z", kind: "once" },
			respectQuietHours: true,
			source: "chat-tool",
			targetSessionId: sessionId,
			timeZone: "UTC",
			title: "All-day quiet",
		});
		clock.now = Date.parse("2026-11-17T00:01:05.000Z");
		expect(await schedules.tick()).toEqual({ executed: 1, materialized: 1 });
		expect(submitted).toHaveLength(0);
		const detail = await schedules.get(created.id);
		expect(detail?.status).toBe("completed");
		expect(detail?.nextRunAt).toBeNull();
		const occurrences = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, created.id));
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.status).toBe("skipped");
		expect(await schedules.tick()).toEqual({ executed: 0, materialized: 0 });
		expect(
			await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id)),
		).toHaveLength(1);
	});

	test("interval and calendar recurrences skip quiet slots without losing future ticks", async () => {
		const harness = await createSchedulingHarness();
		const { clock, database, policy, schedules, sessionId, submitted } = harness;
		await policy.update({
			conversationId: sessionId,
			policy: { pacing: { quietHours: SHANGHAI_QUIET } },
			scope: "conversation",
		});
		clock.now = Date.parse("2026-11-17T14:59:00.000Z");
		const interval = await schedules.create({
			actionKind: "agent_turn",
			catchUp: "skip",
			ownerId: "agent",
			ownerKind: "agent",
			prompt: "Synthetic interval check-in",
			recurrence: {
				anchorAt: "2026-11-17T14:00:00.000Z",
				everyMs: 3_600_000,
				kind: "interval",
			},
			respectQuietHours: true,
			source: "chat-tool",
			targetSessionId: sessionId,
			timeZone: "Asia/Shanghai",
			title: "Interval check-in",
		});
		clock.now = Date.parse("2026-11-17T15:00:30.000Z");
		expect(await schedules.tick()).toEqual({ executed: 1, materialized: 1 });
		expect(submitted).toHaveLength(0);
		let detail = await schedules.get(interval.id);
		expect(detail?.status).toBe("active");
		expect(detail?.nextRunAt).toBe("2026-11-17T16:00:00.000Z");
		const intervalOccurrences = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, interval.id));
		expect(intervalOccurrences.filter((row) => row.status === "pending")).toHaveLength(0);

		clock.now = Date.parse("2026-11-17T23:00:01.000Z");
		const resumed = await schedules.tick();
		expect(resumed.executed).toBe(1);
		detail = await schedules.get(interval.id);
		expect(detail?.status).toBe("active");
		expect(detail?.nextRunAt).toBe("2026-11-18T00:00:00.000Z");
		const settledInterval = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, interval.id));
		expect(
			settledInterval.some(
				(row) =>
					row.scheduledForMs === Date.parse("2026-11-17T23:00:00.000Z") &&
					row.status === "succeeded",
			),
		).toBe(true);
		expect(submitted).toHaveLength(1);

		clock.now = Date.parse("2026-11-17T14:59:00.000Z");
		const calendar = await schedules.create({
			actionKind: "agent_turn",
			ownerId: "agent",
			ownerKind: "agent",
			prompt: "Synthetic nightly calendar reminder",
			recurrence: { kind: "calendar", startDate: "2026-11-17", time: "23:00" },
			respectQuietHours: true,
			source: "chat-tool",
			targetSessionId: sessionId,
			timeZone: "Asia/Shanghai",
			title: "Calendar reminder",
		});
		let calendarDetail = await schedules.get(calendar.id);
		expect(calendarDetail?.nextRunAt).toBe("2026-11-17T15:00:00.000Z");
		clock.now = Date.parse("2026-11-17T15:00:30.000Z");
		expect(await schedules.tick()).toEqual({ executed: 1, materialized: 1 });
		calendarDetail = await schedules.get(calendar.id);
		expect(calendarDetail?.status).toBe("active");
		expect(calendarDetail?.nextRunAt).toBe("2026-11-18T15:00:00.000Z");
		expect(submitted).toHaveLength(1);
		clock.now = Date.parse("2026-11-18T15:00:30.000Z");
		const nextDay = await schedules.tick();
		expect(nextDay.executed).toBeGreaterThanOrEqual(1);
		calendarDetail = await schedules.get(calendar.id);
		expect(calendarDetail?.status).toBe("active");
		expect(calendarDetail?.nextRunAt).toBe("2026-11-19T15:00:00.000Z");
		const calendarOccurrences = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, calendar.id));
		expect(
			calendarOccurrences.some(
				(row) =>
					row.scheduledForMs === Date.parse("2026-11-18T15:00:00.000Z") && row.status === "skipped",
			),
		).toBe(true);
	});
});

describe("schedule_create IM tool semantics", () => {
	test("supports at and delayMs shorthands with IM quiet-hour defaults", async () => {
		const harness = await createSchedulingHarness();
		const { clock, durableConversationId, schedules, scheduleTools } = harness;
		clock.now = Date.parse("2026-11-17T00:00:00.000Z");
		const atResult = parseToolOutput(
			await executeScheduleTool(
				scheduleTools,
				"schedule_create",
				{
					at: "2026-11-17T09:30:00-05:00",
					prompt: "Synthetic absolute reminder",
					timeZone: "America/New_York",
				},
				durableConversationId,
			),
		);
		expect(atResult.respectQuietHours).toBe(true);
		const atDetail = await schedules.get(String(atResult.scheduleId));
		expect(atDetail?.recurrence).toEqual({ at: "2026-11-17T14:30:00.000Z", kind: "once" });
		expect(atDetail?.nextRunAt).toBe("2026-11-17T14:30:00.000Z");

		const originalNow = Date.now;
		Date.now = () => clock.now;
		try {
			const delayResult = parseToolOutput(
				await executeScheduleTool(
					scheduleTools,
					"schedule_create",
					{
						delayMs: 90_000,
						prompt: "Synthetic delayed reminder",
						timeZone: "UTC",
					},
					durableConversationId,
				),
			);
			const delayDetail = await schedules.get(String(delayResult.scheduleId));
			expect(delayDetail?.recurrence).toEqual({
				at: "2026-11-17T00:01:30.000Z",
				kind: "once",
			});
		} finally {
			Date.now = originalNow;
		}
	});

	test("rejects a malformed recurrence before persisting a schedule", async () => {
		const harness = await createSchedulingHarness();
		const { clock, durableConversationId, schedules, scheduleTools } = harness;
		clock.now = Date.parse("2026-11-17T00:00:00.000Z");
		const result = await executeScheduleTool(
			scheduleTools,
			"schedule_create",
			{
				prompt: "Synthetic malformed recurrence",
				recurrence: { everyMs: 1_000, kind: "interval" },
				timeZone: "UTC",
			},
			durableConversationId,
		);
		expect(resultText(result)).toContain("anchorAt");
		expect(await schedules.list()).toHaveLength(0);
	});

	test("supports interval and calendar recurrence with a timezone-aware next tick", async () => {
		const harness = await createSchedulingHarness();
		const { clock, durableConversationId, schedules, scheduleTools } = harness;
		clock.now = Date.parse("2026-11-17T00:00:00.000Z");
		const intervalResult = parseToolOutput(
			await executeScheduleTool(
				scheduleTools,
				"schedule_create",
				{
					recurrence: {
						anchorAt: "2026-11-17T07:00:00.000Z",
						everyMs: 3_600_000,
						kind: "interval",
					},
					prompt: "Synthetic interval",
					timeZone: "UTC",
				},
				durableConversationId,
			),
		);
		const interval = await schedules.get(String(intervalResult.scheduleId));
		expect(interval?.recurrence).toEqual({
			anchorAt: "2026-11-17T07:00:00.000Z",
			everyMs: 3_600_000,
			kind: "interval",
		});
		expect(interval?.nextRunAt).toBe("2026-11-17T08:00:00.000Z");

		const calendarResult = parseToolOutput(
			await executeScheduleTool(
				scheduleTools,
				"schedule_create",
				{
					recurrence: {
						daysOfWeek: [3],
						kind: "calendar",
						startDate: "2026-11-18",
						time: "08:00",
					},
					prompt: "Synthetic calendar",
					timeZone: "America/New_York",
				},
				durableConversationId,
			),
		);
		const calendar = await schedules.get(String(calendarResult.scheduleId));
		expect(calendar?.recurrence).toEqual({
			daysOfWeek: [3],
			kind: "calendar",
			startDate: "2026-11-18",
			time: "08:00",
		});
		expect(calendar?.timeZone).toBe("America/New_York");
		expect(calendar?.nextRunAt).toBe("2026-11-18T13:00:00.000Z");
	});

	test("flexWindowMs and dueWindowMs expire a late occurrence without executing it", async () => {
		const harness = await createSchedulingHarness();
		const { clock, database, durableConversationId, schedules, scheduleTools, submitted } = harness;
		clock.now = Date.parse("2026-11-17T00:00:00.000Z");
		const originalNow = Date.now;
		Date.now = () => clock.now;
		try {
			const flexResult = parseToolOutput(
				await executeScheduleTool(
					scheduleTools,
					"schedule_create",
					{
						delayMs: 60_000,
						flexWindowMs: 1_000,
						prompt: "Synthetic flex reminder",
						respectQuietHours: false,
						timeZone: "UTC",
					},
					durableConversationId,
				),
			);
			const flex = await schedules.get(String(flexResult.scheduleId));
			expect(flex?.flexWindowMs).toBe(1_000);
			clock.now = Date.parse("2026-11-17T00:02:00.000Z");
			expect(await schedules.tick()).toEqual({ executed: 1, materialized: 1 });
			expect(submitted).toHaveLength(0);
			const occurrences = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, flex!.id));
			expect(occurrences[0]?.status).toBe("skipped");
			expect(occurrences[0]?.resultJson ?? "").toContain("due_window_expired");

			clock.now = Date.parse("2026-11-17T00:00:00.000Z");
			const dueResult = parseToolOutput(
				await executeScheduleTool(
					scheduleTools,
					"schedule_create",
					{
						delayMs: 60_000,
						dueWindowMs: 5_000,
						prompt: "Synthetic due-window reminder",
						respectQuietHours: false,
						timeZone: "UTC",
					},
					durableConversationId,
				),
			);
			const due = await schedules.get(String(dueResult.scheduleId));
			expect(due?.flexWindowMs).toBe(5_000);
		} finally {
			Date.now = originalNow;
		}
	});
});

class EchoChannelAdapter implements ChannelAdapter {
	readonly id = "onebot";
	readonly kind = "onebot-v11";
	capabilities() {
		return ["send"] as const;
	}
	diagnostics(): ChannelDiagnostics {
		return { configured: true, connected: true, eventCount: 0, state: "open" };
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async send(): Promise<SendResult> {
		return { platformMessageId: "bot-echo-1" };
	}
	onEnvelope(): void {}
}

async function createLifecycleHarness() {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-4-cancel-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		},
		{
			model: createModel(),
		},
	);
	await lifecycle.start();
	lifecycles.push(lifecycle);
	const adapter = new EchoChannelAdapter();
	lifecycle.channels.register(adapter);
	const host = lifecycle.conversationHost;
	const database = lifecycle.domainDatabase;
	if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
	const durableConversationId = await host.createConversation();
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: "group",
		platformConversationId: "20001",
		title: "Synthetic group",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "group",
		platformConversationId: "20001",
		title: "Synthetic group",
		updatedAt: now,
	});
	const extension = (
		lifecycle as unknown as {
			scheduleToolsExtension?: ReturnType<typeof createScheduleToolsExtension>;
		}
	).scheduleToolsExtension;
	if (extension === undefined) throw new Error("schedule tools extension missing");
	return {
		adapter,
		chatId,
		durableConversationId,
		extension,
		lifecycle,
		sessionId,
	};
}

function createModel() {
	return createOpenAICompatibleModelPort(
		{
			apiKey: "synthetic-api-key",
			baseUrl: "http://capture.invalid/v1",
			fetch: (async () =>
				Response.json({
					choices: [{ finish_reason: "stop", message: { content: "ok" } }],
					id: "resp-ok",
					model: "capture-model",
					usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
				})) as unknown as typeof fetch,
		},
		[{ capabilities: ["basic-chat", "tool-use"], modelId: "capture-model" }],
	);
}

function groupEnvelope(id: string, text: string, profileId = "10002"): MessageEnvelope {
	return {
		channelId: "onebot",
		channelKind: "onebot-v11",
		conversationKey: { groupId: "20001", kind: "group", peerId: profileId },
		id,
		mentions: [],
		parts: [{ text, type: "text" }],
		sender: { displayName: "Synthetic speaker", id: profileId, platformId: profileId },
		source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
	};
}

async function handleEnvelope(lifecycle: TsukaimaLifecycle, message: MessageEnvelope) {
	const handler = (
		lifecycle as unknown as {
			handleChannelEnvelope(channelId: string, envelope: MessageEnvelope): Promise<void>;
		}
	).handleChannelEnvelope.bind(lifecycle);
	await handler(message.channelId, message);
}

async function waitForScheduleStatus(
	lifecycle: TsukaimaLifecycle,
	read: () => Promise<ScheduleSummary | null>,
	expected: ScheduleSummary["status"],
): Promise<ScheduleSummary> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 3_000) {
		const summary = await read();
		if (summary?.status === expected) return summary;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for schedule status ${expected}`);
}

describe("cancelIfReplied inbound vs outbound echo", () => {
	test("a subsequent inbound channel message cancels the reminder, while a bot outbound echo does not", async () => {
		const harness = await createLifecycleHarness();
		const { durableConversationId, extension, lifecycle, sessionId } = harness;
		const create = (extension.tools ?? []).find((tool) => tool.name === "schedule_create");
		const cancelRead = async (scheduleId: string) => await lifecycle.schedules.get(scheduleId);
		if (create === undefined) throw new Error("schedule_create missing");
		const createdResult = await create.execute(
			{
				at: new Date(Date.now() + 3_600_000).toISOString(),
				cancelIfReplied: true,
				prompt: "Synthetic reply-cancelled reminder",
				respectQuietHours: false,
				timeZone: "UTC",
			},
			{ conversationId: Number(durableConversationId) } as unknown as Parameters<
				typeof create.execute
			>[1],
			undefined as never,
		);
		const created = JSON.parse(resultText(createdResult) || "{}") as {
			readonly scheduleId: string;
		};
		await handleEnvelope(lifecycle, groupEnvelope("inbound-cancel", "synthetic reply"));
		await waitForScheduleStatus(lifecycle, () => cancelRead(created.scheduleId), "cancelled");
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const audits = await database.select().from(auditLog);
		expect(
			audits.some(
				(row) => row.action === "schedule.cancel-replied" && row.targetId === created.scheduleId,
			),
		).toBe(true);
		expect(sessionId.length).toBeGreaterThan(0);

		const echoSchedule = await create.execute(
			{
				at: new Date(Date.now() + 7_200_000).toISOString(),
				cancelIfReplied: true,
				prompt: "Synthetic echo-safe reminder",
				respectQuietHours: false,
				timeZone: "UTC",
			},
			{ conversationId: Number(durableConversationId) } as unknown as Parameters<
				typeof create.execute
			>[1],
			undefined as never,
		);
		const echo = JSON.parse(resultText(echoSchedule) || "{}") as {
			readonly scheduleId: string;
		};
		await lifecycle.outbound.send("synthetic-test", {
			parts: [{ text: "synthetic bot echo", type: "text" }],
			target: {
				channelId: "onebot",
				kind: "group",
				platformConversationId: "20001",
			},
		});
		expect(await cancelRead(echo.scheduleId)).toEqual(
			expect.objectContaining({ status: "active" }),
		);
		await handleEnvelope(lifecycle, groupEnvelope("bot-echo-1", "synthetic bot echo"));
		await Bun.sleep(100);
		expect(await cancelRead(echo.scheduleId)).toEqual(
			expect.objectContaining({ status: "active" }),
		);
	});
});

describe("PluginTaskService nextRunAtMs rescheduling", () => {
	test("a deferred handler result resets attempts, keeps the task pending, and runs at the deferred instant", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-4-plugin-task-"));
		directories.push(directory);
		const database = await openDomainDatabase(join(directory, "domain.sqlite"));
		databases.push(database);
		migrateDomainDatabase(database);
		const clock = { now: Date.parse("2026-11-17T00:00:00.000Z") };
		const deferredAt = Date.parse("2026-11-17T07:00:00.000Z");
		const service = new PluginTaskService({
			database,
			logger,
			now: () => clock.now,
		});
		let runs = 0;
		service.registerHandler("synthetic", "deferred", async () => {
			runs += 1;
			if (runs === 1) {
				return {
					logs: ["deferred to quiet-hours end"],
					nextRunAtMs: deferredAt,
					outcome: { deferred: true },
					stop: false,
				};
			}
			return { outcome: { ok: true } };
		});
		const api = service.apiFor("synthetic", [
			"tasks.create",
			"tasks.get",
			"tasks.list",
			"tasks.cancel",
			"tasks.watch",
		]);
		const created = await api.create({ kind: "deferred", maxAttempts: 3 });
		expect(await service.tick()).toBe(1);
		const deferred = await api.get(created.id);
		expect(deferred).toEqual(
			expect.objectContaining({
				attempts: 0,
				nextRunAtMs: deferredAt,
				status: "pending",
			}),
		);
		clock.now = deferredAt;
		expect(await service.tick()).toBe(1);
		expect((await api.get(created.id))?.status).toBe("completed");
		expect(runs).toBe(2);
		const [row] = await database.select().from(pluginTasks).where(eq(pluginTasks.id, created.id));
		expect(row?.attempts).toBe(0);
	});
});

describe("schedule recurrence helper", () => {
	test("calendar previews skip quiet slots and preserve later occurrences", async () => {
		const recurrence: ScheduleRecurrence = {
			kind: "calendar",
			startDate: "2026-11-17",
			time: "23:00",
		};
		const first = nextOccurrence({
			afterMs: Date.parse("2026-11-17T00:00:00.000Z"),
			recurrence,
			timeZone: "Asia/Shanghai",
		});
		expect(new Date(first ?? 0).toISOString()).toBe("2026-11-17T15:00:00.000Z");
		const second = nextOccurrence({
			afterMs: first ?? 0,
			recurrence,
			timeZone: "Asia/Shanghai",
		});
		expect(new Date(second ?? 0).toISOString()).toBe("2026-11-18T15:00:00.000Z");
	});
});
