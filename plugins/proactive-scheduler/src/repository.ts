import { randomUUID } from "node:crypto";
import type { PluginDatabaseApi } from "@tsukaima/sdk";
import {
	CONVERSATION_POLICY_SCOPE,
	type DecisionRecord,
	DEFAULT_PROACTIVE_POLICY,
	GLOBAL_POLICY_SCOPE,
	mergePolicy,
	PERSONA_POLICY_SCOPE,
	parseGates,
	parseRepeat,
	type ProactivePolicy,
	type ProactivePolicyPatch,
	type ProactiveState,
	proactivePolicySchema,
	repeatSchema,
	type ScheduledTask,
	type ScheduledTaskKind,
	type ScheduledTaskRepeat,
	type ScheduledTaskStatus,
	scheduledTaskKindSchema,
	scheduledTaskStatusSchema,
} from "./domain.ts";

type PolicyRow = {
	readonly allow_nudge: number;
	readonly allow_proactive: number;
	readonly allow_remind: number;
	readonly backoff_ms: number;
	readonly bubble_gate: number;
	readonly cooldown_ms: number;
	readonly daily_cap: number;
	readonly enabled: number;
	readonly hourly_cap: number;
	readonly id: string;
	readonly max_attempts: number;
	readonly max_delay_ms: number;
	readonly max_idle_ms: number;
	readonly max_pending_per_conversation: number;
	readonly min_idle_ms: number;
	readonly min_messages: number;
	readonly min_warmness: number;
	readonly probability: number;
	readonly quiet_hours_json: string;
	readonly scope: string;
	readonly scope_id: string;
	readonly updated_at_ms: number;
};

const POLICY_COLUMNS = [
	"enabled",
	"allow_remind",
	"allow_nudge",
	"allow_proactive",
	"quiet_hours_json",
	"daily_cap",
	"hourly_cap",
	"cooldown_ms",
	"backoff_ms",
	"min_messages",
	"min_idle_ms",
	"max_idle_ms",
	"min_warmness",
	"probability",
	"bubble_gate",
	"max_delay_ms",
	"max_pending_per_conversation",
	"max_attempts",
] as const;

function policyValues(policy: ProactivePolicy): unknown[] {
	return [
		policy.enabled ? 1 : 0,
		policy.allowRemind ? 1 : 0,
		policy.allowNudge ? 1 : 0,
		policy.allowProactive ? 1 : 0,
		JSON.stringify(policy.quietHours),
		policy.dailyCap,
		policy.hourlyCap,
		policy.cooldownMs,
		policy.backoffMs,
		policy.minMessages,
		policy.minIdleMs,
		policy.maxIdleMs,
		policy.minWarmness,
		policy.probability,
		policy.bubbleGate ? 1 : 0,
		policy.maxDelayMs,
		policy.maxPendingPerConversation,
		policy.maxAttempts,
	];
}

type TaskRow = {
	readonly attempts: number;
	readonly cancel_if_replied: number;
	readonly chat_object_id: string | null;
	readonly conversation_id: string;
	readonly created_at_ms: number;
	readonly created_by_id: string;
	readonly created_by_kind: string;
	readonly dedupe_key: string | null;
	readonly due_window_ms: number | null;
	readonly id: string;
	readonly kind: string;
	readonly last_error: string | null;
	readonly max_attempts: number;
	readonly occurrences: number;
	readonly prompt: string;
	readonly repeat_json: string | null;
	readonly scheduled_for_ms: number;
	readonly status: string;
	readonly task_id: string;
	readonly updated_at_ms: number;
};

type StateRow = {
	readonly active_hours_histogram_json: string;
	readonly conversation_id: string;
	readonly daily_count: number;
	readonly daily_count_date: string | null;
	readonly hourly_count: number;
	readonly hourly_window_ms: number | null;
	readonly inbound_count: number;
	readonly last_inbound_at_ms: number | null;
	readonly last_message_at_ms: number | null;
	readonly last_outbound_at_ms: number | null;
	readonly openers_json: string;
	readonly refused_count: number;
	readonly silence_until_ms: number | null;
	readonly unanswered_streak: number;
	readonly updated_at_ms: number;
	readonly warmness: number;
};

