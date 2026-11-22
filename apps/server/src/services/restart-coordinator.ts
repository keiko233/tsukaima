import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { promptHooks, runtimeRestarts, type TsukaimaDatabase } from "@tsukaima/db";
import type { RestartMode, RestartStatus } from "@tsukaima/contracts";
import type { ReloadContext, ReloadController, ReloadResult } from "@tsukaima/coding";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import { isRecord } from "../records.ts";
import type { PromptHookService } from "./prompt-hooks.ts";

const DEFAULT_DELAY_MS = 60_000;
/** How soon an intent is retried when the process has no restart handler yet. */
const REARM_WITHOUT_HANDLER_MS = 1_000;

export interface RestartIntent {
	readonly createdAtMs: number;
	readonly executeAtMs: number;
	readonly id: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly mode: RestartMode;
	readonly reason: string;
	readonly requestedBy: string;
}

export interface RestartCoordinatorOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly hooks: PromptHookService;
	readonly logger: Logger;
	readonly now?: () => number;
	/**
	 * Called once per intent with its terminal outcome:
	 * `completed` after a supervised restart resumed this process, `interrupted` when the
	 * process died before the deadline, `cancelled` for an explicit or superseded cancel.
	 */
	readonly onSettled?: (
		intent: RestartIntent,
		outcome: RestartSettlementOutcome,
	) => Promise<void> | void;
	/**
	 * Run before executing an update restart. If this throws, the restart is aborted,
	 * marked failed, and the handler is not called.
	 */
	readonly prepareUpdate?: ((intent: RestartIntent) => Promise<void>) | undefined;
}

type RestartRow = typeof runtimeRestarts.$inferSelect;

export type RestartSettlementOutcome = "cancelled" | "completed" | "interrupted";

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function toIntent(row: RestartRow): RestartIntent {
	return {
		createdAtMs: row.createdAtMs,
		executeAtMs: row.executeAtMs,
		id: row.id,
		metadata: parseMetadata(row.metadataJson),
		mode: row.mode,
		reason: row.reason,
		requestedBy: row.requestedBy,
	};
}

function toStatus(row: RestartRow): RestartStatus {
	return {
		createdAt: new Date(row.createdAtMs).toISOString(),
		executeAt: new Date(row.executeAtMs).toISOString(),
		id: row.id,
		mode: row.mode,
		reason: row.reason,
		requestedBy: row.requestedBy,
		status: row.status,
	};
}

/**
 * Owns a single Linux-shutdown-style maintenance window.
 *
 * Scheduling is durable and injects a global runtime hook, so every chat sees the countdown
 * before its next turn. Execution is delegated to the process supervisor through `handler`;
 * the coordinator never calls `process.exit()` itself, which keeps lifecycle tests deterministic.
 */
