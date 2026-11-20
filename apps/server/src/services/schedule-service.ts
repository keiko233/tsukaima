import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { scheduleRecurrenceSchema } from "@tsukaima/contracts";
import type {
	ScheduleCreateInput,
	ScheduleDetail,
	ScheduleOccurrence,
	ScheduleOccurrenceStatus,
	ScheduleRecurrence,
	ScheduleStatus,
	ScheduleSummary,
	ScheduleSummaryOutput,
	ScheduleUpdateInput,
} from "@tsukaima/contracts";
import {
	chatObjects,
	conversations,
	scheduleOccurrences,
	schedules,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import {
	catchUpDefaults,
	isValidTimeZone,
	nextOccurrence,
	previewOccurrences,
} from "./schedule-time.ts";

type ScheduleRow = typeof schedules.$inferSelect;
type OccurrenceRow = typeof scheduleOccurrences.$inferSelect;

export interface ScheduleSnapshot {
	readonly actionKind: ScheduleRow["actionKind"];
	readonly chatObjectId: string | null;
	readonly flexWindowMs: number | null;
	readonly prompt: string;
	readonly recurrenceKind: ScheduleRecurrence["kind"];
	readonly respectQuietHours: boolean;
	readonly revision: number;
	readonly scheduleId: string;
	readonly sessionId: string;
	readonly timeZone: string;
	readonly title: string;
}

export interface ScheduleExecutionResult {
	readonly deferredUntilMs?: number;
	readonly messageId?: string;
	readonly result?: unknown;
	readonly status?: "deferred" | "skipped" | "succeeded" | "uncertain";
}

export interface ScheduleChange {
	readonly actionKind: ScheduleRow["actionKind"];
	readonly id: string;
	readonly nextRunAt: string | null;
	readonly ownerId: string;
	readonly ownerKind: ScheduleRow["ownerKind"];
	readonly ownerPluginId: string | null;
	readonly status: ScheduleRow["status"];
	readonly targetSessionId: string;
	readonly title: string;
}

export interface ScheduleExecutor {
	execute(input: {
		readonly occurrence: ScheduleOccurrence;
		readonly snapshot: ScheduleSnapshot;
	}): Promise<ScheduleExecutionResult>;
}

export interface CreateScheduleInput extends ScheduleCreateInput {
	readonly ownerId: string;
	readonly ownerKind: "user" | "agent" | "plugin" | "system";
	readonly ownerPluginId?: string;
	readonly source: string;
}

export interface ScheduleServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly executor: ScheduleExecutor;
	readonly logger: Logger;
	readonly now?: () => number;
	readonly onChanged?: (change: ScheduleChange) => void;
	readonly tickIntervalMs?: number;
	readonly tickLimit?: number;
}

function iso(ms: number | null): string | null {
	return ms === null ? null : new Date(ms).toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface ScheduleRecurrenceMetadata {
	readonly cancelIfReplied: boolean;
	readonly flexWindowMs: number | null;
}

interface StoredRecurrenceEnvelope {
	readonly recurrence: ScheduleRecurrence;
	readonly scheduleMeta: ScheduleRecurrenceMetadata;
}

function encodeRecurrenceJson(
	recurrence: ScheduleRecurrence,
	meta: ScheduleRecurrenceMetadata,
): string {
	if (!meta.cancelIfReplied && meta.flexWindowMs === null) {
		return JSON.stringify(recurrence);
	}
	const envelope: StoredRecurrenceEnvelope = {
		recurrence,
		scheduleMeta: meta,
	};
	return JSON.stringify(envelope);
}

function decodeRecurrenceJson(
	value: string,
	fallback: ScheduleRecurrence | null,
): {
	readonly cancelIfReplied: boolean;
	readonly flexWindowMs: number | null;
	readonly recurrence: ScheduleRecurrence | null;
} {
	const parsed = parseJson<unknown>(value, null);
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const record = parsed as Record<string, unknown>;
		if (
			"scheduleMeta" in record &&
			typeof record.scheduleMeta === "object" &&
			record.scheduleMeta !== null &&
			"recurrence" in record &&
			typeof record.recurrence === "object" &&
			record.recurrence !== null
		) {
			const meta = record.scheduleMeta as Record<string, unknown>;
			return {
				cancelIfReplied: meta.cancelIfReplied === true,
				flexWindowMs:
					typeof meta.flexWindowMs === "number" && Number.isFinite(meta.flexWindowMs)
						? meta.flexWindowMs
						: null,
				recurrence: record.recurrence as ScheduleRecurrence,
			};
		}
		if ("kind" in record) {
			return {
				cancelIfReplied: false,
				flexWindowMs: null,
				recurrence: parsed as ScheduleRecurrence,
			};
		}
	}
	return {
		cancelIfReplied: false,
		flexWindowMs: null,
		recurrence: fallback,
	};
}

function summaryFrom(row: ScheduleRow, targetSessionTitle: string): ScheduleSummary {
	const decoded = decodeRecurrenceJson(row.recurrenceJson, {
		at: new Date(row.createdAtMs).toISOString(),
		kind: "once",
	});
	return {
		actionKind: row.actionKind,
		catchUp: row.catchUp,
		createdAt: new Date(row.createdAtMs).toISOString(),
		id: row.id,
		lastRunAt: iso(row.lastRunAtMs),
		maxRuns: row.maxRuns,
		nextRunAt: iso(row.nextRunAtMs),
		ownerKind: row.ownerKind,
		recurrence: decoded.recurrence ?? {
			at: new Date(row.createdAtMs).toISOString(),
			kind: "once",
		},
		runCount: row.runCount,
		source: row.source,
		status: row.status,
		targetChatObjectId: row.targetChatObjectId,
		targetSessionId: row.targetSessionId,
		targetSessionTitle,
		timeZone: row.timeZone,
		title: row.title,
		updatedAt: new Date(row.updatedAtMs).toISOString(),
	};
}