type DecisionRow = {
	readonly conversation_id: string;
	readonly created_at_ms: number;
	readonly delivery_status: string | null;
	readonly gate_json: string;
	readonly gate_result: string;
	readonly id: string;
	readonly kind: string;
	readonly marker: string | null;
	readonly skipped_reason: string | null;
	readonly task_id: string | null;
};

function jsonArray(value: string): readonly string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function jsonHistogram(value: string): Record<string, number> {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const result: Record<string, number> = {};
		for (const [key, count] of Object.entries(parsed)) {
			if (typeof count === "number" && Number.isFinite(count)) result[key] = count;
		}
		return result;
	} catch {
		return {};
	}
}

function policyFromRow(row: PolicyRow): ProactivePolicy {
	try {
		const quietHours = JSON.parse(row.quiet_hours_json) as unknown;
		const parsed = proactivePolicySchema.safeParse({
			allowNudge: row.allow_nudge === 1,
			allowProactive: row.allow_proactive === 1,
			allowRemind: row.allow_remind === 1,
			backoffMs: row.backoff_ms,
			bubbleGate: row.bubble_gate === 1,
			cooldownMs: row.cooldown_ms,
			dailyCap: row.daily_cap,
			enabled: row.enabled === 1,
			hourlyCap: row.hourly_cap,
			maxAttempts: row.max_attempts,
			maxDelayMs: row.max_delay_ms,
			maxIdleMs: row.max_idle_ms,
			maxPendingPerConversation: row.max_pending_per_conversation,
			minIdleMs: row.min_idle_ms,
			minMessages: row.min_messages,
			minWarmness: row.min_warmness,
			probability: row.probability,
			quietHours,
		});
		return parsed.success ? parsed.data : DEFAULT_PROACTIVE_POLICY;
	} catch {
		return DEFAULT_PROACTIVE_POLICY;
	}
}

function taskFromRow(row: TaskRow): ScheduledTask {
	const kind = scheduledTaskKindSchema.safeParse(row.kind);
	const status = scheduledTaskStatusSchema.safeParse(row.status);
	const createdByKind =
		row.created_by_kind === "user" || row.created_by_kind === "admin"
			? row.created_by_kind
			: "agent";
	return {
		attempts: row.attempts,
		cancelIfReplied: row.cancel_if_replied === 1,
		chatObjectId: row.chat_object_id,
		conversationId: row.conversation_id,
		createdAtMs: row.created_at_ms,
		createdById: row.created_by_id,
		createdByKind,
		dedupeKey: row.dedupe_key,
		dueWindowMs: row.due_window_ms,
		id: row.id,
		kind: kind.success ? kind.data : "remind",
		lastError: row.last_error,
		maxAttempts: row.max_attempts,
		occurrences: row.occurrences,
		prompt: row.prompt,
		repeat: parseRepeat(row.repeat_json),
		scheduledForMs: row.scheduled_for_ms,
		status: status.success ? status.data : "scheduled",
		taskId: row.task_id,
		updatedAtMs: row.updated_at_ms,
	};
}

function stateFromRow(row: StateRow): ProactiveState {
	return {
		activeHoursHistogram: jsonHistogram(row.active_hours_histogram_json),
		conversationId: row.conversation_id,
		dailyCount: row.daily_count,
		dailyCountDate: row.daily_count_date,
		hourlyCount: row.hourly_count,
		hourlyWindowMs: row.hourly_window_ms,
		inboundCount: row.inbound_count,
		lastInboundAtMs: row.last_inbound_at_ms,
		lastMessageAtMs: row.last_message_at_ms,
		lastOutboundAtMs: row.last_outbound_at_ms,
		openers: jsonArray(row.openers_json),
		refusedCount: row.refused_count,
		silenceUntilMs: row.silence_until_ms,
		unansweredStreak: row.unanswered_streak,
		updatedAtMs: row.updated_at_ms,
		warmness: row.warmness,
	};
}

