import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { runtimeRestarts, type TsukaimaDatabase } from "@tsukaima/db";
import type { RestartMode, RestartStatus } from "@tsukaima/contracts";
import type { ReloadContext, ReloadController, ReloadResult } from "@tsukaima/coding";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { PromptHookService } from "./prompt-hooks.ts";

const DEFAULT_DELAY_MS = 60_000;

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
}

type RestartRow = typeof runtimeRestarts.$inferSelect;

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: {};
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
	#handler: ((intent: RestartIntent) => Promise<void> | void) | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: RestartCoordinatorOptions) {
		this.#audit = options.audit;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("tsukaima::server::restart");
		this.#now = options.now ?? Date.now;
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
	 * Resolve boot-time orphan intents. A row still `scheduled` means the process died before
	 * its deadline, so executing it now would create an unexpected restart loop. A row
	 * `executing` means the supervisor brought us back; it has completed.
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
				this.#logger.info("supervised restart recovered", { restartId: row.id });
				continue;
			}
			await database
				.update(runtimeRestarts)
				.set({
					completedAtMs: now,
					metadataJson: JSON.stringify({
						...parseMetadata(row.metadataJson),
						recovery: "scheduled intent was interrupted before its deadline",
					}),
					status: "failed",
					updatedAtMs: now,
				})
				.where(eq(runtimeRestarts.id, row.id));
			await this.#hooks.cancelByDedupeKey(
				`runtime-restart:${row.id}`,
				"restart intent was interrupted",
			);
			this.#logger.warn("scheduled restart was interrupted", { restartId: row.id });
		}
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
		const now = this.#now();
		const updated = await database
			.update(runtimeRestarts)
			.set({ status: "executing", updatedAtMs: now })
			.where(and(eq(runtimeRestarts.id, id), eq(runtimeRestarts.status, "scheduled")))
			.returning({ id: runtimeRestarts.id });
		if (updated.length === 0) return;
		const intent = toIntent({ ...row, status: "executing", updatedAtMs: now });
		if (this.#handler === undefined) {
			await this.#markFailed(id, "restart handler is not configured");
			return;
		}
		try {
			this.#logger.info("runtime restart executing", {
				mode: intent.mode,
				reason: intent.reason,
				restartId: id,
			});
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
		await this.#db()
			.update(runtimeRestarts)
			.set({ completedAtMs: now, status: "failed", updatedAtMs: now })
			.where(eq(runtimeRestarts.id, id));
		await this.#hooks.cancelByDedupeKey(`runtime-restart:${id}`, reason);
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
 * Reload adapter for the governed self-iteration deployment flow. A reload request becomes a
 * durable countdown instead of an immediate process kill, so chats can finish or reserve work.
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
				proposalId: context.proposalId ?? null,
				componentId,
			},
			mode: "update",
			reason: context.reason,
			requestedBy: "self-iteration",
		});
		return {
			message: `Update approved; restart scheduled for ${status.executeAt}`,
			reloadedAtMs: Date.now(),
			success: true,
		};
	}
}
