import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { promptHooks, type TsukaimaDatabase } from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import { isRecord } from "../records.ts";

export type PromptHookKind = "context" | "resume" | "runtime";

export interface PromptHook {
	readonly afterRestart: boolean;
	readonly createdAtMs: number;
	readonly createdBy: string;
	readonly dedupeKey: string | null;
	readonly deliverAtMs: number | null;
	readonly expiresAtMs: number | null;
	readonly id: string;
	readonly kind: PromptHookKind;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly prompt: string;
	readonly sourceSessionId: string | null;
	readonly startsAtMs: number;
	readonly status: PromptHookRecordStatus;
	readonly targetSessionId: string | null;
}

export type PromptHookRecordStatus =
	| "pending"
	| "scheduled"
	| "running"
	| "fired"
	| "cancelled"
	| "failed";

export interface AddPromptHookInput {
	readonly afterRestart?: boolean;
	readonly createdBy: string;
	readonly dedupeKey?: string;
	readonly deliverAtMs?: number;
	readonly expiresAtMs?: number;
	readonly kind: PromptHookKind;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly prompt: string;
	readonly sourceSessionId?: string;
	readonly startsAtMs?: number;
	readonly status?: PromptHookRecordStatus;
	readonly targetSessionId?: string;
}

export interface PromptHookServiceOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	readonly now?: () => number;
}

type HookRow = typeof promptHooks.$inferSelect;

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function toHook(row: HookRow): PromptHook {
	return {
		afterRestart: row.afterRestart,
		createdAtMs: row.createdAtMs,
		createdBy: row.createdBy,
		dedupeKey: row.dedupeKey,
		deliverAtMs: row.deliverAtMs,
		expiresAtMs: row.expiresAtMs,
		id: row.id,
		kind: row.kind,
		metadata: parseMetadata(row.metadataJson),
		prompt: row.prompt,
		sourceSessionId: row.sourceSessionId,
		startsAtMs: row.startsAtMs,
		status: row.status,
		targetSessionId: row.targetSessionId,
	};
}

function restartCountdownText(hook: PromptHook, nowMs: number): string | undefined {
	const executeAtMs =
		typeof hook.metadata.executeAtMs === "number" ? hook.metadata.executeAtMs : undefined;
	if (executeAtMs === undefined) return undefined;
	const remainingMs = Math.max(0, executeAtMs - nowMs);
	const remaining =
		remainingMs >= 60_000
			? `${Math.ceil(remainingMs / 60_000)} minute(s)`
			: `${Math.max(1, Math.ceil(remainingMs / 1_000))} second(s)`;
	const action =
		hook.metadata.mode === "update"
			? "restart and update"
			: hook.metadata.mode === "restart"
				? "restart"
				: "perform maintenance";
	return [
		`[System notice] Tsukaima will ${action} at ${new Date(executeAtMs).toISOString()} (in ${remaining}).`,
		"If the current request cannot finish before then, tell the user you will come back and schedule a resume hook.",
		"Do not claim that in-flight work continues across the restart.",
	].join(" ");
}

/**
 * Durable prompt-hook registry.
 *
 * Hooks compose prompt context without adding a second conversation store. Context hooks are
 * consumed exactly once, runtime hooks render until their deadline, and resume hooks become
 * ordinary durable turns when their trigger (time or process boot) fires.
 */
