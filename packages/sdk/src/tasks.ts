import { randomUUID } from "node:crypto";
import { assertPermission, hasPermission, type PluginPermission } from "./permissions.ts";
import type {
	PluginTask,
	PluginTaskCreateInput,
	PluginTaskListQuery,
	PluginTaskPermissions,
	PluginTaskStatus,
	PluginTaskWatchEvent,
	PluginTasksApi,
} from "./types.ts";

export const PLUGIN_TASK_STATUSES: readonly PluginTaskStatus[] = [
	"pending",
	"running",
	"completed",
	"failed",
	"cancelled",
];

function statusFilter(query: PluginTaskListQuery): ReadonlySet<PluginTaskStatus> | undefined {
	if (query.status === undefined) return undefined;
	return new Set(Array.isArray(query.status) ? query.status : [query.status]);
}

function assertKnownTask(
	pluginId: string,
	taskId: string,
	task: PluginTask | undefined,
): PluginTask {
	if (task === undefined || task.pluginId !== pluginId) {
		throw new Error(`Unknown task ${taskId}`);
	}
	return task;
}

export interface LocalTaskBridgeOptions {
	readonly pluginId: string;
	readonly grantedPermissions: readonly PluginPermission[];
	readonly now?: () => number;
}

/**
 * In-process task surface used by unit tests and host-less embeds. The server uses
 * `PluginTaskService` for durable scheduling; both implement the same SDK contract.
 */
export class LocalTaskBridge implements PluginTasksApi {
	readonly #pluginId: string;
	readonly #grantedPermissions: readonly PluginPermission[];
	readonly #tasks = new Map<string, PluginTask>();
	readonly #listeners = new Map<string, Set<(event: PluginTaskWatchEvent) => void>>();
	readonly #now: () => number;

	constructor(options: LocalTaskBridgeOptions) {
		this.#pluginId = options.pluginId;
		this.#grantedPermissions = options.grantedPermissions;
		this.#now = options.now ?? Date.now;
	}

	async create(input: PluginTaskCreateInput): Promise<PluginTask> {
		assertPermission(this.#grantedPermissions, "tasks.create", this.#pluginId);
		if (input.dedupeKey !== undefined) {
			const existing = [...this.#tasks.values()].find(
				(task) => task.dedupeKey === input.dedupeKey && task.pluginId === this.#pluginId,
			);
			if (existing !== undefined) return existing;
		}
		const now = this.#now();
		const permissions = this.#taskPermissions(input.permissions);
		const task: PluginTask = {
			attempts: 0,
			createdAtMs: now,
			id: randomUUID(),
			kind: input.kind,
			logs: [],
			maxAttempts: Math.max(1, input.maxAttempts ?? 3),
			nextRunAtMs: input.nextRunAtMs ?? now,
			payload: input.payload,
			permissions,
			pluginId: this.#pluginId,
			status: "pending",
			updatedAtMs: now,
			...(input.chatObjectId === undefined ? {} : { chatObjectId: input.chatObjectId }),
			...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
			...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
			...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
		};
		this.#tasks.set(task.id, task);
		this.#emit({ task, type: "created" });
		return task;
	}

	async get(taskId: string): Promise<PluginTask | undefined> {
		assertPermission(this.#grantedPermissions, "tasks.get", this.#pluginId);
		const task = this.#tasks.get(taskId);
		return task?.pluginId === this.#pluginId ? task : undefined;
	}

	async list(query: PluginTaskListQuery = {}): Promise<readonly PluginTask[]> {
		assertPermission(this.#grantedPermissions, "tasks.list", this.#pluginId);
		const statuses = statusFilter(query);
		return [...this.#tasks.values()]
			.filter((task) => task.pluginId === this.#pluginId)
			.filter((task) => statuses === undefined || statuses.has(task.status))
			.filter((task) => query.kind === undefined || task.kind === query.kind)
			.filter(
				(task) =>
					query.conversationId === undefined || task.conversationId === query.conversationId,
			)
			.slice(0, Math.max(1, query.limit ?? 100));
	}

	async cancel(taskId: string): Promise<PluginTask | undefined> {
		assertPermission(this.#grantedPermissions, "tasks.cancel", this.#pluginId);
		const existing = this.#tasks.get(taskId);
		if (existing === undefined || existing.pluginId !== this.#pluginId) return undefined;
		const task: PluginTask = {
			...existing,
			status: "cancelled",
			updatedAtMs: this.#now(),
		};
		this.#tasks.set(task.id, task);
		this.#emit({ task, type: "cancelled" });
		return task;
	}

	watch(taskId: string, listener: (event: PluginTaskWatchEvent) => void): () => void {
		assertPermission(this.#grantedPermissions, "tasks.watch", this.#pluginId);
		const listeners = this.#listeners.get(taskId) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(taskId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#listeners.delete(taskId);
		};
	}

	#taskPermissions(requested: readonly PluginPermission[] | undefined): PluginTaskPermissions {
		const permissions = requested ?? this.#grantedPermissions;
		for (const permission of permissions) {
			if (!hasPermission(this.#grantedPermissions, permission)) {
				throw new Error(`Task permission ${permission} is not granted to plugin ${this.#pluginId}`);
			}
		}
		return { permissions: [...permissions] };
	}

	#emit(event: PluginTaskWatchEvent): void {
		for (const listener of this.#listeners.get(event.task.id) ?? []) {
			try {
				listener(event);
			} catch {}
		}
	}
}

export function taskOwnedBy(task: PluginTask | undefined, pluginId: string): task is PluginTask {
	return task !== undefined && task.pluginId === pluginId;
}

export { assertKnownTask };
