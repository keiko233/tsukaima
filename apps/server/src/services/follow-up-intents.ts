import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { pluginFollowUpIntents, type TsukaimaDatabase } from "@tsukaima/db";
import type {
	PluginFollowUpIntent,
	PluginFollowUpListQuery,
	PluginFollowUpsApi,
} from "@tsukaima/sdk";

function fromRow(row: typeof pluginFollowUpIntents.$inferSelect): PluginFollowUpIntent {
	return {
		conversationId: row.conversationId,
		createdAtMs: row.createdAtMs,
		delayMs: row.delayMs,
		followUpKind: row.followUpKind,
		id: row.id,
		pluginId: row.pluginId,
		scheduledForMs: row.scheduledForMs,
		sourceTaskId: row.sourceTaskId,
		status: row.status,
		submissionRequestId: row.submissionRequestId,
		updatedAtMs: row.updatedAtMs,
	};
}

/**
 * Durable outbox between a background turn and the plugin that owns its follow-up schedule.
 *
 * A schedule-later marker is only an intention. The host records that intention here before it
 * settles the turn's reply expectation; the plugin then creates its own task and marks the row
 * completed. A crash at any point leaves a pending row that the plugin replays idempotently.
 */
export class FollowUpIntentStore {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #listeners = new Map<string, Set<() => void>>();
	readonly #now: () => number;

	constructor(options: {
		readonly database: () => TsukaimaDatabase | undefined;
		readonly now?: () => number;
	}) {
		this.#database = options.database;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Persist one follow-up request. The unique `(pluginId, submissionRequestId)` key makes a
	 * retried admission or a recovery sweep keep the original request instead of creating a
	 * second follow-up.
	 */
	async record(input: {
		readonly conversationId: string;
		readonly delayMs: number;
		readonly followUpKind: string;
		readonly pluginId: string;
		readonly sourceTaskId?: string;
		readonly submissionRequestId: string;
	}): Promise<PluginFollowUpIntent> {
		const database = this.#requireDatabase();
		const now = this.#now();
		const existing = await database
			.select()
			.from(pluginFollowUpIntents)
			.where(
				and(
					eq(pluginFollowUpIntents.pluginId, input.pluginId),
					eq(pluginFollowUpIntents.submissionRequestId, input.submissionRequestId),
				),
			)
			.limit(1);
		if (existing[0] !== undefined) return fromRow(existing[0]);
		const id = randomUUID();
		const [row] = await database
			.insert(pluginFollowUpIntents)
			.values({
				conversationId: input.conversationId,
				createdAtMs: now,
				delayMs: input.delayMs,
				followUpKind: input.followUpKind,
				id,
				pluginId: input.pluginId,
				scheduledForMs: now + input.delayMs,
				sourceTaskId: input.sourceTaskId ?? null,
				status: "pending",
				submissionRequestId: input.submissionRequestId,
				updatedAtMs: now,
			})
			.onConflictDoNothing({
				target: [pluginFollowUpIntents.pluginId, pluginFollowUpIntents.submissionRequestId],
			})
			.returning();
		if (row !== undefined) {
			this.#notify(input.pluginId);
			return fromRow(row);
		}
		const [raced] = await database
			.select()
			.from(pluginFollowUpIntents)
			.where(
				and(
					eq(pluginFollowUpIntents.pluginId, input.pluginId),
					eq(pluginFollowUpIntents.submissionRequestId, input.submissionRequestId),
				),
			)
			.limit(1);
		if (raced === undefined) throw new Error("Follow-up intent could not be persisted");
		return fromRow(raced);
	}

	/** Plugin-scoped API. Every query includes the owner id; no plugin can read another's rows. */
	forPlugin(pluginId: string): PluginFollowUpsApi {
		return {
			complete: async (followUpId) => {
				const database = this.#requireDatabase();
				const rows = await database
					.update(pluginFollowUpIntents)
					.set({ status: "completed", updatedAtMs: this.#now() })
					.where(
						and(
							eq(pluginFollowUpIntents.id, followUpId),
							eq(pluginFollowUpIntents.pluginId, pluginId),
						),
					)
					.returning({ id: pluginFollowUpIntents.id });
				return rows.length > 0;
			},
			list: async (query: PluginFollowUpListQuery = {}) => {
				const database = this.#requireDatabase();
				const rows = await database
					.select()
					.from(pluginFollowUpIntents)
					.where(
						and(
							eq(pluginFollowUpIntents.pluginId, pluginId),
							...(query.conversationId === undefined
								? []
								: [eq(pluginFollowUpIntents.conversationId, query.conversationId)]),
							...(query.status === undefined
								? []
								: [eq(pluginFollowUpIntents.status, query.status)]),
							...(query.submissionRequestId === undefined
								? []
								: [eq(pluginFollowUpIntents.submissionRequestId, query.submissionRequestId)]),
						),
					)
					.orderBy(asc(pluginFollowUpIntents.createdAtMs))
					.limit(Math.max(1, query.limit ?? 100));
				return rows.map(fromRow);
			},
			onChanged: (handler) => {
				const listeners = this.#listeners.get(pluginId) ?? new Set<() => void>();
				listeners.add(handler);
				this.#listeners.set(pluginId, listeners);
				return () => {
					listeners.delete(handler);
					if (listeners.size === 0) this.#listeners.delete(pluginId);
				};
			},
		};
	}

	#notify(pluginId: string): void {
		for (const listener of this.#listeners.get(pluginId) ?? []) {
			try {
				listener();
			} catch {}
		}
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}