export class PromptHookService {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: PromptHookServiceOptions) {
		this.#database = options.database;
		this.#logger = options.logger.child("tsukaima::server::prompt-hooks");
		this.#now = options.now ?? Date.now;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async add(input: AddPromptHookInput): Promise<PromptHook> {
		const database = this.#db();
		const now = this.#now();
		const id = randomUUID();
		const status = input.status ?? (input.kind === "resume" ? "scheduled" : "pending");
		await database.insert(promptHooks).values({
			afterRestart: input.afterRestart === true,
			createdAtMs: now,
			createdBy: input.createdBy,
			dedupeKey: input.dedupeKey ?? null,
			deliverAtMs: input.deliverAtMs ?? null,
			expiresAtMs: input.expiresAtMs ?? null,
			id,
			kind: input.kind,
			lastError: null,
			metadataJson: JSON.stringify(input.metadata ?? {}),
			prompt: input.prompt,
			sourceSessionId: input.sourceSessionId ?? null,
			startsAtMs: input.startsAtMs ?? now,
			status,
			targetSessionId: input.targetSessionId ?? null,
			updatedAtMs: now,
		});
		const [row] = await database.select().from(promptHooks).where(eq(promptHooks.id, id)).limit(1);
		if (row === undefined) throw new Error("Failed to persist prompt hook");
		this.#logger.debug("prompt hook created", {
			afterRestart: row.afterRestart,
			hookId: id,
			kind: row.kind,
			targetSessionId: row.targetSessionId,
		});
		return toHook(row);
	}

	async cancel(id: string, reason: string): Promise<boolean> {
		const database = this.#db();
		const now = this.#now();
		const rows = await database
			.select({ id: promptHooks.id })
			.from(promptHooks)
			.where(and(eq(promptHooks.id, id), sql`${promptHooks.status} IN ('pending', 'scheduled')`));
		if (rows.length === 0) return false;
		await database
			.update(promptHooks)
			.set({
				lastError: reason,
				status: "cancelled",
				updatedAtMs: now,
			})
			.where(eq(promptHooks.id, id));
		const timer = this.#timers.get(id);
		if (timer !== undefined) clearTimeout(timer);
		this.#timers.delete(id);
		return true;
	}

	async cancelByDedupeKey(dedupeKey: string, reason: string): Promise<boolean> {
		const database = this.#db();
		const [row] = await database
			.select({ id: promptHooks.id })
			.from(promptHooks)
			.where(eq(promptHooks.dedupeKey, dedupeKey))
			.limit(1);
		return row === undefined ? false : this.cancel(row.id, reason);
	}

	/**
	 * Atomically consume every context hook that applies to this session. A context hook with
	 * no target applies globally, but still fires only once.
	 */
	async consumeContext(sessionId: string): Promise<PromptHook[]> {
		const database = this.#db();
		const now = this.#now();
		const rows = await database
			.select()
			.from(promptHooks)
			.where(
				and(
					eq(promptHooks.kind, "context"),
					eq(promptHooks.status, "pending"),
					lte(promptHooks.startsAtMs, now),
					or(eq(promptHooks.targetSessionId, sessionId), isNull(promptHooks.targetSessionId)),
					or(isNull(promptHooks.expiresAtMs), sql`${promptHooks.expiresAtMs} > ${now}`),
				),
			)
			.orderBy(asc(promptHooks.createdAtMs));
		const consumed: PromptHook[] = [];
		for (const row of rows) {
			const updated = await database
				.update(promptHooks)
				.set({ status: "fired", updatedAtMs: now })
				.where(and(eq(promptHooks.id, row.id), eq(promptHooks.status, "pending")))
				.returning({ id: promptHooks.id });
			if (updated.length > 0) consumed.push(toHook(row));
		}
		return consumed;
	}

	async renderContext(sessionId: string): Promise<string | undefined> {
		const database = this.#db();
		const now = this.#now();
		const [consumed, runtimeRows] = await Promise.all([
			this.consumeContext(sessionId),
			database
				.select()
				.from(promptHooks)
				.where(
					and(
						eq(promptHooks.kind, "runtime"),
						eq(promptHooks.status, "pending"),
						lte(promptHooks.startsAtMs, now),
						or(eq(promptHooks.targetSessionId, sessionId), isNull(promptHooks.targetSessionId)),
						or(isNull(promptHooks.expiresAtMs), sql`${promptHooks.expiresAtMs} > ${now}`),
					),
				)
				.orderBy(asc(promptHooks.createdAtMs)),
		]);
		const text = [
			...consumed.map((hook) => hook.prompt),
			...runtimeRows.map((row) => {
				const hook = toHook(row);
				return restartCountdownText(hook, now) ?? hook.prompt;
			}),
		]
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
			.join("\n\n");
		return text.length === 0 ? undefined : text;
	}

	async list(
		input: {
			readonly includeFinished?: boolean;
			readonly sessionId?: string;
		} = {},
	): Promise<PromptHook[]> {
		const database = this.#db();
		const conditions = [];
		if (input.sessionId !== undefined) {
			conditions.push(
				or(
					eq(promptHooks.targetSessionId, input.sessionId),
					eq(promptHooks.sourceSessionId, input.sessionId),
				),
			);
		}
		if (input.includeFinished !== true) {
			conditions.push(sql`${promptHooks.status} IN ('pending', 'scheduled', 'running')`);
		}
		const where = conditions.length === 0 ? undefined : and(...conditions);
		const rows = await database.select().from(promptHooks).where(where);
		return rows.map(toHook);
	}

	/**
	 * Dispatch reserved work that became due while the process was down. Called after the
	 * lifecycle is ready so the resumed turn has a working model, tools, and reply path.
	 */
	async dispatchStartupResumes(dispatch: (hook: PromptHook) => Promise<void>): Promise<number> {
		const database = this.#db();
		const now = this.#now();
		const rows = await database
			.select()
			.from(promptHooks)
			.where(
				and(
					eq(promptHooks.kind, "resume"),
					eq(promptHooks.status, "scheduled"),
					or(eq(promptHooks.afterRestart, true), lte(promptHooks.deliverAtMs, now)),
				),
			)
			.orderBy(asc(promptHooks.createdAtMs));
		let dispatched = 0;
		for (const row of rows) {
			if (await this.#dispatchResume(toHook(row), dispatch)) dispatched += 1;
		}
		return dispatched;
	}

	/** Schedule future resume hooks and return the number of timers armed. */
	async resumeTimers(dispatch: (hook: PromptHook) => Promise<void>): Promise<number> {
		const database = this.#db();
		const now = this.#now();
		const rows = await database
			.select()
			.from(promptHooks)
			.where(
				and(
					eq(promptHooks.kind, "resume"),
					eq(promptHooks.status, "scheduled"),
					eq(promptHooks.afterRestart, false),
					isNotNull(promptHooks.deliverAtMs),
				),
			);
		let armed = 0;
		for (const row of rows) {
			if (row.deliverAtMs === null) continue;
			const hook = toHook(row);
			const delayMs = Math.max(0, row.deliverAtMs - now);
			const timer = setTimeout(() => {
				this.#timers.delete(hook.id);
				void this.#dispatchResume(hook, dispatch);
			}, delayMs);
			timer.unref?.();
			this.#timers.set(hook.id, timer);
			armed += 1;
		}
		return armed;
	}

	/** Arm a timer for a resume hook created after lifecycle startup. */
	armResume(hook: PromptHook, dispatch: (hook: PromptHook) => Promise<void>): void {
		if (hook.deliverAtMs === null || hook.afterRestart) return;
		const existing = this.#timers.get(hook.id);
		if (existing !== undefined) clearTimeout(existing);
		const timer = setTimeout(
			() => {
				this.#timers.delete(hook.id);
				void this.#dispatchResume(hook, dispatch);
			},
			Math.max(0, hook.deliverAtMs - this.#now()),
		);
		timer.unref?.();
		this.#timers.set(hook.id, timer);
	}

	async #dispatchResume(
		hook: PromptHook,
		dispatch: (hook: PromptHook) => Promise<void>,
	): Promise<boolean> {
		if (hook.targetSessionId === null) {
			await this.#fail(hook.id, "resume hook has no target session");
			return false;
		}
		const database = this.#db();
		const claimed = await database
			.update(promptHooks)
			.set({ status: "running", updatedAtMs: this.#now() })
			.where(and(eq(promptHooks.id, hook.id), eq(promptHooks.status, "scheduled")))
			.returning({ id: promptHooks.id });
		if (claimed.length === 0) return false;
		try {
			await dispatch(hook);
			await database
				.update(promptHooks)
				.set({ status: "fired", updatedAtMs: this.#now() })
				.where(eq(promptHooks.id, hook.id));
			this.#logger.info("reserved prompt hook dispatched", {
				hookId: hook.id,
				targetSessionId: hook.targetSessionId,
			});
			return true;
		} catch (error) {
			await this.#fail(hook.id, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	async #fail(id: string, reason: string): Promise<void> {
		this.#logger.warn("prompt hook failed", { error: reason, hookId: id });
		await this.#db()
			.update(promptHooks)
			.set({ lastError: reason, status: "failed", updatedAtMs: this.#now() })
			.where(eq(promptHooks.id, id));
	}

	close(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}
}