function decisionFromRow(row: DecisionRow): DecisionRecord {
	const gateResult =
		row.gate_result === "eligible" ||
		row.gate_result === "skipped" ||
		row.gate_result === "delivered" ||
		row.gate_result === "failed" ||
		row.gate_result === "suppressed"
			? row.gate_result
			: "skipped";
	return {
		conversationId: row.conversation_id,
		createdAtMs: row.created_at_ms,
		deliveryStatus: row.delivery_status,
		gateResult,
		gates: parseGates(row.gate_json),
		id: row.id,
		kind: row.kind,
		marker: row.marker,
		skippedReason: row.skipped_reason,
		taskId: row.task_id,
	};
}

/** Durable plugin-owned persistence. All statements use the host-scoped namespaced handle. */
export class ProactiveSchedulerRepository {
	readonly #database: PluginDatabaseApi;
	readonly #now: () => number;

	constructor(database: PluginDatabaseApi, now: () => number = Date.now) {
		this.#database = database;
		this.#now = now;
	}

	async getPolicy(scope: string, scopeId = ""): Promise<ProactivePolicy | undefined> {
		const [row] = await this.#database.query<PolicyRow>(
			"SELECT * FROM plugin_proactive_scheduler_policies WHERE scope = ? AND scope_id = ? LIMIT 1",
			[scope, scopeId],
		);
		return row === undefined ? undefined : policyFromRow(row);
	}

	async listPolicies(): Promise<
		readonly { scope: string; scopeId: string; policy: ProactivePolicy }[]
	> {
		const rows = await this.#database.query<PolicyRow>(
			"SELECT * FROM plugin_proactive_scheduler_policies ORDER BY scope, scope_id",
		);
		return rows.map((row) => ({
			policy: policyFromRow(row),
			scope: row.scope,
			scopeId: row.scope_id,
		}));
	}

	async savePolicy(
		scope: "global" | "conversation" | "persona",
		scopeId: string,
		patch: ProactivePolicyPatch,
	): Promise<ProactivePolicy> {
		const base =
			(await this.getPolicy(scope, scopeId)) ??
			(scope === GLOBAL_POLICY_SCOPE ? DEFAULT_PROACTIVE_POLICY : await this.getGlobalPolicy());
		return await this.savePolicyExact(scope, scopeId, mergePolicy(base, patch));
	}

	async savePolicyExact(
		scope: "global" | "conversation" | "persona",
		scopeId: string,
		policy: ProactivePolicy,
	): Promise<ProactivePolicy> {
		const now = this.#now();
		const columns = POLICY_COLUMNS.join(", ");
		const placeholders = POLICY_COLUMNS.map(() => "?").join(", ");
		const updates = POLICY_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ");
		await this.#database.query(
			`INSERT INTO plugin_proactive_scheduler_policies (id, scope, scope_id, ${columns}, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ${placeholders}, ?, ?)
			 ON CONFLICT(scope, scope_id) DO UPDATE SET ${updates}, updated_at_ms = excluded.updated_at_ms`,
			[randomUUID(), scope, scopeId, ...policyValues(policy), now, now],
		);
		return policy;
	}

	async deletePolicy(scope: string, scopeId: string): Promise<void> {
		await this.#database.query(
			"DELETE FROM plugin_proactive_scheduler_policies WHERE scope = ? AND scope_id = ?",
			[scope, scopeId],
		);
	}

	async resetPolicies(): Promise<void> {
		await this.#database.query("DELETE FROM plugin_proactive_scheduler_policies");
	}

	async getGlobalPolicy(): Promise<ProactivePolicy> {
		return (await this.getPolicy(GLOBAL_POLICY_SCOPE, "")) ?? DEFAULT_PROACTIVE_POLICY;
	}

	async effectivePolicy(conversationId: string, personaId?: string): Promise<ProactivePolicy> {
		const [global, persona, conversation] = await Promise.all([
			this.getGlobalPolicy(),
			personaId === undefined
				? Promise.resolve(undefined)
				: this.getPolicy(PERSONA_POLICY_SCOPE, personaId),
			this.getPolicy(CONVERSATION_POLICY_SCOPE, conversationId),
		]);
		let merged = mergePolicy(global, persona);
		merged = mergePolicy(merged, conversation);
		return { ...merged, enabled: global.enabled && merged.enabled };
	}

	async insertTask(task: Omit<ScheduledTask, "id" | "updatedAtMs">): Promise<ScheduledTask> {
		const id = randomUUID();
		const now = this.#now();
		await this.#database.query(
			`INSERT INTO plugin_proactive_scheduler_tasks
			 (id, task_id, conversation_id, chat_object_id, kind, prompt, scheduled_for_ms, due_window_ms, repeat_json, cancel_if_replied, max_attempts, attempts, occurrences, status, last_error, created_by_kind, created_by_id, dedupe_key, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				task.taskId,
				task.conversationId,
				task.chatObjectId,
				task.kind,
				task.prompt,
				task.scheduledForMs,
				task.dueWindowMs,
				task.repeat === null ? "null" : JSON.stringify(task.repeat),
				task.cancelIfReplied ? 1 : 0,
				task.maxAttempts,
				task.attempts,
				task.occurrences,
				task.status,
				task.lastError,
				task.createdByKind,
				task.createdById,
				task.dedupeKey,
				task.createdAtMs,
				now,
			],
		);
		return { ...task, id, updatedAtMs: now };
	}

	async getTask(taskId: string): Promise<ScheduledTask | undefined> {
		const [row] = await this.#database.query<TaskRow>(
			"SELECT * FROM plugin_proactive_scheduler_tasks WHERE id = ? LIMIT 1",
			[taskId],
		);
		return row === undefined ? undefined : taskFromRow(row);
	}

	async findTaskByDedupeKey(dedupeKey: string): Promise<ScheduledTask | undefined> {
		const [row] = await this.#database.query<TaskRow>(
			"SELECT * FROM plugin_proactive_scheduler_tasks WHERE dedupe_key = ? LIMIT 1",
			[dedupeKey],
		);
		return row === undefined ? undefined : taskFromRow(row);
	}

	async findTaskByHostId(hostTaskId: string): Promise<ScheduledTask | undefined> {
		const [row] = await this.#database.query<TaskRow>(
			"SELECT * FROM plugin_proactive_scheduler_tasks WHERE task_id = ? LIMIT 1",
			[hostTaskId],
		);
		return row === undefined ? undefined : taskFromRow(row);
	}

	async listTasks(
		query: {
			readonly conversationId?: string;
			readonly status?: ScheduledTaskStatus | readonly ScheduledTaskStatus[];
			readonly kind?: ScheduledTaskKind;
			readonly limit?: number;
		} = {},
	): Promise<readonly ScheduledTask[]> {
		const statuses =
			query.status === undefined
				? undefined
				: Array.isArray(query.status)
					? query.status
					: [query.status];
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(query.kind);
		}
		if (statuses !== undefined && statuses.length > 0) {
			clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
			params.push(...statuses);
		}
		const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
		params.push(Math.max(1, query.limit ?? 200));
		const rows = await this.#database.query<TaskRow>(
			`SELECT * FROM plugin_proactive_scheduler_tasks${where} ORDER BY scheduled_for_ms ASC LIMIT ?`,
			params,
		);
		return rows.map(taskFromRow);
	}

	async pendingTasksForConversation(conversationId: string, kind?: ScheduledTaskKind) {
		return this.listTasks({
			conversationId,
			...(kind === undefined ? {} : { kind }),
			status: ["scheduled", "running"],
		});
	}

	async claimTask(taskId: string, nowMs: number): Promise<ScheduledTask | undefined> {
		const rows = await this.#database.query<{ id: string }>(
			`UPDATE plugin_proactive_scheduler_tasks
			 SET status = 'running', updated_at_ms = ?
			 WHERE id = ? AND status IN ('scheduled', 'failed')
			 RETURNING id`,
			[nowMs, taskId],
		);
		return rows.length === 0 ? undefined : await this.getTask(taskId);
	}

	async updateTask(
		taskId: string,
		patch: {
			readonly taskId?: string;
			readonly prompt?: string;
			readonly scheduledForMs?: number;
			readonly status?: ScheduledTaskStatus;
			readonly attempts?: number;
			readonly occurrences?: number;
			readonly lastError?: string | null;
			readonly repeat?: ScheduledTaskRepeat | null;
			readonly dueWindowMs?: number | null;
		},
	): Promise<ScheduledTask | undefined> {
		const sets: string[] = [];
		const params: unknown[] = [];
		const add = (column: string, value: unknown) => {
			sets.push(`${column} = ?`);
			params.push(value);
		};
		if (patch.taskId !== undefined) add("task_id", patch.taskId);
		if (patch.prompt !== undefined) add("prompt", patch.prompt);
		if (patch.scheduledForMs !== undefined) add("scheduled_for_ms", patch.scheduledForMs);
		if (patch.status !== undefined) add("status", patch.status);
		if (patch.attempts !== undefined) add("attempts", patch.attempts);
		if (patch.occurrences !== undefined) add("occurrences", patch.occurrences);
		if (patch.lastError !== undefined) add("last_error", patch.lastError);
		if (patch.repeat !== undefined) {
			add("repeat_json", patch.repeat === null ? null : JSON.stringify(patch.repeat));
		}
		if (patch.dueWindowMs !== undefined) add("due_window_ms", patch.dueWindowMs);
		if (sets.length === 0) return await this.getTask(taskId);
		add("updated_at_ms", this.#now());
		params.push(taskId);
		await this.#database.query(
			`UPDATE plugin_proactive_scheduler_tasks SET ${sets.join(", ")} WHERE id = ?`,
			params,
		);
		return await this.getTask(taskId);
	}

	async cancelTasks(query: {
		readonly conversationId?: string;
		readonly taskId?: string;
		readonly cancelIfRepliedOnly?: boolean;
	}): Promise<readonly ScheduledTask[]> {
		const clauses = ["status IN ('scheduled', 'running')"];
		const params: unknown[] = [];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.taskId !== undefined) {
			clauses.push("id = ?");
			params.push(query.taskId);
		}
		if (query.cancelIfRepliedOnly === true) clauses.push("cancel_if_replied = 1");
		const rows = await this.#database.query<TaskRow>(
			`SELECT * FROM plugin_proactive_scheduler_tasks WHERE ${clauses.join(" AND ")}`,
			params,
		);
		const cancelled: ScheduledTask[] = [];
		for (const row of rows) {
			const task = await this.updateTask(row.id, { status: "cancelled" });
			if (task !== undefined) cancelled.push(task);
		}
		return cancelled;
	}

	async getState(conversationId: string): Promise<ProactiveState | undefined> {
		const [row] = await this.#database.query<StateRow>(
			"SELECT * FROM plugin_proactive_scheduler_state WHERE conversation_id = ? LIMIT 1",
			[conversationId],
		);
		return row === undefined ? undefined : stateFromRow(row);
	}

	async saveState(state: ProactiveState): Promise<ProactiveState> {
		await this.#database.query(
			`INSERT INTO plugin_proactive_scheduler_state
			 (conversation_id, last_message_at_ms, last_inbound_at_ms, last_outbound_at_ms, inbound_count, unanswered_streak, refused_count, silence_until_ms, active_hours_histogram_json, warmness, openers_json, daily_count_date, daily_count, hourly_window_ms, hourly_count, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(conversation_id) DO UPDATE SET
			  last_message_at_ms = excluded.last_message_at_ms,
			  last_inbound_at_ms = excluded.last_inbound_at_ms,
			  last_outbound_at_ms = excluded.last_outbound_at_ms,
			  inbound_count = excluded.inbound_count,
			  unanswered_streak = excluded.unanswered_streak,
			  refused_count = excluded.refused_count,
			  silence_until_ms = excluded.silence_until_ms,
			  active_hours_histogram_json = excluded.active_hours_histogram_json,
			  warmness = excluded.warmness,
			  openers_json = excluded.openers_json,
			  daily_count_date = excluded.daily_count_date,
			  daily_count = excluded.daily_count,
			  hourly_window_ms = excluded.hourly_window_ms,
			  hourly_count = excluded.hourly_count,
			  updated_at_ms = excluded.updated_at_ms`,
			[
				state.conversationId,
				state.lastMessageAtMs,
				state.lastInboundAtMs,
				state.lastOutboundAtMs,
				state.inboundCount,
				state.unansweredStreak,
				state.refusedCount,
				state.silenceUntilMs,
				JSON.stringify(state.activeHoursHistogram),
				state.warmness,
				JSON.stringify(state.openers),
				state.dailyCountDate,
				state.dailyCount,
				state.hourlyWindowMs,
				state.hourlyCount,
				state.updatedAtMs,
			],
		);
		return state;
	}

	async recordDecision(record: Omit<DecisionRecord, "id">): Promise<DecisionRecord> {
		const id = randomUUID();
		await this.#database.query(
			`INSERT INTO plugin_proactive_scheduler_decisions
			 (id, task_id, kind, conversation_id, gate_json, gate_result, marker, delivery_status, skipped_reason, created_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				record.taskId,
				record.kind,
				record.conversationId,
				JSON.stringify(record.gates),
				record.gateResult,
				record.marker,
				record.deliveryStatus,
				record.skippedReason,
				record.createdAtMs,
			],
		);
		return { ...record, id };
	}

	async listDecisions(
		query: {
			readonly conversationId?: string;
			readonly taskId?: string;
			readonly limit?: number;
		} = {},
	): Promise<readonly DecisionRecord[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(query.taskId);
		}
		const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
		params.push(Math.max(1, query.limit ?? 100));
		const rows = await this.#database.query<DecisionRow>(
			`SELECT * FROM plugin_proactive_scheduler_decisions${where} ORDER BY created_at_ms DESC LIMIT ?`,
			params,
		);
		return rows.map(decisionFromRow);
	}

	async stats(): Promise<{
		readonly tasks: number;
		readonly pending: number;
		readonly decisions: number;
		readonly delivered: number;
		readonly skipped: number;
	}> {
		const [taskRow] = await this.#database.query<{ count: number; pending: number }>(
			`SELECT COUNT(*) AS count, SUM(CASE WHEN status IN ('scheduled', 'running') THEN 1 ELSE 0 END) AS pending FROM plugin_proactive_scheduler_tasks`,
		);
		const [decisionRow] = await this.#database.query<{
			count: number;
			delivered: number;
			skipped: number;
		}>(
			`SELECT COUNT(*) AS count,
			 SUM(CASE WHEN gate_result = 'delivered' THEN 1 ELSE 0 END) AS delivered,
			 SUM(CASE WHEN gate_result IN ('skipped', 'suppressed') THEN 1 ELSE 0 END) AS skipped
			 FROM plugin_proactive_scheduler_decisions`,
		);
		return {
			decisions: Number(decisionRow?.count ?? 0),
			delivered: Number(decisionRow?.delivered ?? 0),
			pending: Number(taskRow?.pending ?? 0),
			skipped: Number(decisionRow?.skipped ?? 0),
			tasks: Number(taskRow?.count ?? 0),
		};
	}
}

export { repeatSchema };
