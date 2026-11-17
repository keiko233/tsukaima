import { and, asc, eq, lt } from "drizzle-orm";
import { replyDispatchExpectations, type TsukaimaDatabase } from "@tsukaima/db";

export type ReplyExpectationKind = "background" | "chat";

/**
 * A turn whose reply must reach a channel, persisted before the durable submission exists.
 *
 * The expectation is the only recovery trigger. A conversation with no pending expectation is
 * never replayed from transcript history, so suppressed, intermediate, and already-handled
 * assistant entries cannot be resent.
 */
export interface ReplyExpectation {
	readonly conversationId: string;
	readonly createdAtMs: number;
	readonly durableEntryId: string | null;
	readonly kind: ReplyExpectationKind;
	readonly lastDetail: string | null;
	/** Scheduler kind to use when this background answer defers itself. */
	readonly sourceFollowUpKind: string | null;
	/** Plugin that initiated the background turn, so recovery can hand the follow-up back. */
	readonly sourcePluginId: string | null;
	/** Scheduler task that initiated the background turn, when known. */
	readonly sourceTaskId: string | null;
	readonly state: "abandoned" | "pending" | "settled" | "suppressed";
	readonly submissionRequestId: string;
}

/** How long a pending expectation with no durable submission may exist before it is abandoned. */
const DEFAULT_EXPECTATION_TTL_MS = 15 * 60_000;

function toExpectation(row: typeof replyDispatchExpectations.$inferSelect): ReplyExpectation {
	return {
		conversationId: row.conversationId,
		createdAtMs: row.createdAtMs,
		durableEntryId: row.durableEntryId,
		kind: row.kind,
		lastDetail: row.lastDetail,
		sourceFollowUpKind: row.sourceFollowUpKind,
		sourcePluginId: row.sourcePluginId,
		sourceTaskId: row.sourceTaskId,
		state: row.state,
		submissionRequestId: row.submissionRequestId,
	};
}

/**
 * Durable store for reply expectations. The write happens before the durable submission commit,
 * which is what closes the crash window between "answer committed" and "observer claimed it".
 */
export class ReplyExpectationStore {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #now: () => number;
	readonly #ttlMs: number;

	constructor(options: {
		readonly database: () => TsukaimaDatabase | undefined;
		readonly now?: () => number;
		readonly ttlMs?: number;
	}) {
		this.#database = options.database;
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? DEFAULT_EXPECTATION_TTL_MS;
	}

	/**
	 * Record that a turn is about to be admitted and its reply is owed.
	 *
	 * Idempotent: a retried admission keeps the original row instead of creating a second one,
	 * so repeated startup or a duplicate append cannot double-dispatch.
	 */
	async expect(input: {
		readonly conversationId: string;
		readonly kind: ReplyExpectationKind;
		readonly sourceFollowUpKind?: string;
		readonly sourcePluginId?: string;
		readonly sourceTaskId?: string;
		readonly submissionRequestId: string;
	}): Promise<void> {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		const now = this.#now();
		await database
			.insert(replyDispatchExpectations)
			.values({
				conversationId: input.conversationId,
				createdAtMs: now,
				durableEntryId: null,
				kind: input.kind,
				lastDetail: null,
				sourceFollowUpKind: input.sourceFollowUpKind ?? null,
				sourcePluginId: input.sourcePluginId ?? null,
				sourceTaskId: input.sourceTaskId ?? null,
				state: "pending",
				submissionRequestId: input.submissionRequestId,
				updatedAtMs: now,
			})
			.onConflictDoNothing({
				target: [
					replyDispatchExpectations.conversationId,
					replyDispatchExpectations.submissionRequestId,
				],
			});
		// A prior attempt whose durable commit never landed may have been abandoned. This admission
		// is a fresh attempt at the same dedup key, so it is owed a reply again. A settled or
		// suppressed row stays terminal: a duplicate append never reaches here (the receipt dedups
		// first), and reviving one would risk a second send.
		await database
			.update(replyDispatchExpectations)
			// Refresh `createdAtMs` too: the abandonment TTL must measure this attempt, not the one
			// whose commit never landed, or a sweep could abandon the retry while it is in flight.
			.set({ createdAtMs: now, lastDetail: null, state: "pending", updatedAtMs: now })
			.where(
				and(
					eq(replyDispatchExpectations.conversationId, input.conversationId),
					eq(replyDispatchExpectations.submissionRequestId, input.submissionRequestId),
					eq(replyDispatchExpectations.state, "abandoned"),
				),
			);
	}