export class RestartCoordinator {
	readonly #audit: RestartCoordinatorOptions["audit"];
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #hooks: PromptHookService;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #onSettled: RestartCoordinatorOptions["onSettled"];
	readonly #prepareUpdate: ((intent: RestartIntent) => Promise<void>) | undefined;
	#handler: ((intent: RestartIntent) => Promise<void> | void) | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: RestartCoordinatorOptions) {
		this.#audit = options.audit;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("tsukaima::server::restart");
		this.#now = options.now ?? Date.now;
		this.#onSettled = options.onSettled;
		this.#prepareUpdate = options.prepareUpdate;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	setHandler(handler: (intent: RestartIntent) => Promise<void> | void): void {
		this.#handler = handler;
	}

	/**
	 * Resolve boot-time orphan intents and re-arm durable work.
	 *
	 * A row `executing` means the supervisor brought this process back: the intent completed. A
	 * row still `scheduled` is a restart that was persisted but never executed, either because
	 * the process died or because the deadline is still in the future. It is resumed rather than
	 * discarded: an overdue deadline executes now, a future one is re-armed, and its prompt hook
	 * is re-created if it was lost. `recover()` is therefore idempotent across repeated boots.
	 */
	async recover(): Promise<void> {
		const database = this.#db();
		const rows = await database
			.select()
			.from(runtimeRestarts)
			.where(sql`${runtimeRestarts.status} IN ('scheduled', 'executing')`);
		const now = this.#now();
		for (const row of rows) {
			if (row.status === "executing") {
				await database
					.update(runtimeRestarts)
					.set({ completedAtMs: now, status: "completed", updatedAtMs: now })
					.where(eq(runtimeRestarts.id, row.id));
				await this.#hooks.cancelByDedupeKey(`runtime-restart:${row.id}`, "restart completed");
				await this.#settle({ ...row, status: "completed", completedAtMs: now }, "completed");
				this.#logger.info("supervised restart recovered", { restartId: row.id });
				continue;
			}
			await this.#resumeScheduled(row, now);
		}
		await this.#replayTerminalSettlements();
	}

	/**
	 * Re-deliver settlement for intents that already reached a terminal status.
	 *
	 * The terminal write and the deployment settlement are separate durable operations. A crash
	 * between them would otherwise leave a deployment `scheduled` with no active intent to trigger
	 * reconciliation ever again. Replaying terminal outcomes is safe because
	 * `reconcileRestartDeployment` is a no-op once the deployment row is terminal; a
	 * `manual_apply_required` row may be re-checked, which is how a later boot with real evidence
	 * settles it.
	 */
	async #replayTerminalSettlements(): Promise<void> {
		if (this.#onSettled === undefined) return;
		const rows = await this.#db()
			.select()
			.from(runtimeRestarts)
			.where(
				and(
					sql`${runtimeRestarts.status} IN ('completed', 'cancelled', 'failed')`,
					sql`${runtimeRestarts.metadataJson} LIKE '%"deploymentId"%'`,
				),
			)
			.orderBy(desc(runtimeRestarts.updatedAtMs))
			.limit(200);
		for (const row of rows) {
			const outcome: RestartSettlementOutcome =
				row.status === "completed"
					? "completed"
					: row.status === "cancelled"
						? "cancelled"
						: "interrupted";
			await this.#settle(row, outcome);
		}
		if (rows.length > 0) {
			this.#logger.debug("restart settlement replay finished", { terminal: rows.length });
		}
	}

	/**
	 * Resume one durable scheduled intent. The hook is re-created through its dedupe key so a
	 * boot that already re-created it does not duplicate it, and the timer is armed for the
	 * remaining delay (immediately when the deadline has passed).
	 */
	async #resumeScheduled(row: RestartRow, now: number): Promise<void> {
		await this.#ensureHook(row, now);
		const overdue = row.executeAtMs <= now;
		this.#arm(row.id, overdue ? now : row.executeAtMs);
		this.#logger.info(overdue ? "overdue restart resumed" : "scheduled restart re-armed", {
			executeAtMs: row.executeAtMs,
			restartId: row.id,
		});
	}

	/** Recreate the countdown hook for an intent whose hook row was lost or cancelled. */
	async #ensureHook(row: RestartRow, now: number): Promise<void> {
		const dedupeKey = `runtime-restart:${row.id}`;
		const database = this.#db();
		const [existing] = await database
			.select({ id: promptHooks.id })
			.from(promptHooks)
			.where(eq(promptHooks.dedupeKey, dedupeKey))
			.limit(1);
		if (existing !== undefined) return;
		const metadata = parseMetadata(row.metadataJson);
		await this.#hooks.add({
			createdBy: row.requestedBy,
			dedupeKey,
			// A resumed countdown must render even when its deadline already passed: the original
			// hook expired at the deadline, so re-use a window from now instead.
			expiresAtMs: now + DEFAULT_DELAY_MS,
			kind: "runtime",
			metadata: { ...metadata, executeAtMs: row.executeAtMs, mode: row.mode, restartId: row.id },
			prompt: "Tsukaima is preparing for a scheduled restart.",
			status: "pending",
		});
	}

	/**
	 * Resolve the supervisor's `restart-intent.json` after recovery. A file whose intent is
	 * already terminal is consumed so a stale intent cannot describe the next boot; a file that
	 * names a still-active or unknown intent is left in place for the supervisor to inspect.
	 */
	async resumeIntentFile(path: string): Promise<"consumed" | "missing" | "unresolved"> {
		let raw: string;
		try {
			raw = await readFile(path, "utf-8");
		} catch {
			return "missing";
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.#logger.warn("restart intent file is not valid JSON", {
				error: error instanceof Error ? error.message : String(error),
				path,
			});
			return "unresolved";
		}
		const id =
			typeof parsed === "object" && parsed !== null && "id" in parsed
				? String((parsed as { id: unknown }).id)
				: undefined;
		if (id === undefined || id.length === 0) {
			this.#logger.warn("restart intent file has no intent id", { path });
			return "unresolved";
		}
		const row = await this.#row(id);
		if (row === undefined) {
			this.#logger.warn("restart intent file names an unknown intent", { restartId: id });
			return "unresolved";
		}
		if (row.status === "scheduled" || row.status === "executing") {
			this.#logger.warn("restart intent file is still active", {
				restartId: id,
				status: row.status,
			});
			return "unresolved";
		}
		await rm(path, { force: true });
		this.#logger.info("restart intent file consumed", { restartId: id, status: row.status });
		return "consumed";
	}

	async schedule(
		input: {
			readonly delayMs?: number;
			readonly metadata?: Readonly<Record<string, unknown>>;
			readonly mode?: RestartMode;
			readonly reason?: string;
			readonly requestedBy?: string;
		} = {},
	): Promise<RestartStatus> {
		const database = this.#db();
		const now = this.#now();
		const active = await this.#activeRow();
		if (active !== undefined) {
			await this.cancel("superseded by a newer restart request", active.id);
		}
		const id = randomUUID();
		const mode = input.mode ?? "restart";
		const reason =
			input.reason?.trim() || (mode === "update" ? "runtime update" : "runtime restart");
		const executeAtMs = now + Math.max(1, input.delayMs ?? DEFAULT_DELAY_MS);
		const metadata = input.metadata ?? {};
		await database.insert(runtimeRestarts).values({
			completedAtMs: null,
			createdAtMs: now,
			executeAtMs,
			id,
			metadataJson: JSON.stringify(metadata),
			mode,
			reason,
			requestedBy: input.requestedBy ?? "webui-admin",
			status: "scheduled",
			updatedAtMs: now,
		});
		await this.#hooks.add({
			createdBy: input.requestedBy ?? "webui-admin",
			dedupeKey: `runtime-restart:${id}`,
			expiresAtMs: executeAtMs,
			kind: "runtime",
			metadata: { executeAtMs, mode, reason, restartId: id },
			prompt: "Tsukaima is preparing for a scheduled restart.",
			status: "pending",
		});
		this.#arm(id, executeAtMs);
		await this.#audit?.({
			action: "runtime.restart.schedule",
			actorId: input.requestedBy ?? "webui-admin",
			actorKind: "user",
			payload: { delayMs: executeAtMs - now, mode, reason },
			result: "ok",
			targetId: id,
			targetKind: "runtime-restart",
		});
		this.#logger.info("runtime restart scheduled", {
			executeAt: new Date(executeAtMs).toISOString(),
			mode,
			reason,
			restartId: id,
		});
		const row = await this.#row(id);
		if (row === undefined) throw new Error("Failed to persist restart");
		return toStatus(row);
	}

	async cancel(reason = "cancelled by administrator", id?: string): Promise<boolean> {
		const database = this.#db();
		const row = id === undefined ? await this.#activeRow() : await this.#row(id);
		if (row === undefined || row.status !== "scheduled") return false;
		const now = this.#now();
		await database
			.update(runtimeRestarts)
			.set({ completedAtMs: now, status: "cancelled", updatedAtMs: now })
			.where(eq(runtimeRestarts.id, row.id));
		await this.#hooks.cancelByDedupeKey(`runtime-restart:${row.id}`, reason);
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#audit?.({
			action: "runtime.restart.cancel",
			actorKind: "user",
			payload: { reason },
			result: "ok",
			targetId: row.id,
			targetKind: "runtime-restart",
		});
		this.#logger.info("runtime restart cancelled", { reason, restartId: row.id });
		await this.#settle({ ...row, status: "cancelled", completedAtMs: now }, "cancelled");
		return true;
	}

	async status(): Promise<RestartStatus | null> {
		const database = this.#db();
		const [row] = await database
			.select()
			.from(runtimeRestarts)
			.orderBy(desc(runtimeRestarts.createdAtMs))
			.limit(1);
		return row === undefined ? null : toStatus(row);
	}

	#arm(id: string, executeAtMs: number): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		const delayMs = Math.max(0, executeAtMs - this.#now());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#execute(id);
		}, delayMs);
		this.#timer.unref?.();
	}

	async #execute(id: string): Promise<void> {
		const database = this.#db();
		const row = await this.#row(id);
		if (row === undefined || row.status !== "scheduled") return;
		if (this.#handler === undefined) {
			// Do not consume durable work because the process is not wired yet: leave the intent
			// scheduled and re-arm it, so a handler registered moments later still runs it.
			this.#logger.warn("restart handler is not configured; re-arming intent", {
				restartId: id,
			});
			this.#arm(id, this.#now() + REARM_WITHOUT_HANDLER_MS);
			return;
		}
		const now = this.#now();
		const updated = await database
			.update(runtimeRestarts)
			.set({ status: "executing", updatedAtMs: now })
			.where(and(eq(runtimeRestarts.id, id), eq(runtimeRestarts.status, "scheduled")))
			.returning({ id: runtimeRestarts.id });
		if (updated.length === 0) return;
		const intent = toIntent({ ...row, status: "executing", updatedAtMs: now });
		try {
			this.#logger.info("runtime restart executing", {
				mode: intent.mode,
				reason: intent.reason,
				restartId: id,
			});
			if (intent.mode === "update" && this.#prepareUpdate !== undefined) {
				this.#logger.info("installing dependencies before update restart", {
					restartId: id,
				});
				await this.#prepareUpdate(intent);
			}
			await this.#handler(intent);
			await this.#hooks.cancelByDedupeKey(`runtime-restart:${id}`, "restart executed");
			await database
				.update(runtimeRestarts)
				.set({ completedAtMs: this.#now(), status: "completed", updatedAtMs: this.#now() })
				.where(eq(runtimeRestarts.id, id));
		} catch (error) {
			await this.#markFailed(id, error instanceof Error ? error.message : String(error));
		}
	}

	async #markFailed(id: string, reason: string): Promise<void> {
		const now = this.#now();
		const row = await this.#row(id);
		const existingMeta = row === undefined ? {} : parseMetadata(row.metadataJson);
		const updatedMeta = JSON.stringify({ ...existingMeta, error: reason });
		await this.#db()
			.update(runtimeRestarts)
			.set({
				completedAtMs: now,
				metadataJson: updatedMeta,
				status: "failed",
				updatedAtMs: now,
			})
			.where(eq(runtimeRestarts.id, id));
		await this.#hooks.cancelByDedupeKey(`runtime-restart:${id}`, reason);
		if (row !== undefined) {
			await this.#settle(
				{ ...row, completedAtMs: now, metadataJson: updatedMeta, status: "failed" },
				"interrupted",
			);
		}
		this.#logger.error("runtime restart failed", { error: reason, restartId: id });
	}

	async #row(id: string): Promise<RestartRow | undefined> {
		const [row] = await this.#db()
			.select()
			.from(runtimeRestarts)
			.where(eq(runtimeRestarts.id, id))
			.limit(1);
		return row;
	}

	async #settle(intent: RestartRow, outcome: RestartSettlementOutcome): Promise<void> {
		if (this.#onSettled === undefined) return;
		try {
			await this.#onSettled(toIntent(intent), outcome);
		} catch (error) {
			this.#logger.warn("restart settlement callback failed", {
				error: error instanceof Error ? error.message : String(error),
				outcome,
				restartId: intent.id,
			});
		}
	}

	async #activeRow(): Promise<RestartRow | undefined> {
		const [row] = await this.#db()
			.select()
			.from(runtimeRestarts)
			.where(sql`${runtimeRestarts.status} IN ('scheduled', 'executing')`)
			.orderBy(desc(runtimeRestarts.createdAtMs))
			.limit(1);
		return row;
	}

	close(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * Reload adapter for the governed deployment flow. A reload request becomes a durable
 * countdown instead of an immediate process kill, so chats can finish or reserve work.
 */
export class RestartReloadController implements ReloadController {
	readonly #coordinator: RestartCoordinator;
	readonly #delayMs: number;

	constructor(coordinator: RestartCoordinator, delayMs = DEFAULT_DELAY_MS) {
		this.#coordinator = coordinator;
		this.#delayMs = delayMs;
	}

	async reload(componentId: string, context: ReloadContext): Promise<ReloadResult> {
		if (componentId !== "tsukaima") {
			return {
				message: `No process reload is required for "${componentId}"`,
				reloadedAtMs: Date.now(),
				success: true,
			};
		}
		const status = await this.#coordinator.schedule({
			delayMs: this.#delayMs,
			metadata: {
				deploymentId: context.deploymentId ?? null,
				proposalId: context.proposalId ?? null,
				componentId,
			},
			mode: "update",
			reason: context.reason,
			requestedBy: "deployment",
		});
		return {
			deferred: true,
			message: `Update approved; restart scheduled for ${status.executeAt}`,
			reloadedAtMs: Date.now(),
			success: true,
		};
	}
}
