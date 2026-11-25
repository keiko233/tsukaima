import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
	type RunRound,
	type RunSegmentStatus,
	type RunSegmentSummary,
	type RunSegmentTriggerKind,
	type RunStep,
	runRoundSchema,
} from "@tsukaima/contracts";
import {
	conversationRunSegments,
	conversationRuns,
	conversations,
	messages,
	type TsukaimaDatabase,
} from "@tsukaima/db";

type SegmentRow = typeof conversationRunSegments.$inferSelect;
type RunRow = typeof conversationRuns.$inferSelect;

/** Timeline anchor of one segment, as a live run and a message row both reference it. */
export interface ConversationRunAnchor {
	readonly runId: string;
	readonly segmentId: string;
	readonly segmentIndex: number;
	readonly seq: number;
	readonly triggerKind: RunSegmentTriggerKind;
	readonly status: RunSegmentStatus;
}

export interface ConversationRunServiceOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly now?: () => number;
}

export interface StartConversationRunInput {
	readonly conversationId: string;
	readonly durableRunKey?: string | undefined;
	readonly runId?: string | undefined;
	readonly triggerKind?: RunSegmentTriggerKind;
	readonly triggerMessageId?: string | null | undefined;
}

export interface StartedConversationRun {
	readonly anchor: ConversationRunAnchor;
	readonly run: RunRow;
	readonly segment: SegmentRow;
}

export interface CloseSegmentForSteerInput {
	readonly conversationId: string;
	readonly currentRounds?: readonly RunRound[] | undefined;
	readonly runId?: string | undefined;
}

export interface OpenSegmentInput {
	readonly conversationId: string;
	readonly runId: string;
	readonly triggerKind: RunSegmentTriggerKind;
	readonly triggerMessageId?: string | null | undefined;
	/** Preallocated timeline position; the allocator is used when omitted. */
	readonly seq?: number | undefined;
}

export interface SplitSegmentForSteerInput {
	readonly conversationId: string;
	readonly currentRounds?: readonly RunRound[] | undefined;
	readonly runId?: string | undefined;
	/**
	 * Persist the steer user message at the allocated `seq`, returning its domain message id.
	 * The allocator places it strictly after the closed segment and before the next one.
	 */
	readonly persistTrigger: (input: {
		readonly seq: number;
		readonly runId: string;
		readonly segmentIndex: number;
	}) => Promise<string> | string;
}

export interface SettleConversationRunInput {
	readonly conversationId: string;
	readonly runId?: string | undefined;
	readonly segmentId?: string | undefined;
	readonly status: Exclude<RunSegmentStatus, "running" | "steered">;
	readonly finalMessageId?: string | null | undefined;
	readonly failureDetail?: string | null | undefined;
	readonly rounds?: readonly RunRound[] | undefined;
}

const SEGMENT_STATUSES: ReadonlySet<string> = new Set([
	"running",
	"steered",
	"completed",
	"interrupted",
	"failed",
	"suppressed",
]);