	/** Pending expectations for a conversation, oldest first, with no time or count window. */
	async pending(conversationId: string): Promise<readonly ReplyExpectation[]> {
		const database = this.#database();
		if (database === undefined) return [];
		const rows = await database
			.select()
			.from(replyDispatchExpectations)
			.where(
				and(
					eq(replyDispatchExpectations.conversationId, conversationId),
					eq(replyDispatchExpectations.state, "pending"),
				),
			)
			.orderBy(asc(replyDispatchExpectations.createdAtMs));
		return rows.map(toExpectation);
	}

	async get(
		conversationId: string,
		submissionRequestId: string,
	): Promise<ReplyExpectation | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const [row] = await database
			.select()
			.from(replyDispatchExpectations)
			.where(
				and(
					eq(replyDispatchExpectations.conversationId, conversationId),
					eq(replyDispatchExpectations.submissionRequestId, submissionRequestId),
				),
			)
			.limit(1);
		return row === undefined ? undefined : toExpectation(row);
	}

	/** Every conversation with unsettled work, so recovery is never limited to recent activity. */
	async pendingConversationIds(): Promise<readonly string[]> {
		const database = this.#database();
		if (database === undefined) return [];
		const rows = await database
			.selectDistinct({ conversationId: replyDispatchExpectations.conversationId })
			.from(replyDispatchExpectations)
			.where(eq(replyDispatchExpectations.state, "pending"));
		return rows.map((row) => row.conversationId);
	}

	/**
	 * Mark an expectation terminal. `settled` means the reply was dispatched (or proven already
	 * dispatched); `suppressed` means policy intentionally produced no reply.
	 */
	async settle(input: {
		readonly conversationId: string;
		readonly detail?: string;
		readonly durableEntryId?: string;
		readonly state: "abandoned" | "settled" | "suppressed";
		readonly submissionRequestId: string;
	}): Promise<void> {
		const database = this.#database();
		if (database === undefined) return;
		await database
			.update(replyDispatchExpectations)
			.set({
				...(input.detail === undefined ? {} : { lastDetail: input.detail }),
				...(input.durableEntryId === undefined ? {} : { durableEntryId: input.durableEntryId }),
				state: input.state,
				updatedAtMs: this.#now(),
			})
			.where(
				and(
					eq(replyDispatchExpectations.conversationId, input.conversationId),
					eq(replyDispatchExpectations.submissionRequestId, input.submissionRequestId),
					eq(replyDispatchExpectations.state, "pending"),
				),
			);
	}

	/** Attach the terminal answer entry once the durable submission settles. */
	async recordAnswer(input: {
		readonly conversationId: string;
		readonly durableEntryId: string;
		readonly submissionRequestId: string;
	}): Promise<void> {
		const database = this.#database();
		if (database === undefined) return;
		await database
			.update(replyDispatchExpectations)
			.set({ durableEntryId: input.durableEntryId, updatedAtMs: this.#now() })
			.where(
				and(
					eq(replyDispatchExpectations.conversationId, input.conversationId),
					eq(replyDispatchExpectations.submissionRequestId, input.submissionRequestId),
				),
			);
	}

	/**
	 * Abandon one expectation whose submission never appeared.
	 *
	 * The caller must have resolved the submission as missing. Only a row older than the TTL
	 * qualifies: the admission persists the expectation immediately before the durable commit, so
	 * a younger row may still be in flight. An abandoned row is never dispatched; it is kept as a
	 * record so a later audit can explain the missing reply.
	 */
	async abandonIfStale(input: {
		readonly conversationId: string;
		readonly olderThanMs?: number;
		readonly submissionRequestId: string;
	}): Promise<boolean> {
		const database = this.#database();
		if (database === undefined) return false;
		const cutoff = this.#now() - (input.olderThanMs ?? this.#ttlMs);
		const rows = await database
			.update(replyDispatchExpectations)
			.set({
				lastDetail: "submission never appeared",
				state: "abandoned",
				updatedAtMs: this.#now(),
			})
			.where(
				and(
					eq(replyDispatchExpectations.conversationId, input.conversationId),
					eq(replyDispatchExpectations.submissionRequestId, input.submissionRequestId),
					eq(replyDispatchExpectations.state, "pending"),
					lt(replyDispatchExpectations.createdAtMs, cutoff),
				),
			)
			.returning({ id: replyDispatchExpectations.submissionRequestId });
		return rows.length > 0;
	}
}