function detailFrom(
	row: ScheduleRow,
	targetSessionTitle: string,
	occurrences: ScheduleOccurrence[],
): ScheduleDetail {
	const decoded = decodeRecurrenceJson(row.recurrenceJson, null);
	return {
		...summaryFrom(row, targetSessionTitle),
		cancelIfReplied: decoded.cancelIfReplied,
		flexWindowMs: decoded.flexWindowMs,
		graceMs: row.graceMs,
		maxAttempts: row.maxAttempts,
		occurrences,
		ownerId: row.ownerId,
		ownerPluginId: row.ownerPluginId,
		prompt: row.prompt,
		respectQuietHours: row.respectQuietHours,
		revision: row.revision,
	};
}

function changeFrom(row: ScheduleRow): ScheduleChange {
	return {
		actionKind: row.actionKind,
		id: row.id,
		nextRunAt: iso(row.nextRunAtMs),
		ownerId: row.ownerId,
		ownerKind: row.ownerKind,
		ownerPluginId: row.ownerPluginId,
		status: row.status,
		targetSessionId: row.targetSessionId,
		title: row.title,
	};
}

function occurrenceFrom(row: OccurrenceRow): ScheduleOccurrence {
	return {
		attempt: row.attempt,
		error: row.error,
		finishedAt: iso(row.finishedAtMs),
		id: row.id,
		messageId: row.messageId,
		scheduledFor: new Date(row.scheduledForMs).toISOString(),
		startedAt: iso(row.startedAtMs),
		status: row.status,
		triggerKind: row.triggerKind,
	};
}

function snapshotFrom(row: ScheduleRow): ScheduleSnapshot {
	const decoded = decodeRecurrenceJson(row.recurrenceJson, null);
	return {
		actionKind: row.actionKind,
		chatObjectId: row.targetChatObjectId,
		flexWindowMs: decoded.flexWindowMs,
		prompt: row.prompt,
		recurrenceKind: decoded.recurrence?.kind ?? row.recurrenceKind,
		respectQuietHours: row.respectQuietHours,
		revision: row.revision,
		scheduleId: row.id,
		sessionId: row.targetSessionId,
		timeZone: row.timeZone,
		title: row.title,
	};
}

/**
 * Host-owned durable schedules. The runner materializes one immutable occurrence per due time,
 * claims it atomically, and delegates the side effect to `ScheduleExecutor`.
 */
export class ScheduleService {
	readonly #audit: ScheduleServiceOptions["audit"];
	readonly #database: ScheduleServiceOptions["database"];
	readonly #executor: ScheduleExecutor;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #onChanged: ScheduleServiceOptions["onChanged"];
	readonly #tickIntervalMs: number;
	readonly #tickLimit: number;
	readonly #listeners = new Set<(change: ScheduleChange) => void>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#ticking = false;
	#closed = false;