function parseRounds(json: string): RunRound[] {
	try {
		const parsed = runRoundSchema.array().safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

function statusOf(value: string): RunSegmentStatus {
	return SEGMENT_STATUSES.has(value) ? (value as RunSegmentStatus) : "running";
}

function durationMs(startedAt: string, endedAt: string): number {
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
	return Math.max(0, Math.round(end - start));
}

function toAnchor(segment: SegmentRow): ConversationRunAnchor {
	return {
		runId: segment.runId,
		segmentId: segment.id,
		segmentIndex: segment.segmentIndex,
		seq: segment.seq,
		triggerKind: segment.triggerKind,
		status: statusOf(segment.status),
	};
}

function toSegmentSummary(segment: SegmentRow): RunSegmentSummary {
	return {
		durationMs: segment.durationMs,
		endedAt: segment.endedAt,
		failureDetail: segment.failureDetail,
		finalMessageId: segment.finalMessageId,
		id: segment.id,
		rounds: parseRounds(segment.roundsJson),
		runId: segment.runId,
		segmentIndex: segment.segmentIndex,
		seq: segment.seq,
		startedAt: segment.startedAt,
		status: statusOf(segment.status),
		triggerKind: segment.triggerKind,
		triggerMessageId: segment.triggerMessageId,
	};
}

/**
 * Persist one structured round as the same step chain the transcript already renders.
 *
 * Segments are the durable source of truth after a run ends, so a reader that only knows the
 * step protocol must still be able to expand an answer without reading provider entries.
 */
export function roundsToRunSteps(rounds: readonly RunRound[]): RunStep[] {
	const steps: RunStep[] = [];
	let call = 0;
	let elapsedMs = 0;
	for (const round of rounds) {
		call += 1;
		const startedAtMs = elapsedMs;
		const endMs =
			round.durationMs === undefined ? undefined : startedAtMs + Math.max(0, round.durationMs);
		steps.push({
			attempt: 1,
			call,
			...(endMs === undefined ? {} : { endedAtMs: endMs }),
			...(round.failure === undefined ? {} : { error: round.failure }),
			kind: "model",
			...(round.model === undefined
				? {}
				: { modelId: round.model.modelId, providerId: round.model.providerId }),
			startedAtMs,
			status: round.stopReason === "error" ? "failed" : "done",
		});
		if (round.thinking !== undefined && round.thinking.trim().length > 0) {
			steps.push({ kind: "thinking", text: round.thinking });
		}
		if (round.intermediateText !== undefined && round.intermediateText.trim().length > 0) {
			steps.push({ kind: "text", text: round.intermediateText });
		}
		for (const tool of round.toolCalls) {
			steps.push({
				argumentsText: tool.argumentsText,
				isError: tool.isError,
				kind: "tool",
				output: tool.output,
				toolName: tool.toolName,
			});
		}
		if (round.failure !== undefined && round.stopReason === "error") {
			steps.push({ detail: round.failure, kind: "failure" });
		}
		elapsedMs = endMs ?? elapsedMs;
	}
	return steps;
}

/**
 * The durable run/segment timeline for one conversation.
 *
 * A message and the segment it anchors share one monotonic `seq` space, so a steer user message
 * can sit strictly between the segment it froze and the continuation segment. Every production
 * message insert asks this service for its `seq`; nothing infers order from wall clocks.
 */
export class ConversationRunService {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #now: () => number;

	constructor(options: ConversationRunServiceOptions) {
		this.#database = options.database;
		this.#now = options.now ?? Date.now;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	#iso(): string {
		return new Date(this.#now()).toISOString();
	}

	/**
	 * Atomically reserve the next timeline position of a conversation.
	 *
	 * SQLite evaluates the increment and the returned old value in one statement, so concurrent
	 * inserts can never share a `seq` or observe one out of order.
	 */
	async allocateSeq(conversationId: string): Promise<number> {
		const [row] = await this.#db()
			.update(conversations)
			.set({ nextSeq: sql`${conversations.nextSeq} + 1` })
			.where(eq(conversations.id, conversationId))
			.returning({ seq: conversations.nextSeq });
		if (row === undefined) throw new Error("Session not found");
		return row.seq - 1;
	}

	async startRun(input: StartConversationRunInput): Promise<StartedConversationRun> {
		const database = this.#db();
		const startedAt = this.#iso();
		const seq = await this.allocateSeq(input.conversationId);
		const runId = input.runId ?? randomUUID();
		const triggerKind = input.triggerKind ?? "initial";
		const triggerMessageId =
			input.triggerMessageId ?? (await this.#latestInboundMessageId(input.conversationId));
		await database.insert(conversationRuns).values({
			conversationId: input.conversationId,
			durableRunKey: input.durableRunKey ?? null,
			id: runId,
			seq,
			startedAt,
			status: "running",
			triggerMessageId,
			updatedAt: startedAt,
		});
		const segmentId = randomUUID();
		await database.insert(conversationRunSegments).values({
			conversationId: input.conversationId,
			id: segmentId,
			roundsJson: "[]",
			runId,
			segmentIndex: 0,
			seq,
			startedAt,
			status: "running",
			triggerKind,
			triggerMessageId,
			updatedAt: startedAt,
		});
		const [run] = await database
			.select()
			.from(conversationRuns)
			.where(eq(conversationRuns.id, runId))
			.limit(1);
		const [segment] = await database
			.select()
			.from(conversationRunSegments)
			.where(eq(conversationRunSegments.id, segmentId))
			.limit(1);
		if (run === undefined || segment === undefined) throw new Error("Failed to start run");
		return { anchor: toAnchor(segment), run, segment };
	}

	async #latestInboundMessageId(conversationId: string): Promise<string | null> {
		const [row] = await this.#db()
			.select({ id: messages.id })
			.from(messages)
			.where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "inbound")))
			.orderBy(desc(messages.seq), desc(messages.occurredAt), desc(messages.id))
			.limit(1);
		return row?.id ?? null;
	}

	async activeRun(conversationId: string): Promise<RunRow | undefined> {
		const [run] = await this.#db()
			.select()
			.from(conversationRuns)
			.where(
				and(
					eq(conversationRuns.conversationId, conversationId),
					eq(conversationRuns.status, "running"),
				),
			)
			.orderBy(desc(conversationRuns.seq))
			.limit(1);
		return run;
	}

	async getRun(runId: string): Promise<RunRow | undefined> {
		const [run] = await this.#db()
			.select()
			.from(conversationRuns)
			.where(eq(conversationRuns.id, runId))
			.limit(1);
		return run;
	}

	/** The running segment of the conversation's active run, if it has one. */
	async activeAnchor(conversationId: string): Promise<ConversationRunAnchor | undefined> {
		const run = await this.activeRun(conversationId);
		if (run === undefined) return undefined;
		const segment = await this.getLatestSegmentForRun(run.id, "running");
		return segment === undefined ? undefined : toAnchor(segment);
	}

	async getLatestSegmentForRun(
		runId: string,
		status?: RunSegmentStatus,
	): Promise<SegmentRow | undefined> {
		const [segment] = await this.#db()
			.select()
			.from(conversationRunSegments)
			.where(
				and(
					eq(conversationRunSegments.runId, runId),
					...(status === undefined ? [] : [eq(conversationRunSegments.status, status)]),
				),
			)
			.orderBy(desc(conversationRunSegments.segmentIndex))
			.limit(1);
		return segment;
	}

	async getSegmentById(segmentId: string): Promise<RunSegmentSummary | undefined> {
		const [segment] = await this.#db()
			.select()
			.from(conversationRunSegments)
			.where(eq(conversationRunSegments.id, segmentId))
			.limit(1);
		return segment === undefined ? undefined : toSegmentSummary(segment);
	}

	/** Newest segment of a run, as the public segment summary the transcript consumes. */
	async getLatestSegmentSummaryForRun(runId: string): Promise<RunSegmentSummary | undefined> {
		const segment = await this.getLatestSegmentForRun(runId);
		return segment === undefined ? undefined : toSegmentSummary(segment);
	}

	/**
	 * Resolve a run segment for a message, either through the row it belongs to or through the
	 * segment's final answer. `entryId` is `messages.durableEntryId` or the domain message id.
	 */
	async getSegmentForEntry(
		conversationId: string,
		entryId: string,
	): Promise<RunSegmentSummary | undefined> {
		const database = this.#db();
		const [row] = await database
			.select({
				id: messages.id,
				runId: messages.runId,
				segmentIndex: messages.segmentIndex,
			})
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					or(eq(messages.durableEntryId, entryId), eq(messages.id, entryId)),
				),
			)
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(1);
		if (row === undefined) return undefined;
		if (row.runId !== null && row.segmentIndex !== null) {
			const [segment] = await database
				.select()
				.from(conversationRunSegments)
				.where(
					and(
						eq(conversationRunSegments.runId, row.runId),
						eq(conversationRunSegments.segmentIndex, row.segmentIndex),
					),
				)
				.limit(1);
			if (segment !== undefined) return toSegmentSummary(segment);
		}
		const [finalSegment] = await database
			.select()
			.from(conversationRunSegments)
			.where(
				and(
					eq(conversationRunSegments.conversationId, conversationId),
					eq(conversationRunSegments.finalMessageId, row.id),
				),
			)
			.limit(1);
		return finalSegment === undefined ? undefined : toSegmentSummary(finalSegment);
	}

	async listSegmentsForConversation(
		conversationId: string,
		range: { readonly minSeq?: number | undefined; readonly maxSeq?: number | undefined } = {},
	): Promise<RunSegmentSummary[]> {
		const filters = [eq(conversationRunSegments.conversationId, conversationId)];
		if (range.minSeq !== undefined) {
			filters.push(sql`${conversationRunSegments.seq} >= ${range.minSeq}`);
		}
		if (range.maxSeq !== undefined) {
			filters.push(sql`${conversationRunSegments.seq} <= ${range.maxSeq}`);
		}
		const rows = await this.#db()
			.select()
			.from(conversationRunSegments)
			.where(and(...filters))
			.orderBy(asc(conversationRunSegments.seq), asc(conversationRunSegments.segmentIndex));
		return rows.map(toSegmentSummary);
	}

	/**
	 * Freeze the running segment before a steer message is inserted. Its rounds are stored here,
	 * so work from before the steer can never leak into the continuation segment.
	 */
	async closeActiveSegmentForSteer(
		input: CloseSegmentForSteerInput,
	): Promise<SegmentRow | undefined> {
		const database = this.#db();
		const run =
			input.runId === undefined
				? await this.activeRun(input.conversationId)
				: await this.getRun(input.runId);
		if (run === undefined || run.status !== "running") return undefined;
		const segment = await this.getLatestSegmentForRun(run.id, "running");
		if (segment === undefined) return undefined;
		const endedAt = this.#iso();
		await database
			.update(conversationRunSegments)
			.set({
				durationMs: durationMs(segment.startedAt, endedAt),
				endedAt,
				...(input.currentRounds === undefined
					? {}
					: { roundsJson: JSON.stringify(input.currentRounds) }),
				status: "steered",
				updatedAt: endedAt,
			})
			.where(eq(conversationRunSegments.id, segment.id));
		const [updated] = await database
			.select()
			.from(conversationRunSegments)
			.where(eq(conversationRunSegments.id, segment.id))
			.limit(1);
		return updated;
	}

	/**
	 * Open the continuation segment of a steered run at its own timeline position.
	 */
	async openSegment(input: OpenSegmentInput): Promise<ConversationRunAnchor> {
		const database = this.#db();
		const latest = await this.getLatestSegmentForRun(input.runId);
		if (latest === undefined) throw new Error("Run not found");
		const now = this.#iso();
		const seq = input.seq ?? (await this.allocateSeq(input.conversationId));
		const segmentId = randomUUID();
		await database.insert(conversationRunSegments).values({
			conversationId: input.conversationId,
			id: segmentId,
			roundsJson: "[]",
			runId: input.runId,
			segmentIndex: latest.segmentIndex + 1,
			seq,
			startedAt: now,
			status: "running",
			triggerKind: input.triggerKind,
			triggerMessageId: input.triggerMessageId ?? null,
			updatedAt: now,
		});
		await database
			.update(conversationRuns)
			.set({ updatedAt: now })
			.where(eq(conversationRuns.id, input.runId));
		const [segment] = await database
			.select()
			.from(conversationRunSegments)
			.where(eq(conversationRunSegments.id, segmentId))
			.limit(1);
		if (segment === undefined) throw new Error("Failed to open run segment");
		return toAnchor(segment);
	}

	/**
	 * Close the active segment and place a steer message strictly between it and its successor.
	 */
	async splitSegmentForSteer(input: SplitSegmentForSteerInput): Promise<
		| {
				readonly closedSegment: SegmentRow;
				readonly runId: string;
				readonly segment: ConversationRunAnchor;
				readonly triggerMessageId: string;
				readonly triggerSeq: number;
		  }
		| undefined
	> {
		const closed = await this.closeActiveSegmentForSteer({
			conversationId: input.conversationId,
			...(input.currentRounds === undefined ? {} : { currentRounds: input.currentRounds }),
			...(input.runId === undefined ? {} : { runId: input.runId }),
		});
		if (closed === undefined) return undefined;
		const triggerSeq = await this.allocateSeq(input.conversationId);
		const triggerMessageId = await input.persistTrigger({
			runId: closed.runId,
			segmentIndex: closed.segmentIndex + 1,
			seq: triggerSeq,
		});
		const segment = await this.openSegment({
			conversationId: input.conversationId,
			runId: closed.runId,
			triggerKind: "steer",
			triggerMessageId,
		});
		return {
			closedSegment: closed,
			runId: closed.runId,
			segment,
			triggerMessageId,
			triggerSeq,
		};
	}

	async syncSegmentRounds(segmentId: string, rounds: readonly RunRound[]): Promise<void> {
		await this.#db()
			.update(conversationRunSegments)
			.set({ roundsJson: JSON.stringify(rounds), updatedAt: this.#iso() })
			.where(eq(conversationRunSegments.id, segmentId));
	}

	/**
	 * Freeze the active run before an interrupting user message is persisted.
	 *
	 * The run and its segment keep the `seq` they already had; the interruption message is
	 * allocated afterwards, so the transcript can never show it before the work it interrupted.
	 */
	async interruptActiveRun(
		conversationId: string,
		currentRounds?: readonly RunRound[],
	): Promise<RunSegmentSummary | undefined> {
		const database = this.#db();
		const run = await this.activeRun(conversationId);
		if (run === undefined) return undefined;
		const segment =
			(await this.getLatestSegmentForRun(run.id, "running")) ??
			(await this.getLatestSegmentForRun(run.id));
		if (segment === undefined) return undefined;
		const endedAt = this.#iso();
		const roundsJson =
			currentRounds === undefined ? segment.roundsJson : JSON.stringify(currentRounds);
		await database
			.update(conversationRunSegments)
			.set({
				durationMs: durationMs(segment.startedAt, endedAt),
				endedAt,
				roundsJson,
				status: "interrupted",
				updatedAt: endedAt,
			})
			.where(eq(conversationRunSegments.id, segment.id));
		await database
			.update(conversationRuns)
			.set({
				durationMs: durationMs(run.startedAt, endedAt),
				endedAt,
				status: "interrupted",
				updatedAt: endedAt,
			})
			.where(eq(conversationRuns.id, run.id));
		const [updated] = await database
			.select()
			.from(conversationRunSegments)
			.where(eq(conversationRunSegments.id, segment.id))
			.limit(1);
		return updated === undefined ? undefined : toSegmentSummary(updated);
	}

	/**
	 * Settle a segment and its run once the answer (or its suppression) is durable.
	 */
	async settleRun(input: SettleConversationRunInput): Promise<RunSegmentSummary | undefined> {
		const database = this.#db();
		const run =
			input.runId === undefined
				? ((await this.activeRun(input.conversationId)) ??
					(await this.getLatestRun(input.conversationId)))
				: await this.getRun(input.runId);
		if (run === undefined) return undefined;
		const segment =
			input.segmentId === undefined
				? ((await this.getLatestSegmentForRun(run.id, "running")) ??
					(await this.getLatestSegmentForRun(run.id)))
				: (
						await database
							.select()
							.from(conversationRunSegments)
							.where(eq(conversationRunSegments.id, input.segmentId))
							.limit(1)
					)[0];
		if (segment === undefined) return undefined;
		const endedAt = this.#iso();
		await database
			.update(conversationRunSegments)
			.set({
				durationMs: durationMs(segment.startedAt, endedAt),
				endedAt,
				...(input.failureDetail === undefined ? {} : { failureDetail: input.failureDetail }),
				...(input.finalMessageId === undefined ? {} : { finalMessageId: input.finalMessageId }),
				...(input.rounds === undefined ? {} : { roundsJson: JSON.stringify(input.rounds) }),
				status: input.status,
				updatedAt: endedAt,
			})
			.where(eq(conversationRunSegments.id, segment.id));
		await database
			.update(conversationRuns)
			.set({
				durationMs: durationMs(run.startedAt, endedAt),
				endedAt,
				...(input.failureDetail === undefined ? {} : { failureDetail: input.failureDetail }),
				status: input.status,
				updatedAt: endedAt,
			})
			.where(eq(conversationRuns.id, run.id));
		const [updated] = await database
			.select()
			.from(conversationRunSegments)
			.where(eq(conversationRunSegments.id, segment.id))
			.limit(1);
		return updated === undefined ? undefined : toSegmentSummary(updated);
	}

	async getLatestRun(conversationId: string): Promise<RunRow | undefined> {
		const [run] = await this.#db()
			.select()
			.from(conversationRuns)
			.where(eq(conversationRuns.conversationId, conversationId))
			.orderBy(desc(conversationRuns.seq))
			.limit(1);
		return run;
	}

	/**
	 * Align live observation with a durable run. A live snapshot that names a different durable
	 * run key starts a new run; the same key continues its current segment.
	 */
	async ensureLiveRun(input: {
		readonly conversationId: string;
		readonly durableRunKey?: string | undefined;
		readonly triggerMessageId?: string | null | undefined;
	}): Promise<ConversationRunAnchor | undefined> {
		const active = await this.activeAnchor(input.conversationId);
		if (active !== undefined) {
			const run = await this.getRun(active.runId);
			if (run === undefined) return active;
			if (
				input.durableRunKey !== undefined &&
				run.durableRunKey !== null &&
				run.durableRunKey !== input.durableRunKey
			) {
				await this.interruptActiveRun(input.conversationId);
				return (
					await this.startRun({
						conversationId: input.conversationId,
						...(input.durableRunKey === undefined ? {} : { durableRunKey: input.durableRunKey }),
						...(input.triggerMessageId === undefined
							? {}
							: { triggerMessageId: input.triggerMessageId }),
					})
				).anchor;
			}
			if (run.durableRunKey === null && input.durableRunKey !== undefined) {
				await this.#db()
					.update(conversationRuns)
					.set({ durableRunKey: input.durableRunKey, updatedAt: this.#iso() })
					.where(eq(conversationRuns.id, run.id));
			}
			return active;
		}
		const latest = await this.getLatestRun(input.conversationId);
		if (
			latest !== undefined &&
			input.durableRunKey !== undefined &&
			latest.durableRunKey === input.durableRunKey
		) {
			const segment = await this.getLatestSegmentForRun(latest.id);
			if (segment !== undefined) return toAnchor(segment);
		}
		return (
			await this.startRun({
				conversationId: input.conversationId,
				...(input.durableRunKey === undefined ? {} : { durableRunKey: input.durableRunKey }),
				...(input.triggerMessageId === undefined
					? {}
					: { triggerMessageId: input.triggerMessageId }),
			})
		).anchor;
	}

	/** Existing anchor for a message row, or a fresh run when the conversation has none. */
	async anchorForMessage(input: {
		readonly conversationId: string;
		readonly createIfMissing?: boolean;
		readonly durableRunKey?: string | undefined;
		readonly triggerMessageId?: string | null | undefined;
	}): Promise<ConversationRunAnchor | undefined> {
		const active = await this.activeAnchor(input.conversationId);
		if (active !== undefined || input.createIfMissing !== true) return active;
		const latest = await this.getLatestRun(input.conversationId);
		if (
			latest !== undefined &&
			input.durableRunKey !== undefined &&
			latest.durableRunKey === input.durableRunKey
		) {
			const segment = await this.getLatestSegmentForRun(latest.id);
			if (segment !== undefined) return toAnchor(segment);
		}
		return (
			await this.startRun({
				conversationId: input.conversationId,
				...(input.durableRunKey === undefined ? {} : { durableRunKey: input.durableRunKey }),
				...(input.triggerMessageId === undefined
					? {}
					: { triggerMessageId: input.triggerMessageId }),
			})
		).anchor;
	}
}
