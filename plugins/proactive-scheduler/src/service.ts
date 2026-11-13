import type {
	PluginAuditApi,
	PluginBackgroundTurnResult,
	PluginConversationSummary,
	PluginConversationsApi,
	PluginDatabaseApi,
	PluginLogger,
	PluginTask,
	PluginTaskExecutionResult,
	PluginTasksApi,
} from "@elaina/sdk";
import {
	activeHourBucket,
	compactStateContext,
	type DecisionRecord,
	emptyState,
	type GateResult,
	isQuietHours,
	type ProactivePolicy,
	type ProactivePolicyPatch,
	type ProactiveState,
	promptWithGuardrails,
	type ScheduledTask,
	type ScheduledTaskKind,
	type ScheduledTaskStatus,
	taskCreateInputSchema,
} from "./domain.ts";
import {
	backoffState,
	evaluateProactiveGates,
	nextCounters,
	type CandidateContext,
} from "./engine.ts";
import {
	PROACTIVE_SCHEDULER_RUN_KIND,
	PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY,
	PROACTIVE_SCHEDULER_TICK_KIND,
} from "./manifest.ts";
import { ProactiveSchedulerRepository } from "./repository.ts";

const MINUTE_MS = 60_000;
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_PROMPT_MAX_CHARS = 4_000;

export interface ProactiveSchedulerServiceOptions {
	readonly audit?: PluginAuditApi;
	readonly conversations: PluginConversationsApi;
	readonly database: PluginDatabaseApi;
	readonly logger: PluginLogger;
	readonly now?: () => number;
	readonly promptMaxChars?: number;
	readonly random?: () => number;
	readonly tasks: PluginTasksApi;
	readonly tickIntervalMs?: number;
}

export interface SimulationRow {
	readonly conversationId: string;
	readonly eligible: boolean;
	readonly reason?: string;
	readonly gates: readonly GateResult[];
	readonly dryRun: true;
}

export interface Overview {
	readonly enabled: boolean;
	readonly globalPolicy: ProactivePolicy;
	readonly overrides: readonly {
		readonly scope: string;
		readonly scopeId: string;
		readonly policy: ProactivePolicy;
	}[];
	readonly stats: Awaited<ReturnType<ProactiveSchedulerRepository["stats"]>>;
	readonly tick: { readonly taskId: string | null; readonly intervalMs: number };
}

function hostDedupeKey(taskId: string): string {
	return `proactive-scheduler:task:${taskId}`;
}

