import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { pluginTasks, type TsukaimaDatabase } from "@tsukaima/db";
import { ConversationExecutionLock, withConversationLock } from "@tsukaima/core";
import {
	hasPermission,
	type PluginPermission,
	type PluginTask,
	type PluginTaskCancelQuery,
	type PluginTaskCreateInput,
	type PluginTaskExecutionResult,
	type PluginTaskHandler,
	type PluginTaskListQuery,
	type PluginTaskStatus,
	type PluginTaskUpdateInput,
	type PluginTaskWatchEvent,
	type PluginTasksApi,
} from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { HookBus } from "./hook-bus.ts";

type TaskRow = typeof pluginTasks.$inferSelect;

const DEFAULT_TASK_PERMISSIONS: readonly PluginPermission[] = [
	"tasks.create",
	"tasks.get",
	"tasks.list",
	"tasks.cancel",
	"tasks.watch",
];

export interface PluginTaskServiceOptions {
	readonly database: TsukaimaDatabase | (() => TsukaimaDatabase | undefined);
	readonly hooks?: HookBus;
	readonly logger?: Logger;
	readonly lock?: ConversationExecutionLock;
	readonly now?: () => number;
	readonly pollIntervalMs?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
	readonly tickLimit?: number;
}

function parseJson<T>(value: string | null, fallback: T): T {
	if (value === null) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function taskFromRow(row: TaskRow): PluginTask {
	return {
		attempts: row.attempts,
		createdAtMs: row.createdAtMs,
		id: row.id,
		kind: row.kind,
		logs: parseJson<string[]>(row.logsJson, []),
		maxAttempts: row.maxAttempts,
		nextRunAtMs: row.nextRunAtMs,
		payload: parseJson<unknown>(row.payloadJson, undefined),
		permissions: { permissions: parseJson<PluginPermission[]>(row.permissionsJson, []) },
		pluginId: row.pluginId,
		status: row.status,
		updatedAtMs: row.updatedAtMs,
		...(row.chatObjectId === null ? {} : { chatObjectId: row.chatObjectId }),
		...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
		...(row.dedupeKey === null ? {} : { dedupeKey: row.dedupeKey }),
		...(row.intervalMs === null ? {} : { intervalMs: row.intervalMs }),
		...(row.outcomeJson === null
			? {}
			: { outcome: parseJson<unknown>(row.outcomeJson, undefined) }),
	};
}

/**
 * One host scheduler owns every plugin delay/repeat. Tasks are durable rows; plugins never
 * start their own timers. Conversation-scoped handlers share the host execution lock.
 */
export class PluginTaskService {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #hooks: HookBus | undefined;
	readonly #logger: Logger | undefined;
	readonly #lock: ConversationExecutionLock;
	readonly #now: () => number;
	readonly #pollIntervalMs: number;
	readonly #retryBaseMs: number;
	readonly #retryMaxMs: number;
	readonly #tickLimit: number;
	readonly #handlers = new Map<string, PluginTaskHandler>();
	readonly #listeners = new Map<string, Set<(event: PluginTaskWatchEvent) => void>>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#ticking = false;

	constructor(options: PluginTaskServiceOptions) {
		this.#database =
			typeof options.database === "function"
				? options.database
				: () => options.database as TsukaimaDatabase;
		this.#hooks = options.hooks;
		this.#logger = options.logger;
		this.#lock = options.lock ?? new ConversationExecutionLock();
		this.#now = options.now ?? Date.now;
		this.#pollIntervalMs = options.pollIntervalMs ?? 250;
		this.#retryBaseMs = options.retryBaseMs ?? 1_000;
		this.#retryMaxMs = options.retryMaxMs ?? 60_000;
		this.#tickLimit = options.tickLimit ?? 20;
	}

	start(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => {
			void this.tick().catch((error) => {
				this.#logger?.warn("plugin task scheduler tick failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, this.#pollIntervalMs);
		this.#timer.unref?.();
	}

	stop(): void {
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#listeners.clear();
	}

	registerHandler(pluginId: string, kind: string, handler: PluginTaskHandler): () => void {
		const key = `${pluginId}:${kind}`;
		this.#handlers.set(key, handler);
		return () => {
			if (this.#handlers.get(key) === handler) this.#handlers.delete(key);
		};
	}

	apiFor(pluginId: string, grantedPermissions: readonly PluginPermission[]): PluginTasksApi {
		return {
			cancel: async (taskId) => await this.cancel(pluginId, taskId, grantedPermissions),
			cancelMany: async (query) => await this.cancelMany(pluginId, query, grantedPermissions),
			create: async (input) => await this.create(pluginId, input, grantedPermissions),
			get: async (taskId) => await this.get(pluginId, taskId, grantedPermissions),
			list: async (query) => await this.list(pluginId, query, grantedPermissions),
			registerHandler: (kind, handler) => this.registerHandler(pluginId, kind, handler),
			update: async (taskId, input) =>
				await this.update(pluginId, taskId, input, grantedPermissions),
			watch: (taskId, listener) => this.watch(pluginId, taskId, listener, grantedPermissions),
		};
	}

	async create(
		pluginId: string,
		input: PluginTaskCreateInput,
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): Promise<PluginTask> {
		this.#assert(grantedPermissions, "tasks.create", pluginId);
		const database = this.#requireDatabase();
		if (input.dedupeKey !== undefined) {
			const [existing] = await database
				.select()
				.from(pluginTasks)
				.where(
					and(
						eq(pluginTasks.pluginId, pluginId),
						eq(pluginTasks.dedupeKey, input.dedupeKey),
						inArray(pluginTasks.status, ["pending", "running"]),
					),
				)
				.limit(1);
			if (existing !== undefined) return taskFromRow(existing);
		}
		const permissions = this.#narrowPermissions(pluginId, grantedPermissions, input.permissions);
		const now = this.#now();
		const [row] = await database
			.insert(pluginTasks)
			.values({
				attempts: 0,
				createdAtMs: now,
				id: randomUUID(),
				kind: input.kind,
				logsJson: "[]",
				maxAttempts: Math.max(1, input.maxAttempts ?? 3),
				nextRunAtMs: input.nextRunAtMs ?? now,
				payloadJson: JSON.stringify(input.payload ?? null),
				permissionsJson: JSON.stringify(permissions),
				pluginId,
				status: "pending",
				updatedAtMs: now,
				...(input.chatObjectId === undefined ? {} : { chatObjectId: input.chatObjectId }),
				...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
				...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
				...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
			})
			.returning();
		if (row === undefined) throw new Error("Task insert did not return a row");
		const task = taskFromRow(row);
		this.#logger?.debug("plugin task created", {
			conversationId: task.conversationId,
			dedupeKey: task.dedupeKey,
			kind: task.kind,
			pluginId,
			taskId: task.id,
		});
		await this.#hooks?.emit("task.created", task);
		this.#emit(task.id, { task, type: "created" });
		return task;
	}

	async get(
		pluginId: string,
		taskId: string,
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): Promise<PluginTask | undefined> {
		this.#assert(grantedPermissions, "tasks.get", pluginId);
		const database = this.#requireDatabase();
		const [row] = await database
			.select()
			.from(pluginTasks)
			.where(and(eq(pluginTasks.id, taskId), eq(pluginTasks.pluginId, pluginId)))
			.limit(1);
		return row === undefined ? undefined : taskFromRow(row);
	}

	async list(
		pluginId: string,
		query: PluginTaskListQuery = {},
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): Promise<readonly PluginTask[]> {
		this.#assert(grantedPermissions, "tasks.list", pluginId);
		const database = this.#requireDatabase();
		const statuses =
			query.status === undefined
				? undefined
				: Array.isArray(query.status)
					? query.status
					: [query.status];
		const rows = await database
			.select()
			.from(pluginTasks)
			.where(
				and(
					eq(pluginTasks.pluginId, pluginId),
					...(statuses === undefined
						? []
						: [inArray(pluginTasks.status, statuses as PluginTaskStatus[])]),
					...(query.kind === undefined ? [] : [eq(pluginTasks.kind, query.kind)]),
					...(query.conversationId === undefined
						? []
						: [eq(pluginTasks.conversationId, query.conversationId)]),
				),
			)
			.orderBy(asc(pluginTasks.createdAtMs))
			.limit(Math.max(1, query.limit ?? 100));
		return rows.map(taskFromRow);
	}

	async cancel(
		pluginId: string,
		taskId: string,
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): Promise<PluginTask | undefined> {
		this.#assert(grantedPermissions, "tasks.cancel", pluginId);
		const database = this.#requireDatabase();
		const [row] = await database
			.update(pluginTasks)
			.set({ status: "cancelled", updatedAtMs: this.#now() })
			.where(and(eq(pluginTasks.id, taskId), eq(pluginTasks.pluginId, pluginId)))
			.returning();
		if (row === undefined) return undefined;
		const task = taskFromRow(row);
		this.#emit(task.id, { task, type: "cancelled" });
		await this.#hooks?.emit("task.completed", task);
		return task;
	}

	async update(
		pluginId: string,
		taskId: string,
		input: PluginTaskUpdateInput,
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): Promise<PluginTask | undefined> {
		this.#assert(grantedPermissions, "tasks.create", pluginId);
		const database = this.#requireDatabase();
		const [row] = await database
			.update(pluginTasks)
			.set({
				...(input.payload === undefined ? {} : { payloadJson: JSON.stringify(input.payload) }),
				...(input.nextRunAtMs === undefined ? {} : { nextRunAtMs: input.nextRunAtMs }),
				...(input.maxAttempts === undefined ? {} : { maxAttempts: Math.max(1, input.maxAttempts) }),
				...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
				updatedAtMs: this.#now(),
			})
			.where(and(eq(pluginTasks.id, taskId), eq(pluginTasks.pluginId, pluginId)))
			.returning();
		if (row === undefined) return undefined;
		const task = taskFromRow(row);
		this.#emit(task.id, { task, type: "updated" });
		return task;
	}

	async cancelMany(
		pluginId: string,
		query: PluginTaskCancelQuery,
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): Promise<readonly PluginTask[]> {
		this.#assert(grantedPermissions, "tasks.cancel", pluginId);
		const database = this.#requireDatabase();
		const statuses =
			query.status === undefined
				? undefined
				: Array.isArray(query.status)
					? query.status
					: [query.status];
		const rows = await database
			.select()
			.from(pluginTasks)
			.where(
				and(
					eq(pluginTasks.pluginId, pluginId),
					...(query.conversationId === undefined
						? []
						: [eq(pluginTasks.conversationId, query.conversationId)]),
					...(query.dedupeKey === undefined ? [] : [eq(pluginTasks.dedupeKey, query.dedupeKey)]),
					...(query.kind === undefined ? [] : [eq(pluginTasks.kind, query.kind)]),
					...(statuses === undefined
						? []
						: [inArray(pluginTasks.status, statuses as PluginTaskStatus[])]),
				),
			);
		const cancelled: PluginTask[] = [];
		for (const row of rows) {
			if (row.status === "cancelled" || row.status === "completed") continue;
			const task = await this.cancel(pluginId, row.id, grantedPermissions);
			if (task !== undefined) cancelled.push(task);
		}
		return cancelled;
	}

	watch(
		pluginId: string,
		taskId: string,
		listener: (event: PluginTaskWatchEvent) => void,
		grantedPermissions: readonly PluginPermission[] = DEFAULT_TASK_PERMISSIONS,
	): () => void {
		this.#assert(grantedPermissions, "tasks.watch", pluginId);
		const listeners = this.#listeners.get(taskId) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(taskId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#listeners.delete(taskId);
		};
	}

	/** Process one batch of due tasks. Exposed for deterministic tests and immediate startup. */
	async tick(): Promise<number> {
		if (this.#ticking) return 0;
		this.#ticking = true;
		const database = this.#database();
		if (database === undefined) {
			this.#ticking = false;
			return 0;
		}
		try {
			const now = this.#now();
			const due = await database
				.select()
				.from(pluginTasks)
				.where(and(eq(pluginTasks.status, "pending"), lte(pluginTasks.nextRunAtMs, now)))
				.orderBy(asc(pluginTasks.nextRunAtMs))
				.limit(this.#tickLimit);
			let processed = 0;
			for (const candidate of due) {
				const [claimed] = await database
					.update(pluginTasks)
					.set({ status: "running", updatedAtMs: now })
					.where(and(eq(pluginTasks.id, candidate.id), eq(pluginTasks.status, "pending")))
					.returning();
				if (claimed === undefined) continue;
				await this.#run(taskFromRow(claimed));
				processed += 1;
			}
			if (processed > 0) {
				this.#logger?.trace("plugin task tick processed", {
					dueCount: due.length,
					processed,
				});
			}
			return processed;
		} finally {
			this.#ticking = false;
		}
	}

	async #run(task: PluginTask): Promise<void> {
		const database = this.#requireDatabase();
		const handler = this.#handlers.get(`${task.pluginId}:${task.kind}`);
		const logs = [...task.logs, `${new Date().toISOString()} start ${task.kind}`];
		const startedAt = performance.now();
		this.#logger?.debug("plugin task started", {
			attempt: task.attempts + 1,
			conversationId: task.conversationId,
			kind: task.kind,
			pluginId: task.pluginId,
			taskId: task.id,
		});
		const execute = async (): Promise<PluginTaskExecutionResult> => {
			if (handler === undefined) return { outcome: { noHandler: true } };
			return (await handler(task)) ?? {};
		};
		try {
			const result =
				task.conversationId === undefined
					? await execute()
					: await withConversationLock(task.conversationId, execute, this.#lock);
			const now = this.#now();
			const nextLogs = [
				...logs,
				...(result.logs ?? []).map((entry) => `${new Date().toISOString()} ${entry}`),
			];
			const repeat = task.intervalMs !== undefined && task.intervalMs > 0 && result.stop !== true;
			const [row] = await database
				.update(pluginTasks)
				.set({
					attempts: repeat ? 0 : task.attempts,
					logsJson: JSON.stringify(nextLogs),
					nextRunAtMs: repeat ? now + task.intervalMs! : task.nextRunAtMs,
					outcomeJson: JSON.stringify(result.outcome ?? null),
					status: repeat ? "pending" : "completed",
					updatedAtMs: now,
				})
				.where(eq(pluginTasks.id, task.id))
				.returning();
			if (row === undefined) return;
			const next = taskFromRow(row);
			this.#logger?.debug("plugin task finished", {
				durationMs: Math.round(performance.now() - startedAt),
				kind: task.kind,
				pluginId: task.pluginId,
				repeat,
				status: next.status,
				taskId: task.id,
			});
			this.#emit(task.id, { task: next, type: repeat ? "updated" : "completed" });
			await this.#hooks?.emit("task.completed", next);
		} catch (error) {
			const now = this.#now();
			const message = error instanceof Error ? error.message : String(error);
			const attempts = task.attempts + 1;
			const failed = attempts >= task.maxAttempts;
			const delayMs = Math.min(
				this.#retryMaxMs,
				this.#retryBaseMs * 2 ** Math.max(0, attempts - 1),
			);
			const [row] = await database
				.update(pluginTasks)
				.set({
					attempts,
					logsJson: JSON.stringify([...logs, `${new Date().toISOString()} failed ${message}`]),
					nextRunAtMs: failed ? task.nextRunAtMs : now + delayMs,
					outcomeJson: JSON.stringify({ error: message }),
					status: failed ? "failed" : "pending",
					updatedAtMs: now,
				})
				.where(eq(pluginTasks.id, task.id))
				.returning();
			if (row === undefined) return;
			const next = taskFromRow(row);
			this.#logger?.warn("plugin task failed", {
				attempts,
				error: message,
				pluginId: task.pluginId,
				taskId: task.id,
			});
			this.#emit(task.id, { task: next, type: failed ? "completed" : "updated" });
			if (failed) await this.#hooks?.emit("task.completed", next);
		}
	}

	#assert(
		grantedPermissions: readonly PluginPermission[],
		required: PluginPermission,
		pluginId: string,
	): void {
		if (!hasPermission(grantedPermissions, required)) {
			throw new Error(`Plugin ${pluginId} is not granted permission ${required}`);
		}
	}

	#narrowPermissions(
		pluginId: string,
		granted: readonly PluginPermission[],
		requested: readonly PluginPermission[] | undefined,
	): readonly PluginPermission[] {
		if (requested === undefined) return [...granted];
		for (const permission of requested) {
			if (!hasPermission(granted, permission)) {
				throw new Error(`Plugin ${pluginId} cannot escalate task permission ${permission}`);
			}
		}
		return [...requested];
	}

	#emit(taskId: string, event: PluginTaskWatchEvent): void {
		for (const listener of this.#listeners.get(taskId) ?? []) {
			try {
				listener(event);
			} catch {}
		}
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}
