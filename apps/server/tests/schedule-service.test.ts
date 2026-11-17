import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	auditLog,
	chatObjects,
	conversations,
	migrateDomainDatabase,
	openDomainDatabase,
	scheduleOccurrences,
	schedules,
} from "@tsukaima/db";
import { createLogger } from "../src/logging.ts";
import {
	type ScheduleExecutionResult,
	type ScheduleExecutor,
	type ScheduleSnapshot,
} from "../src/services/schedule-service.ts";
import { ScheduleService } from "../src/services/schedule-service.ts";

const logger = createLogger({ level: "error" });

async function seed(directory: string) {
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const now = "2026-11-17T00:00:00.000Z";
	await database.insert(chatObjects).values({
		createdAt: now,
		id: "chat-1",
		kind: "webui",
		status: "active",
		title: "Test chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		chatObjectId: "chat-1",
		createdAt: now,
		durableConversationId: "1",
		id: "session-1",
		isReceiving: 1,
		kind: "webui",
		status: "active",
		title: "Test session",
		updatedAt: now,
	});
	return database;
}

class RecordingExecutor implements ScheduleExecutor {
	readonly calls: ScheduleSnapshot[] = [];
	error: Error | undefined;
	resultStatus: ScheduleExecutionResult["status"] | undefined;
	async execute(input: { readonly snapshot: ScheduleSnapshot }): Promise<ScheduleExecutionResult> {
		this.calls.push(input.snapshot);
		if (this.error !== undefined) throw this.error;
		return {
			...(this.resultStatus === undefined ? {} : { status: this.resultStatus }),
			result: { ok: true },
		};
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
		await Bun.sleep(10);
	}
}