function conversationIdFromPayload(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	for (const key of ["sessionId", "conversationId", "durableConversationId"] as const) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function kindToTurnKind(kind: ScheduledTaskKind): "scheduled" | "proactive" {
	return kind === "proactive" || kind === "nudge" ? "proactive" : "scheduled";
}

/**
 * Plugin-owned scheduler state. Timers, retries, and atomic claims are delegated entirely to
 * the Phase 3 host `tasks.*` service; this class only persists domain records and evaluates
 * policy.
 */
export class ProactiveSchedulerService {
	readonly #audit: PluginAuditApi | undefined;
	readonly #conversations: PluginConversationsApi;
	readonly #logger: PluginLogger;
	readonly #now: () => number;
	readonly #promptMaxChars: number;
	readonly #random: () => number;
	readonly #repository: ProactiveSchedulerRepository;
	readonly #tasks: PluginTasksApi;
	readonly #tickIntervalMs: number;
	#tickTaskId: string | null = null;

	constructor(options: ProactiveSchedulerServiceOptions) {
		this.#audit = options.audit;
		this.#conversations = options.conversations;
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
		this.#promptMaxChars = options.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;
		this.#random = options.random ?? Math.random;
		this.#repository = new ProactiveSchedulerRepository(options.database, this.#now);
		this.#tasks = options.tasks;
		this.#tickIntervalMs = Math.max(5_000, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
	}

	get repository(): ProactiveSchedulerRepository {
		return this.#repository;
	}

	/** Register the repeat tick and any pending durable tasks from a previous process. */
	async start(): Promise<void> {
		const tick = await this.#tasks.create({
			dedupeKey: PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY,
			intervalMs: this.#tickIntervalMs,
			kind: PROACTIVE_SCHEDULER_TICK_KIND,
			nextRunAtMs: this.#now() + this.#tickIntervalMs,
		});
		this.#tickTaskId = tick.id;
		const pending = await this.#repository.listTasks({ status: ["scheduled", "running"] });
		for (const persisted of pending) {
			try {
				const task =
					persisted.status === "running"
						? ((await this.#repository.updateTask(persisted.id, { status: "scheduled" })) ??
							persisted)
						: persisted;
				await this.ensureHostTask(task);
			} catch (error) {
				this.#logger.warn("proactive scheduler could not restore task", {
					error: error instanceof Error ? error.message : String(error),
					taskId: persisted.id,
				});
			}
		}
	}

	async stop(): Promise<void> {
		if (this.#tickTaskId === null) return;
		const taskId = this.#tickTaskId;
		this.#tickTaskId = null;
		await this.#tasks.cancel(taskId);
	}

	async overview(): Promise<Overview> {
		const [globalPolicy, overrides, stats] = await Promise.all([
			this.#repository.getGlobalPolicy(),
			this.#repository.listPolicies(),
			this.#repository.stats(),
		]);
		return {
			enabled: globalPolicy.enabled,
			globalPolicy,
			overrides: overrides.filter((entry) => entry.scope !== "global"),
			stats,
			tick: { intervalMs: this.#tickIntervalMs, taskId: this.#tickTaskId },
		};
	}

	async savePolicy(
		scope: "global" | "conversation" | "persona",
		scopeId: string,
		patch: ProactivePolicyPatch,
		actorId = "webui-admin",
	): Promise<ProactivePolicy> {
		const policy = await this.#repository.savePolicy(scope, scopeId, patch);
		await this.#recordAudit({
			action: "proactive.policy.saved",
			actorId,
			payload: { enabled: policy.enabled, scope, scopeId },
			result: "ok",
			targetId: scopeId.length === 0 ? scope : scopeId,
			targetKind: "proactive-policy",
		});
		return policy;
	}

	async resetPolicies(actorId = "webui-admin"): Promise<void> {
		await this.#repository.resetPolicies();
		await this.#recordAudit({
			action: "proactive.policy.reset",
			actorId,
			payload: { destructive: true },
			result: "ok",
			targetKind: "proactive-policy",
		});
	}

	async listTasks(
		query: {
			readonly conversationId?: string;
			readonly status?: ScheduledTaskStatus | readonly ScheduledTaskStatus[];
			readonly kind?: ScheduledTaskKind;
			readonly limit?: number;
		} = {},
	): Promise<readonly ScheduledTask[]> {
		return await this.#repository.listTasks(query);
	}

	async getTask(
		taskId: string,
	): Promise<{ task: ScheduledTask; decisions: readonly DecisionRecord[] } | undefined> {
		const task = await this.#repository.getTask(taskId);
		if (task === undefined) return undefined;
		return { decisions: await this.#repository.listDecisions({ taskId, limit: 50 }), task };
	}

	async listDecisions(
		query: {
			readonly conversationId?: string;
			readonly taskId?: string;
			readonly limit?: number;
		} = {},
	): Promise<readonly DecisionRecord[]> {
		return await this.#repository.listDecisions(query);
	}

	async createTask(
		input: unknown,
		defaultConversationId?: string,
		createdBy: { readonly kind: "user" | "agent" | "admin"; readonly id: string } = {
			id: "webui-admin",
			kind: "admin",
		},
	): Promise<ScheduledTask> {
		const parsed = taskCreateInputSchema.parse({
			...((typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>),
			...(defaultConversationId === undefined ? {} : { conversationId: defaultConversationId }),
		});
		const conversation = await this.#conversations.get(parsed.conversationId);
		if (conversation === undefined)
			throw new Error(`Unknown conversation ${parsed.conversationId}`);
		const policy = await this.#repository.effectivePolicy(parsed.conversationId);
		if (parsed.delayMs > policy.maxDelayMs) {
			throw new Error(`delayMs exceeds policy maxDelayMs (${policy.maxDelayMs})`);
		}
		if (parsed.prompt.length > this.#promptMaxChars) {
			throw new Error(`prompt exceeds ${this.#promptMaxChars} characters`);
		}
		const maxAttempts = parsed.maxAttempts ?? policy.maxAttempts;
		if (maxAttempts > policy.maxAttempts) {
			throw new Error(`maxAttempts exceeds policy maxAttempts (${policy.maxAttempts})`);
		}
		const pending = await this.#repository.pendingTasksForConversation(parsed.conversationId);
		if (pending.length >= policy.maxPendingPerConversation) {
			throw new Error(
				`conversation already has ${pending.length} pending tasks (limit ${policy.maxPendingPerConversation})`,
			);
		}
		const now = this.#now();
		if (parsed.repeat?.untilMs !== undefined && parsed.repeat.untilMs <= now) {
			throw new Error("repeat.untilMs must be in the future");
		}
		const created = await this.#repository.insertTask({
			attempts: 0,
			cancelIfReplied: parsed.cancelIfReplied ?? false,
			chatObjectId: parsed.chatObjectId ?? conversation.chatObjectId,
			conversationId: parsed.conversationId,
			createdAtMs: now,
			createdById: createdBy.id,
			createdByKind: createdBy.kind,
			dueWindowMs: parsed.dueWindowMs ?? null,
			kind: parsed.kind,
			lastError: null,
			maxAttempts,
			occurrences: 0,
			prompt: parsed.prompt,
			repeat: parsed.repeat ?? null,
			scheduledForMs: now + parsed.delayMs,
			status: "scheduled",
			taskId: "",
		});
		const withHost = await this.ensureHostTask(created);
		await this.#recordAudit({
			action: "proactive.task.created",
			actorId: createdBy.id,
			actorKind: createdBy.kind === "admin" ? "user" : createdBy.kind,
			payload: {
				conversationId: withHost.conversationId,
				kind: withHost.kind,
				maxAttempts: withHost.maxAttempts,
			},
			result: "ok",
			targetId: withHost.id,
			targetKind: "proactive-task",
		});
		return withHost;
	}

	async cancelTask(taskId: string, actorId = "webui-admin"): Promise<ScheduledTask | undefined> {
		const task = await this.#repository.getTask(taskId);
		if (task === undefined) return undefined;
		const cancelled = await this.#repository.updateTask(taskId, { status: "cancelled" });
		await this.#tasks.cancelMany({ dedupeKey: hostDedupeKey(taskId) });
		if (task.taskId.length > 0) await this.#tasks.cancel(task.taskId);
		await this.#recordAudit({
			action: "proactive.task.cancelled",
			actorId,
			payload: { conversationId: task.conversationId, kind: task.kind },
			result: "ok",
			targetId: taskId,
			targetKind: "proactive-task",
		});
		return cancelled;
	}

	async cancelConversation(
		conversationId: string,
		actorId = "webui-admin",
		cancelIfRepliedOnly = false,
	): Promise<readonly ScheduledTask[]> {
		const cancelled = await this.#repository.cancelTasks({
			conversationId,
			cancelIfRepliedOnly,
		});
		for (const task of cancelled) {
			await this.#tasks.cancelMany({ dedupeKey: hostDedupeKey(task.id) });
			if (task.taskId.length > 0) await this.#tasks.cancel(task.taskId);
		}
		if (cancelled.length > 0) {
			await this.#recordAudit({
				action: "proactive.task.cancelled",
				actorId,
				payload: { cancelIfRepliedOnly, conversationId, count: cancelled.length },
				result: "ok",
				targetId: conversationId,
				targetKind: "conversation",
			});
		}
		return cancelled;
	}

	async updatePrompt(
		taskId: string,
		prompt: string,
		actorId = "webui-admin",
	): Promise<ScheduledTask | undefined> {
		const trimmed = prompt.trim();
		if (trimmed.length === 0 || trimmed.length > this.#promptMaxChars) {
			throw new Error(`prompt must be between 1 and ${this.#promptMaxChars} characters`);
		}
		const task = await this.#repository.updateTask(taskId, { prompt: trimmed });
		if (task === undefined) return undefined;
		await this.#recordAudit({
			action: "proactive.task.prompt-updated",
			actorId,
			payload: { conversationId: task.conversationId },
			result: "ok",
			targetId: taskId,
			targetKind: "proactive-task",
		});
		return task;
	}

	/** Inbound activity updates operational state and cancels answered nudges. */
	async handleMessageReceived(payload: unknown): Promise<void> {
		const conversationId = conversationIdFromPayload(payload);
		if (conversationId === undefined) return;
		const cancelled = await this.#repository.cancelTasks({
			cancelIfRepliedOnly: true,
			conversationId,
		});
		for (const task of cancelled) {
			await this.#tasks.cancelMany({ dedupeKey: hostDedupeKey(task.id) });
			if (task.taskId.length > 0) await this.#tasks.cancel(task.taskId);
		}
		const now = this.#now();
		const policy = await this.#repository.effectivePolicy(conversationId);
		const state =
			(await this.#repository.getState(conversationId)) ?? emptyState(conversationId, now);
		const bucket = activeHourBucket(now, policy.quietHours.timezoneOffsetMinutes);
		const histogram = { ...state.activeHoursHistogram };
		histogram[bucket] = (histogram[bucket] ?? 0) + 1;
		await this.#repository.saveState({
			...state,
			activeHoursHistogram: histogram,
			inboundCount: state.inboundCount + 1,
			lastInboundAtMs: now,
			lastMessageAtMs: now,
			unansweredStreak: 0,
			updatedAtMs: now,
			warmness: Math.min(1, state.warmness + 0.1),
		});
	}

	async handleAfterReply(payload: unknown): Promise<void> {
		const conversationId = conversationIdFromPayload(payload);
		if (conversationId === undefined) return;
		const now = this.#now();
		const state =
			(await this.#repository.getState(conversationId)) ?? emptyState(conversationId, now);
		await this.#repository.saveState({
			...state,
			lastMessageAtMs: now,
			lastOutboundAtMs: now,
			updatedAtMs: now,
		});
	}

	async runHostTask(task: PluginTask): Promise<PluginTaskExecutionResult> {
		if (task.kind === PROACTIVE_SCHEDULER_TICK_KIND) {
			const summary = await this.runTick();
			return {
				logs: [
					`tick candidates=${summary.candidates} sent=${summary.delivered} skipped=${summary.skipped}`,
				],
				outcome: summary,
			};
		}
		if (task.kind !== PROACTIVE_SCHEDULER_RUN_KIND) {
			return { outcome: { ignored: true }, stop: true };
		}
		const payloadTaskId =
			typeof task.payload === "object" && task.payload !== null
				? (task.payload as { taskId?: unknown }).taskId
				: undefined;
		const scheduled =
			(typeof payloadTaskId === "string" && payloadTaskId.length > 0
				? await this.#repository.getTask(payloadTaskId)
				: undefined) ?? (await this.#repository.findTaskByHostId(task.id));
		if (scheduled === undefined) return { outcome: { missing: true }, stop: true };
		return await this.#runScheduled(scheduled, task);
	}

	async runTick(): Promise<{ candidates: number; delivered: number; skipped: number }> {
		const conversations = await this.#conversations.list();
		let candidates = 0;
		let delivered = 0;
		let skipped = 0;
		const now = this.#now();
		for (const conversation of conversations) {
			if (conversation.status !== "active") continue;
			if (conversation.kind === "task" || conversation.kind === "plugin") continue;
			try {
				const [policy, conversationPolicy, state] = await Promise.all([
					this.#repository.effectivePolicy(conversation.id),
					this.#conversations.getPolicy(conversation.id),
					this.#repository.getState(conversation.id),
				]);
				if (!policy.enabled) continue;
				candidates += 1;
				const candidate: CandidateContext = {
					conversation,
					conversationPolicy,
					policy,
					state: state ?? emptyState(conversation.id, now),
				};
				const evaluation = evaluateProactiveGates({
					candidate,
					nowMs: now,
					random: this.#random,
				});
				if (evaluation.blocked) {
					skipped += 1;
					await this.#recordDecision({
						conversationId: conversation.id,
						gateResult: "skipped",
						gates: evaluation.gates,
						kind: "tick",
						marker: null,
						skippedReason: evaluation.reason ?? "blocked",
						taskId: null,
					});
					continue;
				}
				const result = await this.#deliverProactive(
					{ ...candidate, gatesForRecord: evaluation.gates },
					now,
				);
				if (result.delivered) delivered += 1;
				else skipped += 1;
			} catch (error) {
				skipped += 1;
				this.#logger.warn("proactive evaluation failed", {
					conversationId: conversation.id,
					error: error instanceof Error ? error.message : String(error),
				});
				await this.#recordDecision({
					conversationId: conversation.id,
					gateResult: "failed",
					gates: [{ gate: "delivery", reason: "error", status: "blocked" }],
					kind: "tick",
					marker: null,
					skippedReason: "error",
					taskId: null,
				});
			}
		}
		return { candidates, delivered, skipped };
	}

	async simulate(
		input: {
			readonly conversationId?: string;
			readonly nowMs?: number;
		} = {},
	): Promise<readonly SimulationRow[]> {
		const conversations =
			input.conversationId === undefined
				? await this.#conversations.list()
				: [await this.#conversations.get(input.conversationId)].filter(
						(value): value is PluginConversationSummary => value !== undefined,
					);
		const now = input.nowMs ?? this.#now();
		const rows: SimulationRow[] = [];
		for (const conversation of conversations) {
			const [policy, conversationPolicy, state] = await Promise.all([
				this.#repository.effectivePolicy(conversation.id),
				this.#conversations.getPolicy(conversation.id),
				this.#repository.getState(conversation.id),
			]);
			const evaluation = evaluateProactiveGates({
				candidate: {
					conversation,
					conversationPolicy,
					policy,
					state: state ?? emptyState(conversation.id, now),
				},
				dryRun: true,
				nowMs: now,
				random: this.#random,
			});
			rows.push({
				conversationId: conversation.id,
				dryRun: true,
				eligible: !evaluation.blocked,
				gates: evaluation.gates,
				...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
			});
		}
		return rows;
	}

	async ensureHostTask(task: ScheduledTask): Promise<ScheduledTask> {
		if (task.status !== "scheduled" && task.status !== "running") return task;
		if (task.taskId.length > 0) {
			const existing = await this.#tasks.get(task.taskId);
			if (
				existing !== undefined &&
				(existing.status === "pending" || existing.status === "running")
			) {
				return task;
			}
		}
		const host = await this.#tasks.create({
			...(task.chatObjectId === null ? {} : { chatObjectId: task.chatObjectId }),
			conversationId: task.conversationId,
			dedupeKey: hostDedupeKey(task.id),
			...(task.repeat === null ? {} : { intervalMs: task.repeat.intervalMs }),
			kind: PROACTIVE_SCHEDULER_RUN_KIND,
			maxAttempts: task.maxAttempts,
			nextRunAtMs: Math.max(this.#now(), task.scheduledForMs),
			payload: { taskId: task.id },
		});
		return (await this.#repository.updateTask(task.id, { taskId: host.id })) ?? task;
	}

	async #runScheduled(
		task: ScheduledTask,
		hostTask: PluginTask,
	): Promise<PluginTaskExecutionResult> {
		if (task.status === "cancelled" || task.status === "completed") {
			return { outcome: { status: task.status }, stop: true };
		}
		const now = this.#now();
		const claimed = await this.#repository.claimTask(task.id, now);
		if (claimed === undefined) {
			return { outcome: { unclaimed: true }, stop: task.status !== "running" };
		}
		const dueExpired =
			claimed.dueWindowMs !== null && now > claimed.scheduledForMs + claimed.dueWindowMs;
		const policy = await this.#repository.effectivePolicy(claimed.conversationId);
		const gate = this.#scheduledGate(claimed, policy, now);
		if (dueExpired || gate !== undefined) {
			const reason = dueExpired ? "due_window_expired" : (gate ?? "policy_blocked");
			await this.#recordDecision({
				conversationId: claimed.conversationId,
				deliveryStatus: "skipped",
				gateResult: "skipped",
				gates: [{ gate: "scheduled_task", reason, status: "blocked" }],
				kind: claimed.kind,
				marker: null,
				skippedReason: reason,
				taskId: claimed.id,
			});
			await this.#repository.updateTask(claimed.id, {
				lastError: reason,
				status: claimed.repeat === null ? "skipped" : "scheduled",
			});
			if (claimed.repeat !== null) {
				const next = this.#nextRepeat(claimed, now, reason);
				await this.#repository.updateTask(claimed.id, next);
				return { logs: [`skipped ${reason}`], outcome: { reason, skipped: true } };
			}
			return { logs: [`skipped ${reason}`], outcome: { reason, skipped: true }, stop: true };
		}
		try {
			const state =
				(await this.#repository.getState(claimed.conversationId)) ??
				emptyState(claimed.conversationId, now);
			const recent = await this.#conversations.recentMessages(claimed.conversationId, 8);
			const conversation = await this.#conversations.get(claimed.conversationId);
			const result = await this.#conversations.submitBackgroundTurn({
				context: compactStateContext({
					conversationKind: conversation?.kind ?? "private",
					recent,
					state,
				}),
				conversationId: claimed.conversationId,
				kind: kindToTurnKind(claimed.kind),
				prompt: promptWithGuardrails(claimed.prompt),
				taskId: claimed.id,
			});
			const outcome = await this.#applyTaskResult(claimed, policy, state, result, now);
			const next = this.#nextRepeat(claimed, now, result.skippedReason);
			await this.#repository.updateTask(claimed.id, {
				attempts: 0,
				lastError: outcome.status === "completed" ? null : (result.skippedReason ?? null),
				occurrences: claimed.occurrences + 1,
				status: outcome.status,
				...(claimed.repeat === null || outcome.stop ? {} : next),
			});
			return {
				logs: [`run ${outcome.status}`],
				outcome: { deliveryStatus: result.deliveryStatus, status: outcome.status },
				stop: outcome.stop || (claimed.repeat !== null && next.status === "completed"),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const attempts = hostTask.attempts + 1;
			const failed = attempts >= claimed.maxAttempts;
			await this.#repository.updateTask(claimed.id, {
				attempts,
				lastError: message,
				status: failed ? "failed" : "scheduled",
			});
			await this.#recordDecision({
				conversationId: claimed.conversationId,
				deliveryStatus: "failed",
				gateResult: "failed",
				gates: [{ gate: "delivery", reason: "error", status: "blocked" }],
				kind: claimed.kind,
				marker: null,
				skippedReason: "error",
				taskId: claimed.id,
			});
			this.#logger.warn("scheduled proactive task failed", {
				attempts,
				taskId: claimed.id,
			});
			throw error;
		}
	}

	#scheduledGate(task: ScheduledTask, policy: ProactivePolicy, now: number): string | undefined {
		if (isQuietHours(policy.quietHours, now)) return "quiet_hours";
		switch (task.kind) {
			case "remind":
			case "workflow":
				return policy.allowRemind ? undefined : "remind_disabled";
			case "nudge":
				return policy.enabled && policy.allowNudge ? undefined : "nudge_disabled";
			case "proactive":
				return policy.enabled && policy.allowProactive ? undefined : "proactive_disabled";
		}
	}

	#nextRepeat(
		task: ScheduledTask,
		now: number,
		reason: string | undefined,
	): {
		readonly scheduledForMs?: number;
		readonly status?: ScheduledTaskStatus;
		readonly occurrences?: number;
		readonly lastError?: string | null;
	} {
		const repeat = task.repeat;
		if (repeat === null) return {};
		const occurrences = task.occurrences + 1;
		const nextScheduled = task.scheduledForMs + repeat.intervalMs;
		const untilPassed = repeat.untilMs !== undefined && nextScheduled > repeat.untilMs;
		const maxReached = repeat.maxOccurrences !== undefined && occurrences >= repeat.maxOccurrences;
		if (untilPassed || maxReached) return { occurrences, status: "completed" };
		return {
			lastError: reason ?? null,
			occurrences,
			scheduledForMs: nextScheduled,
			status: "scheduled",
		};
	}

	async #applyTaskResult(
		task: ScheduledTask,
		policy: ProactivePolicy,
		state: ProactiveState,
		result: PluginBackgroundTurnResult,
		now: number,
	): Promise<{ readonly status: ScheduledTaskStatus; readonly stop: boolean }> {
		if (result.marker === "schedule-later") {
			const delay = result.scheduleLaterMs ?? DEFAULT_SCHEDULE_LATER_MS;
			await this.#scheduleLater(task, delay, now);
			await this.#recordDecision({
				conversationId: task.conversationId,
				deliveryStatus: result.deliveryStatus,
				gateResult: "suppressed",
				gates: [{ gate: "marker", reason: "schedule_later", status: "blocked" }],
				kind: task.kind,
				marker: result.marker,
				skippedReason: result.skippedReason ?? "marker_schedule_later",
				taskId: task.id,
			});
			await this.#repository.saveState(backoffState({ hard: false, nowMs: now, policy, state }));
			return { status: task.repeat === null ? "skipped" : "scheduled", stop: task.repeat === null };
		}
		if (result.marker === "skip" || result.marker === "lurk") {
			await this.#recordDecision({
				conversationId: task.conversationId,
				deliveryStatus: result.deliveryStatus,
				gateResult: "suppressed",
				gates: [{ gate: "marker", reason: result.marker, status: "blocked" }],
				kind: task.kind,
				marker: result.marker,
				skippedReason: result.skippedReason ?? `marker_${result.marker}`,
				taskId: task.id,
			});
			await this.#repository.saveState(
				backoffState({ hard: result.marker === "lurk", nowMs: now, policy, state }),
			);
			return { status: task.repeat === null ? "skipped" : "scheduled", stop: task.repeat === null };
		}
		const delivered = result.delivered;
		await this.#recordDecision({
			conversationId: task.conversationId,
			deliveryStatus: result.deliveryStatus,
			gateResult: delivered ? "delivered" : "skipped",
			gates: [
				{
					gate: "delivery",
					reason: result.skippedReason ?? "ok",
					status: delivered ? "passed" : "blocked",
				},
			],
			kind: task.kind,
			marker: null,
			skippedReason: result.skippedReason ?? null,
			taskId: task.id,
		});
		if (delivered) {
			await this.#repository.saveState(await this.#deliveredState(state, policy, now, result.text));
		}
		return {
			status: delivered
				? task.repeat === null
					? "completed"
					: "scheduled"
				: task.repeat === null
					? "skipped"
					: "scheduled",
			stop: task.repeat === null,
		};
	}

	async #deliverProactive(
		candidate: CandidateContext,
		now: number,
	): Promise<PluginBackgroundTurnResult> {
		const recent = await this.#conversations.recentMessages(candidate.conversation.id, 8);
		const result = await this.#conversations.submitBackgroundTurn({
			context: compactStateContext({
				conversationKind: candidate.conversation.kind,
				recent,
				state: candidate.state,
			}),
			conversationId: candidate.conversation.id,
			kind: "proactive",
			prompt: promptWithGuardrails(
				"You are initiating a short, natural follow-up in this conversation. Keep it brief and relevant.",
			),
		});
		if (result.marker === "schedule-later") {
			const delay = result.scheduleLaterMs ?? DEFAULT_SCHEDULE_LATER_MS;
			await this.#repository
				.insertTask({
					attempts: 0,
					cancelIfReplied: true,
					chatObjectId: candidate.conversation.chatObjectId,
					conversationId: candidate.conversation.id,
					createdAtMs: now,
					createdById: "proactive-engine",
					createdByKind: "agent",
					dueWindowMs: null,
					kind: "proactive",
					lastError: null,
					maxAttempts: candidate.policy.maxAttempts,
					occurrences: 0,
					prompt: "Continue the pending proactive follow-up when it feels natural.",
					repeat: null,
					scheduledForMs: now + delay,
					status: "scheduled",
					taskId: "",
				})
				.then((task) => this.ensureHostTask(task));
			await this.#recordDecision({
				conversationId: candidate.conversation.id,
				deliveryStatus: result.deliveryStatus,
				gateResult: "suppressed",
				gates: [
					...(candidate.gatesForRecord ?? []),
					{ gate: "marker", reason: "schedule_later", status: "blocked" },
				],
				kind: "tick",
				marker: result.marker,
				skippedReason: "marker_schedule_later",
				taskId: null,
			});
			await this.#repository.saveState(
				backoffState({ hard: false, nowMs: now, policy: candidate.policy, state: candidate.state }),
			);
			return result;
		}
		if (result.marker === "skip" || result.marker === "lurk") {
			await this.#recordDecision({
				conversationId: candidate.conversation.id,
				deliveryStatus: result.deliveryStatus,
				gateResult: "suppressed",
				gates: [
					...(candidate.gatesForRecord ?? []),
					{ gate: "marker", reason: result.marker, status: "blocked" },
				],
				kind: "tick",
				marker: result.marker,
				skippedReason: result.skippedReason ?? `marker_${result.marker}`,
				taskId: null,
			});
			await this.#repository.saveState(
				backoffState({
					hard: result.marker === "lurk",
					nowMs: now,
					policy: candidate.policy,
					state: candidate.state,
				}),
			);
			return result;
		}
		await this.#recordDecision({
			conversationId: candidate.conversation.id,
			deliveryStatus: result.deliveryStatus,
			gateResult: result.delivered ? "delivered" : "skipped",
			gates: [
				...(candidate.gatesForRecord ?? []),
				{ gate: "model_decision", status: "passed" },
				{
					gate: "delivery",
					reason: result.skippedReason ?? "ok",
					status: result.delivered ? "passed" : "blocked",
				},
			],
			kind: "tick",
			marker: null,
			skippedReason: result.skippedReason ?? null,
			taskId: null,
		});
		if (result.delivered) {
			await this.#repository.saveState(
				await this.#deliveredState(candidate.state, candidate.policy, now, result.text),
			);
		}
		return result;
	}

	async #deliveredState(
		state: ProactiveState,
		policy: ProactivePolicy,
		now: number,
		text: string | undefined,
	): Promise<ProactiveState> {
		const counted = nextCounters({ nowMs: now, policy, state });
		const opener = (text ?? "").trim().slice(0, 120);
		return {
			...counted,
			lastMessageAtMs: now,
			lastOutboundAtMs: now,
			openers: [...state.openers, ...(opener.length === 0 ? [] : [opener])].slice(-10),
			unansweredStreak: state.unansweredStreak + 1,
			updatedAtMs: now,
			warmness: Math.min(1, state.warmness + 0.05),
		};
	}

	async #scheduleLater(task: ScheduledTask, delayMs: number, now: number): Promise<void> {
		const created = await this.#repository.insertTask({
			attempts: 0,
			cancelIfReplied: true,
			chatObjectId: task.chatObjectId,
			conversationId: task.conversationId,
			createdAtMs: now,
			createdById: "proactive-engine",
			createdByKind: "agent",
			dueWindowMs: null,
			kind: task.kind === "remind" || task.kind === "workflow" ? task.kind : "proactive",
			lastError: null,
			maxAttempts: task.maxAttempts,
			occurrences: 0,
			prompt: task.prompt,
			repeat: null,
			scheduledForMs: now + delayMs,
			status: "scheduled",
			taskId: "",
		});
		await this.ensureHostTask(created);
	}

	async #recordDecision(input: {
		readonly conversationId: string;
		readonly deliveryStatus?: string | null;
		readonly gateResult: DecisionRecord["gateResult"];
		readonly gates: readonly GateResult[];
		readonly kind: string;
		readonly marker: string | null;
		readonly skippedReason: string | null;
		readonly taskId: string | null;
	}): Promise<void> {
		const record = await this.#repository.recordDecision({
			conversationId: input.conversationId,
			createdAtMs: this.#now(),
			deliveryStatus: input.deliveryStatus ?? null,
			gateResult: input.gateResult,
			gates: input.gates,
			kind: input.kind,
			marker: input.marker,
			skippedReason: input.skippedReason,
			taskId: input.taskId,
		});
		await this.#recordAudit({
			action: "proactive.decision",
			payload: {
				conversationId: input.conversationId,
				deliveryStatus: input.deliveryStatus ?? null,
				gateResult: input.gateResult,
				kind: input.kind,
				...(input.marker === null ? {} : { marker: input.marker }),
				...(input.skippedReason === null ? {} : { skippedReason: input.skippedReason }),
			},
			result:
				input.gateResult === "delivered"
					? "ok"
					: input.gateResult === "failed"
						? "failed"
						: "denied",
			targetId: input.taskId ?? input.conversationId,
			targetKind: input.taskId === null ? "conversation" : "proactive-task",
		});
		if (record.skippedReason === "daily_cap_reached") {
			this.#logger.debug("proactive daily cap reached", { conversationId: input.conversationId });
		}
	}

	async #recordAudit(entry: Parameters<PluginAuditApi["record"]>[0]): Promise<void> {
		try {
			await this.#audit?.record(entry);
		} catch {}
	}
}

const DEFAULT_SCHEDULE_LATER_MS = 30 * MINUTE_MS;