	constructor(options: ScheduleServiceOptions) {
		this.#audit = options.audit;
		this.#database = options.database;
		this.#executor = options.executor;
		this.#logger = options.logger.child("tsukaima::server::schedules");
		this.#now = options.now ?? Date.now;
		this.#onChanged = options.onChanged;
		this.#tickIntervalMs = Math.max(1_000, options.tickIntervalMs ?? 15_000);
		this.#tickLimit = Math.max(1, options.tickLimit ?? 20);
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	start(): void {
		this.#closed = false;
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => {
			void this.tick().catch((error: unknown) => {
				this.#logger.warn("schedule tick failed", { error: errorMessage(error) });
			});
		}, this.#tickIntervalMs);
		this.#timer.unref?.();
		this.#logger.info("schedule runner started", { intervalMs: this.#tickIntervalMs });
	}

	stop(): void {
		this.#closed = true;
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#logger.info("schedule runner stopped");
	}

	kick(): void {
		if (this.#closed) return;
		void this.tick().catch((error: unknown) => {
			this.#logger.warn("schedule kick failed", { error: errorMessage(error) });
		});
	}

	onChanged(listener: (change: ScheduleChange) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async recover(): Promise<{ expired: number; repaired: number }> {
		const database = this.#db();
		const now = this.#now();
		const expiredRows = await database
			.select()
			.from(scheduleOccurrences)
			.where(
				and(
					inArray(scheduleOccurrences.status, ["claimed", "running"]),
					or(
						isNull(scheduleOccurrences.leaseExpiresAtMs),
						lte(scheduleOccurrences.leaseExpiresAtMs, now),
					),
				),
			)
			.limit(500);
		for (const row of expiredRows) {
			const terminal = row.attempt >= row.maxAttempts;
			await database
				.update(scheduleOccurrences)
				.set({
					error: terminal ? "execution lease expired" : row.error,
					leaseExpiresAtMs: null,
					leaseOwner: null,
					status: terminal ? "failed" : "pending",
					updatedAtMs: now,
					...(terminal ? { finishedAtMs: now } : { availableAtMs: now }),
				})
				.where(eq(scheduleOccurrences.id, row.id));
		}

		const active = await database.select().from(schedules).where(eq(schedules.status, "active"));
		let repaired = 0;
		for (const row of active) {
			if (row.nextRunAtMs !== null) continue;
			const { recurrence } = decodeRecurrenceJson(row.recurrenceJson, null);
			if (recurrence === null || (row.maxRuns !== null && row.runCount >= row.maxRuns)) continue;
			const next = nextOccurrence({
				afterMs: Math.max(now - 1, row.lastRunAtMs ?? 0),
				recurrence,
				timeZone: row.timeZone,
			});
			await database
				.update(schedules)
				.set({
					nextRunAtMs: next ?? null,
					status: next === undefined ? "completed" : "active",
					updatedAtMs: now,
					...(next === undefined ? { completedAtMs: now } : {}),
				})
				.where(eq(schedules.id, row.id));
			repaired += 1;
		}
		this.#logger.info("schedule recovery completed", {
			expired: expiredRows.length,
			repaired,
		});
		return { expired: expiredRows.length, repaired };
	}

	async create(input: CreateScheduleInput): Promise<ScheduleDetail> {
		const database = this.#db();
		const now = this.#now();
		if (!isValidTimeZone(input.timeZone)) throw new Error(`Invalid time zone: ${input.timeZone}`);
		const [target] = await database
			.select({ chat: chatObjects, session: conversations })
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.id, input.targetSessionId))
			.limit(1);
		if (target === undefined) throw new Error("Target session not found");
		if (target.session.status !== "active") throw new Error("Target session is archived");
		if (target.chat.status !== "active") throw new Error("Target chat is archived");
		if (target.session.kind === "task" || target.session.kind === "plugin") {
			throw new Error("Schedules cannot target task or plugin sessions");
		}
		if (input.actionKind === "workspace_turn" && target.session.kind !== "workspace") {
			throw new Error("workspace_turn requires a workspace session");
		}
		if (input.actionKind === "agent_turn" && target.session.kind === "workspace") {
			throw new Error("Use workspace_turn for a workspace session");
		}
		// Parse, never trust the typed crate shape: this path is reachable from RPC input and a
		// malformed recurrence must fail before any row is written.
		const recurrence = scheduleRecurrenceSchema.parse(input.recurrence);
		if (recurrence.kind === "once") {
			const at = Date.parse(recurrence.at);
			if (!Number.isFinite(at)) throw new Error("Invalid one-time schedule");
		}
		const defaults = catchUpDefaults(recurrence);
		const catchUp = input.catchUp ?? defaults.catchUp;
		const flexWindowMs = input.flexWindowMs ?? null;
		const graceMs = input.graceMs ?? (flexWindowMs !== null ? flexWindowMs : defaults.graceMs);
		const maxAttempts = input.maxAttempts ?? 3;
		const next = nextOccurrence({
			afterMs: now - 1,
			recurrence,
			timeZone: input.timeZone,
		});
		if (next === undefined) throw new Error("Schedule has no future occurrence");
		if (input.dedupeKey !== undefined) {
			const [existing] = await database
				.select({ id: schedules.id })
				.from(schedules)
				.where(eq(schedules.dedupeKey, input.dedupeKey))
				.limit(1);
			if (existing !== undefined) {
				const detail = await this.get(existing.id);
				if (detail !== null) return detail;
			}
		}
		const id = randomUUID();
		await database.insert(schedules).values({
			actionKind: input.actionKind,
			catchUp,
			createdAtMs: now,
			dedupeKey: input.dedupeKey ?? null,
			graceMs,
			id,
			maxAttempts,
			maxRuns: input.maxRuns ?? null,
			nextRunAtMs: next,
			ownerId: input.ownerId,
			ownerKind: input.ownerKind,
			ownerPluginId: input.ownerPluginId ?? null,
			prompt: input.prompt,
			recurrenceJson: encodeRecurrenceJson(recurrence, {
				cancelIfReplied: input.cancelIfReplied === true,
				flexWindowMs,
			}),
			recurrenceKind: recurrence.kind,
			respectQuietHours: input.respectQuietHours ?? false,
			revision: 1,
			runCount: 0,
			source: input.source,
			status: "active",
			targetChatObjectId: target.chat.id,
			targetSessionId: target.session.id,
			timeZone: input.timeZone,
			title: input.title,
			updatedAtMs: now,
		});
		await this.#recordAudit({
			action: "schedule.create",
			actorId: input.ownerId,
			actorKind: input.ownerKind === "plugin" ? "plugin" : input.ownerKind,
			payload: {
				actionKind: input.actionKind,
				recurrenceKind: recurrence.kind,
				sessionId: target.session.id,
			},
			result: "ok",
			targetId: id,
			targetKind: "schedule",
		});
		this.#changed(changeFrom((await this.#scheduleRow(id))!));
		const detail = await this.get(id);
		if (detail === null) throw new Error("Schedule was not persisted");
		return detail;
	}

	async get(id: string): Promise<ScheduleDetail | null> {
		const database = this.#db();
		const [row] = await database
			.select({ schedule: schedules, chat: chatObjects, session: conversations })
			.from(schedules)
			.innerJoin(conversations, eq(conversations.id, schedules.targetSessionId))
			.leftJoin(chatObjects, eq(chatObjects.id, schedules.targetChatObjectId))
			.where(eq(schedules.id, id))
			.limit(1);
		if (row === undefined) return null;
		const occurrences = await this.occurrences(id, 50);
		return {
			...detailFrom(
				row.schedule,
				row.session.title ?? row.chat?.title ?? row.session.id,
				occurrences,
			),
		};
	}

	async list(
		input: {
			readonly limit?: number;
			readonly sessionId?: string;
			readonly status?: ScheduleStatus;
		} = {},
	): Promise<ScheduleSummary[]> {
		const database = this.#db();
		const rows = await database
			.select({ schedule: schedules, chat: chatObjects, session: conversations })
			.from(schedules)
			.innerJoin(conversations, eq(conversations.id, schedules.targetSessionId))
			.leftJoin(chatObjects, eq(chatObjects.id, schedules.targetChatObjectId))
			.where(
				and(
					...(input.sessionId === undefined
						? []
						: [eq(schedules.targetSessionId, input.sessionId)]),
					...(input.status === undefined ? [] : [eq(schedules.status, input.status)]),
				),
			)
			.orderBy(asc(schedules.nextRunAtMs), desc(schedules.createdAtMs))
			.limit(Math.min(500, Math.max(1, input.limit ?? 100)));
		return rows.map((row) =>
			summaryFrom(row.schedule, row.session.title ?? row.chat?.title ?? row.session.id),
		);
	}

	async update(input: ScheduleUpdateInput): Promise<ScheduleDetail> {
		const database = this.#db();
		const now = this.#now();
		const [row] = await database
			.select()
			.from(schedules)
			.where(eq(schedules.id, input.scheduleId))
			.limit(1);
		if (row === undefined) throw new Error("Schedule not found");
		if (row.status === "cancelled") throw new Error("Cancelled schedules cannot be edited");
		const existingMeta = decodeRecurrenceJson(row.recurrenceJson, {
			at: new Date(row.createdAtMs).toISOString(),
			kind: "once",
		});
		const recurrence = existingMeta.recurrence ?? {
			at: new Date(row.createdAtMs).toISOString(),
			kind: "once",
		};
		const nextRecurrence = input.recurrence ?? recurrence;
		const nextCancelIfReplied = input.cancelIfReplied ?? existingMeta.cancelIfReplied;
		const nextFlexWindowMs =
			input.flexWindowMs === undefined ? existingMeta.flexWindowMs : input.flexWindowMs;
		const metaChanged =
			input.recurrence !== undefined ||
			input.cancelIfReplied !== undefined ||
			input.flexWindowMs !== undefined;
		const timeZone = input.timeZone ?? row.timeZone;
		if (!isValidTimeZone(timeZone)) throw new Error(`Invalid time zone: ${timeZone}`);
		const next =
			row.status === "active"
				? nextOccurrence({ afterMs: now - 1, recurrence: nextRecurrence, timeZone })
				: row.nextRunAtMs;
		const [updated] = await database
			.update(schedules)
			.set({
				...(input.catchUp === undefined ? {} : { catchUp: input.catchUp }),
				...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
				...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
				...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
				...(input.prompt === undefined ? {} : { prompt: input.prompt }),
				...(metaChanged
					? {
							recurrenceJson: encodeRecurrenceJson(nextRecurrence, {
								cancelIfReplied: nextCancelIfReplied,
								flexWindowMs: nextFlexWindowMs,
							}),
							recurrenceKind: nextRecurrence.kind,
						}
					: {}),
				...(input.respectQuietHours === undefined
					? {}
					: { respectQuietHours: input.respectQuietHours }),
				...(input.title === undefined ? {} : { title: input.title }),
				nextRunAtMs: next ?? null,
				revision: row.revision + 1,
				status:
					row.status === "active" && next === undefined && nextRecurrence.kind === "once"
						? "completed"
						: row.status,
				timeZone,
				updatedAtMs: now,
			})
			.where(eq(schedules.id, row.id))
			.returning();
		await this.#recordAudit({
			action: "schedule.update",
			actorKind: "user",
			payload: { changedFields: Object.keys(input).filter((key) => key !== "scheduleId") },
			result: "ok",
			targetId: row.id,
			targetKind: "schedule",
		});
		this.#changed(changeFrom(updated ?? row));
		const detail = await this.get(row.id);
		if (detail === null) throw new Error("Schedule disappeared");
		return detail;
	}

	async pause(id: string): Promise<ScheduleSummary> {
		const database = this.#db();
		const now = this.#now();
		const [row] = await database
			.update(schedules)
			.set({ pausedAtMs: now, status: "paused", updatedAtMs: now })
			.where(and(eq(schedules.id, id), eq(schedules.status, "active")))
			.returning();
		if (row === undefined) throw new Error("Active schedule not found");
		await this.#auditMutation("schedule.pause", row);
		this.#changed(changeFrom(row));
		return (await this.#summary(id))!;
	}

	async resume(id: string): Promise<ScheduleSummary> {
		const database = this.#db();
		const now = this.#now();
		const [row] = await database.select().from(schedules).where(eq(schedules.id, id)).limit(1);
		if (row === undefined || row.status !== "paused") throw new Error("Paused schedule not found");
		const recurrence = decodeRecurrenceJson(row.recurrenceJson, {
			at: new Date(row.createdAtMs).toISOString(),
			kind: "once",
		}).recurrence ?? {
			at: new Date(row.createdAtMs).toISOString(),
			kind: "once",
		};
		const next = nextOccurrence({ afterMs: now - 1, recurrence, timeZone: row.timeZone });
		if (next === undefined) throw new Error("Schedule has no future occurrence");
		const [updated] = await database
			.update(schedules)
			.set({ nextRunAtMs: next, pausedAtMs: null, status: "active", updatedAtMs: now })
			.where(eq(schedules.id, id))
			.returning();
		if (updated === undefined) throw new Error("Schedule resume failed");
		await this.#auditMutation("schedule.resume", updated);
		this.#changed(changeFrom(updated));
		return (await this.#summary(id))!;
	}

	async cancel(id: string): Promise<ScheduleSummary> {
		const database = this.#db();
		const now = this.#now();
		const [row] = await database
			.update(schedules)
			.set({ cancelledAtMs: now, nextRunAtMs: null, status: "cancelled", updatedAtMs: now })
			.where(and(eq(schedules.id, id), inArray(schedules.status, ["active", "paused", "failed"])))
			.returning();
		if (row === undefined) throw new Error("Cancellable schedule not found");
		await database
			.update(scheduleOccurrences)
			.set({ status: "cancelled", updatedAtMs: now })
			.where(
				and(
					eq(scheduleOccurrences.scheduleId, id),
					inArray(scheduleOccurrences.status, ["pending", "claimed"]),
				),
			);
		await this.#auditMutation("schedule.cancel", row);
		this.#changed(changeFrom(row));
		return (await this.#summary(id))!;
	}

	/**
	 * Cancel active `cancelIfReplied` schedules for `sessionId` when the user sends a new inbound
	 * message before the reminder or check-in fires.
	 */
	async cancelRepliedSchedules(sessionId: string): Promise<number> {
		const database = this.#database();
		if (database === undefined) return 0;
		const rows = await database
			.select()
			.from(schedules)
			.where(and(eq(schedules.targetSessionId, sessionId), eq(schedules.status, "active")));
		const now = this.#now();
		let cancelled = 0;
		for (const row of rows) {
			if (!decodeRecurrenceJson(row.recurrenceJson, null).cancelIfReplied) continue;
			const [updated] = await database
				.update(schedules)
				.set({ cancelledAtMs: now, nextRunAtMs: null, status: "cancelled", updatedAtMs: now })
				.where(and(eq(schedules.id, row.id), eq(schedules.status, "active")))
				.returning();
			if (updated === undefined) continue;
			await database
				.update(scheduleOccurrences)
				.set({ status: "cancelled", updatedAtMs: now })
				.where(
					and(
						eq(scheduleOccurrences.scheduleId, row.id),
						inArray(scheduleOccurrences.status, ["pending", "claimed"]),
					),
				);
			await this.#recordAudit({
				action: "schedule.cancel-replied",
				actorKind: "system",
				payload: { sessionId },
				result: "ok",
				targetId: row.id,
				targetKind: "schedule",
			});
			this.#changed(changeFrom(updated));
			cancelled += 1;
		}
		return cancelled;
	}

	async runNow(id: string): Promise<ScheduleOccurrence> {
		const database = this.#db();
		const now = this.#now();
		const [row] = await database.select().from(schedules).where(eq(schedules.id, id)).limit(1);
		if (row === undefined) throw new Error("Schedule not found");
		if (row.status === "cancelled") throw new Error("Cancelled schedules cannot run");
		const occurrence = await this.#insertOccurrence({
			row,
			scheduledForMs: now,
			triggerKind: "manual",
			status: "pending",
		});
		await this.#recordAudit({
			action: "schedule.run-now",
			actorKind: "user",
			payload: { occurrenceId: occurrence.id, sessionId: row.targetSessionId },
			result: "ok",
			targetId: row.id,
			targetKind: "schedule",
		});
		this.#changed(changeFrom(row));
		this.kick();
		return occurrenceFrom(occurrence);
	}

	async occurrences(id: string, limit = 50): Promise<ScheduleOccurrence[]> {
		const database = this.#db();
		const rows = await database
			.select()
			.from(scheduleOccurrences)
			.where(eq(scheduleOccurrences.scheduleId, id))
			.orderBy(desc(scheduleOccurrences.scheduledForMs))
			.limit(Math.min(200, Math.max(1, limit)));
		return rows.map(occurrenceFrom);
	}

	preview(input: {
		readonly count?: number;
		readonly recurrence: ScheduleRecurrence;
		readonly timeZone: string;
	}): string[] {
		return previewOccurrences({
			count: input.count ?? 5,
			recurrence: input.recurrence,
			timeZone: input.timeZone,
		}).map((ms) => new Date(ms).toISOString());
	}

	async summary(
		input: { readonly sessionIds?: readonly string[] } = {},
	): Promise<ScheduleSummaryOutput> {
		const database = this.#db();
		const now = this.#now();
		const active = await database
			.select({ nextRunAtMs: schedules.nextRunAtMs, sessionId: schedules.targetSessionId })
			.from(schedules)
			.where(eq(schedules.status, "active"));
		const sessions = new Map<string, { active: number; nextRunAt: number | null }>();
		let overdue = 0;
		let dueSoon = 0;
		for (const row of active) {
			if (row.nextRunAtMs !== null && row.nextRunAtMs <= now) overdue += 1;
			else if (row.nextRunAtMs !== null && row.nextRunAtMs <= now + 24 * 3_600_000) dueSoon += 1;
			const entry = sessions.get(row.sessionId) ?? { active: 0, nextRunAt: null };
			entry.active += 1;
			if (
				row.nextRunAtMs !== null &&
				(entry.nextRunAt === null || row.nextRunAtMs < entry.nextRunAt)
			) {
				entry.nextRunAt = row.nextRunAtMs;
			}
			sessions.set(row.sessionId, entry);
		}
		const requested = input.sessionIds ?? [...sessions.keys()];
		return {
			active: active.length,
			dueSoon,
			overdue,
			sessions: requested.map((sessionId) => {
				const entry = sessions.get(sessionId);
				return {
					active: entry?.active ?? 0,
					nextRunAt: iso(entry?.nextRunAt ?? null),
					sessionId,
				};
			}),
		};
	}

	/** Materialize due definitions and execute claimed occurrences. Safe to call repeatedly. */
	async tick(): Promise<{ executed: number; materialized: number }> {
		if (this.#closed || this.#ticking) return { executed: 0, materialized: 0 };
		this.#ticking = true;
		try {
			const materialized = await this.#materializeDue();
			const executed = await this.#executeDue();
			return { executed, materialized };
		} finally {
			this.#ticking = false;
		}
	}

	async #materializeDue(): Promise<number> {
		const database = this.#db();
		const now = this.#now();
		const due = await database
			.select()
			.from(schedules)
			.where(
				and(
					eq(schedules.status, "active"),
					lte(schedules.nextRunAtMs, now),
					sql`${schedules.nextRunAtMs} IS NOT NULL`,
				),
			)
			.orderBy(asc(schedules.nextRunAtMs))
			.limit(this.#tickLimit);
		let count = 0;
		for (const row of due) count += await this.#materializeSchedule(row, now);
		return count;
	}

	async #materializeSchedule(row: ScheduleRow, now: number): Promise<number> {
		const database = this.#db();
		const { recurrence } = decodeRecurrenceJson(row.recurrenceJson, null);
		if (recurrence === null) return 0;
		const times: number[] = [];
		let cursor = row.nextRunAtMs;
		for (let index = 0; index < 100 && cursor !== null && cursor <= now; index += 1) {
			times.push(cursor);
			const next = nextOccurrence({
				afterMs: cursor,
				recurrence,
				timeZone: row.timeZone,
			});
			cursor = next ?? null;
		}
		if (times.length === 0) return 0;
		let inserted = 0;
		const stale = times.filter((time) => time + row.graceMs < now);
		const current = times.filter((time) => time + row.graceMs >= now);
		const staleHistory = stale.slice(-10);
		const selected =
			row.catchUp === "all" ? staleHistory : row.catchUp === "latest" ? staleHistory.slice(-1) : [];
		if (staleHistory.length > 0) {
			for (const time of staleHistory) {
				const existing = await this.#occurrenceByKey(row.id, `scheduled:${time}`);
				if (existing === null) {
					await this.#insertOccurrence({
						row,
						scheduledForMs: time,
						status: selected.includes(time) ? "pending" : "skipped",
						triggerKind: "catch_up",
					});
					inserted += 1;
				}
			}
		}
		if (stale.length > 0) {
			await this.#recordAudit({
				action: "schedule.catch-up-skipped",
				actorKind: "system",
				payload: {
					count: stale.length,
					replayed: selected.length,
					sessionId: row.targetSessionId,
				},
				result: "ok",
				targetId: row.id,
				targetKind: "schedule",
			});
		}
		for (const time of current) {
			const existing = await this.#occurrenceByKey(row.id, `scheduled:${time}`);
			if (existing === null) {
				await this.#insertOccurrence({
					row,
					scheduledForMs: time,
					status: "pending",
					triggerKind: "scheduled",
				});
				inserted += 1;
			}
		}
		const exhausted = row.maxRuns !== null && row.runCount >= row.maxRuns;
		const next = exhausted ? null : cursor;
		// A one-off occurrence deferred past quiet hours shares its slot with the schedule's
		// next run. Keep the schedule active until that occurrence settles; otherwise the
		// materializer would mark it completed before the deferred execution actually happens.
		const lastTime = times[times.length - 1]!;
		const unresolved =
			next === null ? await this.#occurrenceByKey(row.id, `scheduled:${lastTime}`) : null;
		const waiting =
			unresolved !== null &&
			(unresolved.status === "pending" ||
				unresolved.status === "claimed" ||
				unresolved.status === "running");
		const nextRunAtMs = waiting ? lastTime : next;
		const [updated] = await database
			.update(schedules)
			.set({
				nextRunAtMs,
				status: nextRunAtMs === null ? "completed" : "active",
				updatedAtMs: now,
				...(nextRunAtMs === null ? { completedAtMs: now } : {}),
			})
			.where(eq(schedules.id, row.id))
			.returning();
		if (inserted > 0) this.#changed(changeFrom(updated ?? row));
		return inserted;
	}

	async #executeDue(): Promise<number> {
		const database = this.#db();
		const now = this.#now();
		const due = await database
			.select()
			.from(scheduleOccurrences)
			.where(
				and(eq(scheduleOccurrences.status, "pending"), lte(scheduleOccurrences.availableAtMs, now)),
			)
			.orderBy(asc(scheduleOccurrences.availableAtMs))
			.limit(this.#tickLimit);
		let executed = 0;
		for (const candidate of due) {
			const [claimed] = await database
				.update(scheduleOccurrences)
				.set({
					attempt: candidate.attempt + 1,
					leaseExpiresAtMs: now + 5 * 60_000,
					leaseOwner: "schedule-runner",
					status: "claimed",
					updatedAtMs: now,
				})
				.where(
					and(eq(scheduleOccurrences.id, candidate.id), eq(scheduleOccurrences.status, "pending")),
				)
				.returning();
			if (claimed === undefined) continue;
			await database
				.update(scheduleOccurrences)
				.set({ startedAtMs: now, status: "running", updatedAtMs: now })
				.where(eq(scheduleOccurrences.id, claimed.id));
			const rawSnapshot = parseJson<Partial<ScheduleSnapshot>>(claimed.snapshotJson, {});
			const snapshot: ScheduleSnapshot = {
				actionKind: rawSnapshot.actionKind ?? "agent_turn",
				chatObjectId: rawSnapshot.chatObjectId ?? null,
				flexWindowMs: rawSnapshot.flexWindowMs ?? null,
				prompt: rawSnapshot.prompt ?? "",
				recurrenceKind: rawSnapshot.recurrenceKind ?? "once",
				respectQuietHours: rawSnapshot.respectQuietHours ?? false,
				revision: rawSnapshot.revision ?? claimed.scheduleRevision,
				scheduleId: rawSnapshot.scheduleId ?? claimed.scheduleId,
				sessionId: rawSnapshot.sessionId ?? "",
				timeZone: rawSnapshot.timeZone ?? "UTC",
				title: rawSnapshot.title ?? "",
			};
			try {
				const result = await this.#executor.execute({
					occurrence: occurrenceFrom({ ...claimed, status: "running", startedAtMs: now }),
					snapshot,
				});
				await this.#settleResult(claimed, result);
				executed += 1;
			} catch (error) {
				await this.#settleFailure(claimed, error);
				executed += 1;
			}
		}
		return executed;
	}

	async #settleResult(occurrence: OccurrenceRow, result: ScheduleExecutionResult): Promise<void> {
		const database = this.#db();
		const now = this.#now();
		if (result.status === "deferred" && result.deferredUntilMs !== undefined) {
			const deferredUntilMs = result.deferredUntilMs;
			await database
				.update(scheduleOccurrences)
				.set({
					attempt: Math.max(0, occurrence.attempt - 1),
					availableAtMs: deferredUntilMs,
					finishedAtMs: null,
					leaseExpiresAtMs: null,
					leaseOwner: null,
					occurrenceKey: `scheduled:${deferredUntilMs}`,
					resultJson: JSON.stringify(result.result ?? { deferred: true }),
					scheduledForMs: deferredUntilMs,
					status: "pending",
					updatedAtMs: now,
				})
				.where(eq(scheduleOccurrences.id, occurrence.id));
			const [updated] = await database
				.update(schedules)
				.set({
					completedAtMs: null,
					nextRunAtMs: deferredUntilMs,
					status: "active",
					updatedAtMs: now,
				})
				// A cancel/pause that lands while the turn is running must win: never resurrect the
				// schedule behind the operator's back. The occurrence is settled below instead.
				.where(and(eq(schedules.id, occurrence.scheduleId), eq(schedules.status, "active")))
				.returning();
			if (updated === undefined) {
				await database
					.update(scheduleOccurrences)
					.set({
						finishedAtMs: now,
						leaseExpiresAtMs: null,
						leaseOwner: null,
						resultJson: JSON.stringify(result.result ?? { deferred: true }),
						status: "skipped",
						updatedAtMs: now,
					})
					.where(eq(scheduleOccurrences.id, occurrence.id));
				await this.#recordAudit({
					action: "schedule.deferred",
					actorKind: "system",
					payload: {
						deferredUntil: new Date(deferredUntilMs).toISOString(),
						occurrenceId: occurrence.id,
						reason: "schedule_no_longer_active",
					},
					reason: "schedule_cancelled_or_paused_during_run",
					result: "denied",
					targetId: occurrence.scheduleId,
					targetKind: "schedule",
				});
				this.#logger.info("schedule occurrence skipped after concurrent pause/cancel", {
					occurrenceId: occurrence.id,
					scheduleId: occurrence.scheduleId,
				});
				return;
			}
			await this.#recordAudit({
				action: "schedule.deferred",
				actorKind: "system",
				payload: {
					deferredUntil: new Date(deferredUntilMs).toISOString(),
					occurrenceId: occurrence.id,
					reason: "quiet_hours",
					sessionId: updated?.targetSessionId,
				},
				result: "ok",
				targetId: occurrence.scheduleId,
				targetKind: "schedule",
			});
			this.#logger.info("schedule occurrence deferred past quiet hours", {
				deferredUntil: new Date(deferredUntilMs).toISOString(),
				occurrenceId: occurrence.id,
				scheduleId: occurrence.scheduleId,
			});
			if (updated !== undefined) this.#changed(changeFrom(updated));
			return;
		}
		const status: "skipped" | "succeeded" | "uncertain" =
			result.status === "deferred" ? "skipped" : (result.status ?? "succeeded");
		await database
			.update(scheduleOccurrences)
			.set({
				finishedAtMs: now,
				leaseExpiresAtMs: null,
				leaseOwner: null,
				messageId: result.messageId ?? occurrence.messageId,
				resultJson: JSON.stringify(result.result ?? { ok: true }),
				status,
				updatedAtMs: now,
			})
			.where(eq(scheduleOccurrences.id, occurrence.id));
		const [row] = await database
			.select()
			.from(schedules)
			.where(eq(schedules.id, occurrence.scheduleId))
			.limit(1);
		if (row === undefined) return;
		const runCount = row.runCount + 1;
		const once = decodeRecurrenceJson(row.recurrenceJson, null).recurrence?.kind === "once";
		const exhausted = row.maxRuns !== null && runCount >= row.maxRuns;
		const completed = status === "succeeded" ? once || exhausted : once;
		const failedUncertain = status === "uncertain" && once;
		const [updated] = await database
			.update(schedules)
			.set({
				...(status === "succeeded" ? { lastRunAtMs: now, runCount } : {}),
				status: failedUncertain ? "failed" : completed ? "completed" : row.status,
				updatedAtMs: now,
				...(completed || failedUncertain ? { completedAtMs: now, nextRunAtMs: null } : {}),
			})
			.where(eq(schedules.id, row.id))
			.returning();
		this.#logger.info("schedule occurrence succeeded", {
			actionKind: row.actionKind,
			attempt: occurrence.attempt,
			occurrenceId: occurrence.id,
			scheduleId: row.id,
			status,
		});
		if (updated !== undefined) this.#changed(changeFrom(updated));
	}

	async #settleFailure(occurrence: OccurrenceRow, error: unknown): Promise<void> {
		const database = this.#db();
		const now = this.#now();
		const terminal = occurrence.attempt >= occurrence.maxAttempts;
		const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, occurrence.attempt - 1));
		await database
			.update(scheduleOccurrences)
			.set({
				availableAtMs: terminal ? occurrence.availableAtMs : now + delayMs,
				error: errorMessage(error).slice(0, 500),
				leaseExpiresAtMs: null,
				leaseOwner: null,
				status: terminal ? "failed" : "pending",
				updatedAtMs: now,
				...(terminal ? { finishedAtMs: now } : {}),
			})
			.where(eq(scheduleOccurrences.id, occurrence.id));
		this.#logger.warn("schedule occurrence failed", {
			attempt: occurrence.attempt,
			error: errorMessage(error),
			occurrenceId: occurrence.id,
			scheduleId: occurrence.scheduleId,
			terminal,
		});
		const [row] = await database
			.select()
			.from(schedules)
			.where(eq(schedules.id, occurrence.scheduleId))
			.limit(1);
		if (row !== undefined) this.#changed(changeFrom(row));
	}

	async #insertOccurrence(input: {
		readonly row: ScheduleRow;
		readonly scheduledForMs: number;
		readonly status: ScheduleOccurrenceStatus;
		readonly triggerKind: "scheduled" | "manual" | "catch_up";
	}): Promise<OccurrenceRow> {
		const database = this.#db();
		const now = this.#now();
		const id = randomUUID();
		const occurrenceKey =
			input.triggerKind === "manual" ? `manual:${id}` : `scheduled:${input.scheduledForMs}`;
		const [row] = await database
			.insert(scheduleOccurrences)
			.values({
				attempt: 0,
				availableAtMs: now,
				createdAtMs: now,
				id,
				maxAttempts: input.row.maxAttempts,
				occurrenceKey,
				scheduleId: input.row.id,
				scheduleRevision: input.row.revision,
				scheduledForMs: input.scheduledForMs,
				snapshotJson: JSON.stringify(snapshotFrom(input.row)),
				status: input.status,
				triggerKind: input.triggerKind,
				updatedAtMs: now,
				...(input.status === "skipped" ? { finishedAtMs: now } : {}),
			})
			.returning();
		if (row === undefined) throw new Error("Schedule occurrence was not persisted");
		return row;
	}

	async #occurrenceByKey(scheduleId: string, occurrenceKey: string) {
		const database = this.#db();
		const [row] = await database
			.select()
			.from(scheduleOccurrences)
			.where(
				and(
					eq(scheduleOccurrences.scheduleId, scheduleId),
					eq(scheduleOccurrences.occurrenceKey, occurrenceKey),
				),
			)
			.limit(1);
		return row ?? null;
	}

	async #summary(id: string): Promise<ScheduleSummary | null> {
		const detail = await this.get(id);
		if (detail === null) return null;
		const {
			cancelIfReplied: _cancelIfReplied,
			flexWindowMs: _flexWindow,
			graceMs: _grace,
			maxAttempts: _attempts,
			occurrences: _occurrences,
			prompt: _prompt,
			respectQuietHours: _quiet,
			revision: _revision,
			...summary
		} = detail;
		return summary;
	}

	async #auditMutation(action: string, row: ScheduleRow): Promise<void> {
		await this.#recordAudit({
			action,
			actorKind: "user",
			payload: { sessionId: row.targetSessionId },
			result: "ok",
			targetId: row.id,
			targetKind: "schedule",
		});
	}

	async #recordAudit(entry: AuditEntry): Promise<void> {
		try {
			await this.#audit?.(entry);
		} catch (error) {
			this.#logger.warn("schedule audit failed", {
				action: entry.action,
				error: errorMessage(error),
			});
		}
	}

	async #scheduleRow(id: string): Promise<ScheduleRow | null> {
		const database = this.#db();
		const [row] = await database.select().from(schedules).where(eq(schedules.id, id)).limit(1);
		return row ?? null;
	}

	#changed(change: ScheduleChange): void {
		for (const listener of this.#listeners) {
			try {
				listener(change);
			} catch (error) {
				this.#logger.warn("schedule change listener failed", {
					error: errorMessage(error),
					scheduleId: change.id,
				});
			}
		}
		try {
			this.#onChanged?.(change);
		} catch (error) {
			this.#logger.warn("schedule change notification failed", {
				error: errorMessage(error),
				scheduleId: change.id,
			});
		}
	}
}