describe("durable schedules", () => {
	test("creates, materializes, executes exactly once, and completes a one-time schedule", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-schedules-"));
		const database = await seed(directory);
		let now = Date.parse("2026-11-17T00:00:00.000Z");
		const executor = new RecordingExecutor();
		const service = new ScheduleService({
			audit: async (entry) => {
				await database.insert(auditLog).values({
					action: entry.action,
					actorId: entry.actorId ?? "test-admin",
					actorKind: entry.actorKind ?? "user",
					id: `audit-${Math.random()}`,
					occurredAt: new Date(now).toISOString(),
					payloadJson: entry.payload === undefined ? null : JSON.stringify(entry.payload),
					reason: entry.reason ?? null,
					result: entry.result,
					targetId: entry.targetId ?? null,
					targetKind: entry.targetKind,
				});
			},
			database: () => database,
			executor,
			logger,
			now: () => now,
		});
		try {
			const created = await service.create({
				actionKind: "agent_turn",
				ownerId: "test-admin",
				ownerKind: "user",
				prompt: "Synthetic reminder",
				recurrence: { at: "2026-11-17T00:01:00.000Z", kind: "once" },
				source: "test",
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			});
			expect(created.status).toBe("active");
			expect(created.nextRunAt).toBe("2026-11-17T00:01:00.000Z");
			expect(await service.tick()).toEqual({ executed: 0, materialized: 0 });
			now = Date.parse("2026-11-17T00:01:01.000Z");
			expect(await service.tick()).toEqual({ executed: 1, materialized: 1 });
			expect(await service.tick()).toEqual({ executed: 0, materialized: 0 });
			expect(executor.calls).toHaveLength(1);
			await Bun.sleep(20);
			const occurrences = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id));
			expect(occurrences).toHaveLength(1);
			expect(occurrences[0]?.status).toBe("succeeded");
			const [row] = await database.select().from(schedules).where(eq(schedules.id, created.id));
			expect(row?.status).toBe("completed");
			expect(row?.runCount).toBe(1);
			const audits = await database.select().from(auditLog);
			expect(audits.some((entry) => entry.action === "schedule.create")).toBe(true);
		} finally {
			service.stop();
			database.$client.close();
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("dedupes creation and manual runs without shifting the regular next run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-schedules-"));
		const database = await seed(directory);
		let now = Date.parse("2026-11-17T00:00:00.000Z");
		const executor = new RecordingExecutor();
		const service = new ScheduleService({
			database: () => database,
			executor,
			logger,
			now: () => now,
		});
		try {
			const input = {
				actionKind: "agent_turn" as const,
				dedupeKey: "synthetic-dedupe",
				ownerId: "test-admin",
				ownerKind: "user" as const,
				prompt: "Synthetic reminder",
				recurrence: {
					anchorAt: "2026-11-17T00:00:00.000Z",
					everyMs: 3_600_000,
					kind: "interval" as const,
				},
				source: "test",
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			};
			const first = await service.create(input);
			const second = await service.create(input);
			expect(second.id).toBe(first.id);
			const nextBefore = second.nextRunAt;
			const manual = await service.runNow(first.id);
			expect(manual.triggerKind).toBe("manual");
			await waitFor(() => executor.calls.length === 1);
			expect(executor.calls).toHaveLength(1);
			const after = await service.get(first.id);
			expect(after?.nextRunAt).toBe(nextBefore);
			const occurrences = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, first.id));
			expect(occurrences).toHaveLength(1);
		} finally {
			service.stop();
			database.$client.close();
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("pauses, resumes, cancels, and recovers an expired lease", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-schedules-"));
		const database = await seed(directory);
		let now = Date.parse("2026-11-17T00:00:00.000Z");
		const executor = new RecordingExecutor();
		const service = new ScheduleService({
			database: () => database,
			executor,
			logger,
			now: () => now,
		});
		try {
			const created = await service.create({
				actionKind: "agent_turn",
				ownerId: "test-admin",
				ownerKind: "user",
				prompt: "Synthetic reminder",
				recurrence: {
					anchorAt: "2026-11-17T00:00:00.000Z",
					everyMs: 3_600_000,
					kind: "interval",
				},
				source: "test",
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			});
			expect((await service.pause(created.id)).status).toBe("paused");
			now += 3_600_000;
			expect((await service.tick()).executed).toBe(0);
			expect((await service.resume(created.id)).status).toBe("active");
			await database.insert(scheduleOccurrences).values({
				attempt: 1,
				availableAtMs: now,
				createdAtMs: now,
				id: "expired-occurrence",
				maxAttempts: 3,
				occurrenceKey: `manual:expired`,
				scheduleId: created.id,
				scheduleRevision: 1,
				scheduledForMs: now,
				snapshotJson: JSON.stringify({
					actionKind: "agent_turn",
					chatObjectId: "chat-1",
					prompt: "Synthetic reminder",
					respectQuietHours: false,
					revision: 1,
					scheduleId: created.id,
					sessionId: "session-1",
					title: "Synthetic schedule",
				}),
				status: "running",
				leaseExpiresAtMs: now - 1,
				triggerKind: "manual",
				updatedAtMs: now,
			});
			expect((await service.recover()).expired).toBe(1);
			const [recovered] = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.id, "expired-occurrence"));
			expect(recovered?.status).toBe("pending");
			expect((await service.cancel(created.id)).status).toBe("cancelled");
		} finally {
			service.stop();
			database.$client.close();
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("retries failures with backoff and records the terminal error", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-schedules-"));
		const database = await seed(directory);
		let now = Date.parse("2026-11-17T00:00:00.000Z");
		const executor = new RecordingExecutor();
		executor.error = new Error("synthetic failure");
		const service = new ScheduleService({
			database: () => database,
			executor,
			logger,
			now: () => now,
		});
		try {
			const created = await service.create({
				actionKind: "agent_turn",
				maxAttempts: 2,
				ownerId: "test-admin",
				ownerKind: "user",
				prompt: "Synthetic reminder",
				recurrence: { at: "2026-11-17T00:01:00.000Z", kind: "once" },
				source: "test",
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			});
			now = Date.parse("2026-11-17T00:01:01.000Z");
			await service.tick();
			let [occurrence] = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id));
			expect(occurrence?.status).toBe("pending");
			expect(occurrence?.attempt).toBe(1);
			now += 10_000;
			await service.tick();
			[occurrence] = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id));
			expect(occurrence?.status).toBe("failed");
			expect(occurrence?.error).toBe("synthetic failure");
		} finally {
			service.stop();
			database.$client.close();
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("records skipped and uncertain results without counting a successful run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-schedules-"));
		const database = await seed(directory);
		let now = Date.parse("2026-11-17T00:00:00.000Z");
		const executor = new RecordingExecutor();
		executor.resultStatus = "skipped";
		const service = new ScheduleService({
			database: () => database,
			executor,
			logger,
			now: () => now,
		});
		try {
			const created = await service.create({
				actionKind: "agent_turn",
				ownerId: "test-admin",
				ownerKind: "user",
				prompt: "Synthetic reminder",
				recurrence: {
					anchorAt: "2026-11-17T00:00:00.000Z",
					everyMs: 3_600_000,
					kind: "interval",
				},
				source: "test",
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			});
			now += 3_600_001;
			await service.tick();
			const [occurrence] = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id));
			expect(occurrence?.status).toBe("skipped");
			const afterSkip = await service.get(created.id);
			expect(afterSkip?.runCount).toBe(0);
			executor.resultStatus = "uncertain";
			now += 3_600_001;
			await service.tick();
			const occurrences = await database
				.select()
				.from(scheduleOccurrences)
				.where(eq(scheduleOccurrences.scheduleId, created.id));
			expect(occurrences.some((entry) => entry.status === "uncertain")).toBe(true);
			const afterUncertain = await service.get(created.id);
			expect(afterUncertain?.runCount).toBe(0);
		} finally {
			service.stop();
			database.$client.close();
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("rejects invalid targets and time zones", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-schedules-"));
		const database = await seed(directory);
		const service = new ScheduleService({
			database: () => database,
			executor: new RecordingExecutor(),
			logger,
		});
		try {
			const base = {
				actionKind: "agent_turn" as const,
				ownerId: "test-admin",
				ownerKind: "user" as const,
				prompt: "Synthetic reminder",
				recurrence: { at: "2026-11-18T00:00:00.000Z", kind: "once" as const },
				source: "test",
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			};
			await expect(service.create({ ...base, targetSessionId: "missing" })).rejects.toThrow(
				"Target session not found",
			);
			await expect(service.create({ ...base, timeZone: "Not/AZone" })).rejects.toThrow(
				"Invalid time zone",
			);
			await expect(service.create({ ...base, actionKind: "workspace_turn" })).rejects.toThrow(
				"requires a workspace",
			);
		} finally {
			service.stop();
			database.$client.close();
			await rm(directory, { force: true, recursive: true });
		}
	});
});
