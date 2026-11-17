import { randomUUID } from "node:crypto";
import type {
	PluginAuditApi,
	PluginBackgroundTurnResult,
	PluginConversationSummary,
	PluginConversationsApi,
	PluginDatabaseApi,
	PluginFollowUpsApi,
	PluginLogger,
	PluginTask,
	PluginTaskExecutionResult,
	PluginTasksApi,
	PluginSchedulesApi,
} from "@tsukaima/sdk";
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
	type GateEvaluation,
} from "./engine.ts";
import {
	PROACTIVE_SCHEDULER_RUN_KIND,
	PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY,
	PROACTIVE_SCHEDULER_TICK_KIND,
} from "./manifest.ts";
import { ProactiveSchedulerRepository } from "./repository.ts";

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_PROMPT_MAX_CHARS = 4_000;

export interface ProactiveSchedulerServiceOptions {
	readonly audit?: PluginAuditApi;
	readonly conversations: PluginConversationsApi;
	readonly database: PluginDatabaseApi;
	readonly followUps?: PluginFollowUpsApi;
	readonly schedules?: PluginSchedulesApi;
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

/** Contract schedule status to the proactive task vocabulary used by the plugin panel/tools. */
function hostStatus(
	status: "active" | "paused" | "completed" | "cancelled" | "failed",
): ScheduledTaskStatus {
	switch (status) {
		case "active":
			return "scheduled";
		case "paused":
			return "skipped";
		default:
			return status;
	}
}

/** Minimal ScheduledTask view of a host schedule; prompt text stays in the host definition. */
function scheduleToTask(row: {
	readonly id: string;
	readonly nextRunAt: string | null;
	readonly status: "active" | "paused" | "completed" | "cancelled" | "failed";
	readonly targetSessionId: string;
}): ScheduledTask {
	return {
		attempts: 0,
		cancelIfReplied: false,
		chatObjectId: null,
		conversationId: row.targetSessionId,
		createdAtMs: 0,
		createdById: "proactive-scheduler",
		createdByKind: "agent",
		dedupeKey: row.id,
		dueWindowMs: null,
		id: row.id,
		kind: "remind",
		lastError: null,
		maxAttempts: 3,
		occurrences: 0,
		prompt: "",
		repeat: null,
		scheduledForMs: row.nextRunAt === null ? 0 : Date.parse(row.nextRunAt),
		status: hostStatus(row.status),
		taskId: "",
		updatedAtMs: 0,
	};
}

const LOG_PREVIEW_MAX_CHARS = 120;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Bounded single-line preview so trace logs never leak a full prompt or span lines. */
function logPreview(value: string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	const singleLine = value.replace(/\s+/gu, " ").trim();
	if (singleLine.length <= LOG_PREVIEW_MAX_CHARS) return singleLine;
	return `${singleLine.slice(0, LOG_PREVIEW_MAX_CHARS - 1)}…`;
}

function gateSummary(gates: readonly GateResult[]): string {
	return gates
		.map(
			(entry) =>
				`${entry.gate}:${entry.status}${entry.reason === undefined ? "" : `:${entry.reason}`}`,
		)
		.join(",");
}

/**
 * Plugin-owned scheduler state. Timers, retries, and atomic claims are delegated entirely to
 * the Phase 3 host `tasks.*` service; this class only persists domain records and evaluates
 * policy.
 */
export class ProactiveSchedulerService {
	readonly #audit: PluginAuditApi | undefined;
	readonly #conversations: PluginConversationsApi;
	readonly #followUps: PluginFollowUpsApi | undefined;
	readonly #schedules: PluginSchedulesApi | undefined;
	readonly #logger: PluginLogger;
	readonly #now: () => number;
	readonly #promptMaxChars: number;
	readonly #random: () => number;
	readonly #repository: ProactiveSchedulerRepository;
	readonly #tasks: PluginTasksApi;
	readonly #tickIntervalMs: number;
	#tickTaskId: string | null = null;
	#reconcilingFollowUps: Promise<number> | undefined;

	constructor(options: ProactiveSchedulerServiceOptions) {
		this.#audit = options.audit;
		this.#conversations = options.conversations;
		this.#followUps = options.followUps;
		this.#schedules = options.schedules;
		this.#logger = options.logger.child?.("service") ?? options.logger;
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
		const startedAtMs = this.#now();
		const materialized = await this.reconcileFollowUps();
		const tick = await this.#tasks.create({
			dedupeKey: PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY,
			intervalMs: this.#tickIntervalMs,
			kind: PROACTIVE_SCHEDULER_TICK_KIND,
			nextRunAtMs: this.#now() + this.#tickIntervalMs,
		});
		this.#tickTaskId = tick.id;
		this.#logger.debug("tick task registered", {
			intervalMs: this.#tickIntervalMs,
			tickTaskId: tick.id,
		});
		const pending = await this.#repository.listTasks({ status: ["scheduled", "running"] });
		let restored = 0;
		for (const persisted of pending) {
			try {
				const task =
					persisted.status === "running"
						? ((await this.#repository.updateTask(persisted.id, { status: "scheduled" })) ??
							persisted)
						: persisted;
				await this.ensureHostTask(task);
				restored += 1;
				this.#logger.trace("restored pending task", {
					kind: persisted.kind,
					previousStatus: persisted.status,
					taskId: persisted.id,
				});
			} catch (error) {
				this.#logger.warn("proactive scheduler could not restore task", {
					error: errorMessage(error),
					taskId: persisted.id,
				});
			}
		}
		this.#logger.debug("scheduler started", {
			durationMs: this.#now() - startedAtMs,
			intervalMs: this.#tickIntervalMs,
			materializedFollowUps: materialized,
			pendingTasks: pending.length,
			restoredTasks: restored,
			tickTaskId: tick.id,
		});
	}

	async stop(): Promise<void> {
		if (this.#tickTaskId === null) {
			this.#logger.debug("scheduler stop skipped", { reason: "no_tick_task" });
			return;
		}
		const taskId = this.#tickTaskId;
		this.#tickTaskId = null;
		await this.#tasks.cancel(taskId);
		this.#logger.debug("scheduler stopped", { tickTaskId: taskId });
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
		const startedAtMs = this.#now();
		const policy = await this.#repository.savePolicy(scope, scopeId, patch);
		this.#logger.debug("policy saved", {
			actorId,
			changedFields: Object.keys(patch),
			durationMs: this.#now() - startedAtMs,
			enabled: policy.enabled,
			scope,
			scopeId,
		});
		if (patch.enabled !== undefined) {
			this.#logger.debug(
				patch.enabled ? "proactive scheduling resumed" : "proactive scheduling paused",
				{ actorId, scope, scopeId },
			);
		}
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
		this.#logger.debug("policies reset", { actorId });
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
		const local = await this.#repository.listTasks(query);
		if (this.#schedules === undefined) return local;
		const hosted = await this.#schedules.list({
			...(query.conversationId === undefined ? {} : { targetSessionId: query.conversationId }),
			...(query.limit === undefined ? {} : { limit: query.limit }),
		});
		const statuses =
			query.status === undefined
				? undefined
				: new Set(Array.isArray(query.status) ? query.status : [query.status]);
		const mapped = hosted
			.filter((task) => statuses === undefined || statuses.has(task.status))
			.map(scheduleToTask);
		return [...mapped, ...local];
	}

	async getTask(
		taskId: string,
	): Promise<{ task: ScheduledTask; decisions: readonly DecisionRecord[] } | undefined> {
		const task =
			(await this.#repository.getTask(taskId)) ??
			(this.#schedules === undefined
				? undefined
				: await this.#schedules
						.list()
						.then((rows) => rows.find((row) => row.id === taskId))
						.then((row) => (row === undefined ? undefined : scheduleToTask(row))));
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
		const canonicalConversationId = conversation.id;
		const policy = await this.#repository.effectivePolicy(canonicalConversationId);
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
		const pending = await this.#repository.pendingTasksForConversation(canonicalConversationId);
		if (pending.length >= policy.maxPendingPerConversation) {
			throw new Error(
				`conversation already has ${pending.length} pending tasks (limit ${policy.maxPendingPerConversation})`,
			);
		}
		const now = this.#now();
		if (parsed.repeat?.untilMs !== undefined && parsed.repeat.untilMs <= now) {
			throw new Error("repeat.untilMs must be in the future");
		}
		this.#logger.trace("task create requested", {
			conversationId: canonicalConversationId,
			createdBy: createdBy.id,
			delayMs: parsed.delayMs,
			kind: parsed.kind,
			promptPreview: logPreview(parsed.prompt),
			repeat: parsed.repeat !== undefined,
		});
		if (
			this.#schedules !== undefined &&
			parsed.kind !== "proactive" &&
			parsed.repeat === undefined &&
			parsed.dueWindowMs === undefined &&
			parsed.cancelIfReplied !== true &&
			pending.length === 0
		) {
			const schedule = await this.#schedules.create({
				actionKind: "agent_turn",
				...(parsed.maxAttempts === undefined ? {} : { maxAttempts: parsed.maxAttempts }),
				dedupeKey: `proactive-explicit:${canonicalConversationId}:${now}:${parsed.kind}:${parsed.delayMs}`,
				prompt: parsed.prompt,
				recurrence: {
					at: new Date(now + parsed.delayMs).toISOString(),
					kind: "once",
				},
				respectQuietHours: true,
				targetSessionId: canonicalConversationId,
				timeZone: "UTC",
				title: `${parsed.kind} · ${conversation.title}`.slice(0, 200),
			});
			this.#logger.info("proactive explicit task created as host schedule", {
				conversationId: canonicalConversationId,
				kind: parsed.kind,
				scheduleId: schedule.id,
			});
			await this.#recordAudit({
				action: "proactive.task.created",
				actorId: createdBy.id,
				actorKind: createdBy.kind === "admin" ? "user" : createdBy.kind,
				payload: {
					conversationId: canonicalConversationId,
					kind: parsed.kind,
					scheduleId: schedule.id,
				},
				result: "ok",
				targetId: schedule.id,
				targetKind: "schedule",
			});
			return {
				attempts: 0,
				cancelIfReplied: false,
				chatObjectId: conversation.chatObjectId,
				conversationId: canonicalConversationId,
				createdAtMs: now,
				createdById: createdBy.id,
				createdByKind: createdBy.kind,
				dedupeKey: schedule.id,
				dueWindowMs: null,
				id: randomUUID(),
				kind: parsed.kind,
				lastError: null,
				maxAttempts,
				occurrences: 0,
				prompt: parsed.prompt,
				repeat: null,
				scheduledForMs: now + parsed.delayMs,
				status: "scheduled",
				taskId: schedule.id,
				updatedAtMs: now,
			};
		}
		const created = await this.#repository.insertTask({
			attempts: 0,
			cancelIfReplied: parsed.cancelIfReplied ?? false,
			chatObjectId: parsed.chatObjectId ?? conversation.chatObjectId,
			conversationId: canonicalConversationId,
			createdAtMs: now,
			createdById: createdBy.id,
			createdByKind: createdBy.kind,
			dedupeKey: null,
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
		this.#logger.debug("task created", {
			attempts: withHost.attempts,
			conversationId: withHost.conversationId,
			hostTaskId: withHost.taskId,
			kind: withHost.kind,
			maxAttempts: withHost.maxAttempts,
			scheduledForMs: withHost.scheduledForMs,
			status: withHost.status,
			taskId: withHost.id,
		});
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
		if (task === undefined && this.#schedules !== undefined) {
			const cancelled = await this.#schedules.cancel(taskId);
			if (!cancelled) return undefined;
			await this.#recordAudit({
				action: "proactive.task.cancelled",
				actorId,
				payload: {},
				result: "ok",
				targetId: taskId,
				targetKind: "schedule",
			});
			return undefined;
		}
		if (task === undefined) {
			this.#logger.debug("task cancel skipped", { reason: "unknown_task", taskId });
			return undefined;
		}
		const cancelled = await this.#repository.updateTask(taskId, { status: "cancelled" });
		this.#logger.debug("task cancelled", {
			actorId,
			conversationId: task.conversationId,
			hostTaskId: task.taskId,
			kind: task.kind,
			status: cancelled?.status ?? "cancelled",
			taskId,
		});
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
			this.#logger.debug("conversation tasks cancelled", {
				actorId,
				cancelIfRepliedOnly,
				cancelled: cancelled.length,
				conversationId,
			});
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
		if (task === undefined && this.#schedules !== undefined) {
			// Host schedules are edited through the core WebUI; the plugin cannot rewrite a
			// schedule it did not materialize in its own repository.
			throw new Error("Host schedule prompts are managed through the scheduled task UI");
		}
		if (task === undefined) {
			this.#logger.debug("task prompt update skipped", { reason: "unknown_task", taskId });
			return undefined;
		}
		this.#logger.debug("task prompt updated", {
			actorId,
			conversationId: task.conversationId,
			promptLength: trimmed.length,
			promptPreview: logPreview(trimmed),
			taskId,
		});
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
		if (conversationId === undefined) {
			this.#logger.trace("inbound message ignored", { reason: "no_conversation_id" });
			return;
		}
		const startedAtMs = this.#now();
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
		this.#logger.trace("inbound message recorded", {
			activeHourBucket: bucket,
			cancelledTasks: cancelled.length,
			conversationId,
			durationMs: this.#now() - startedAtMs,
			inboundCount: state.inboundCount + 1,
		});
	}

	async handleAfterReply(payload: unknown): Promise<void> {
		const conversationId = conversationIdFromPayload(payload);
		if (conversationId === undefined) {
			this.#logger.trace("after.reply ignored", { reason: "no_conversation_id" });
			return;
		}
		const now = this.#now();
		const state =
			(await this.#repository.getState(conversationId)) ?? emptyState(conversationId, now);
		await this.#repository.saveState({
			...state,
			lastMessageAtMs: now,
			lastOutboundAtMs: now,
			updatedAtMs: now,
		});
		this.#logger.trace("outbound reply recorded", {
			conversationId,
			unansweredStreak: state.unansweredStreak,
		});
	}

	async runHostTask(task: PluginTask): Promise<PluginTaskExecutionResult> {
		const startedAtMs = this.#now();
		if (task.kind === PROACTIVE_SCHEDULER_TICK_KIND) {
			try {
				const summary = await this.runTick();
				this.#logger.debug("host tick task executed", {
					candidates: summary.candidates,
					delivered: summary.delivered,
					durationMs: this.#now() - startedAtMs,
					kind: "tick",
					skipped: summary.skipped,
					taskId: task.id,
				});
				return {
					logs: [
						`tick candidates=${summary.candidates} sent=${summary.delivered} skipped=${summary.skipped}`,
					],
					outcome: summary,
				};
			} catch (error) {
				this.#logger.debug("host tick task failed", {
					durationMs: this.#now() - startedAtMs,
					error: errorMessage(error),
					kind: "tick",
					taskId: task.id,
				});
				throw error;
			}
		}
		if (task.kind !== PROACTIVE_SCHEDULER_RUN_KIND) {
			this.#logger.trace("host task ignored", { kind: task.kind, taskId: task.id });
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
		if (scheduled === undefined) {
			this.#logger.debug("host task has no scheduled task", {
				durationMs: this.#now() - startedAtMs,
				hostTaskId: task.id,
			});
			return { outcome: { missing: true }, stop: true };
		}
		try {
			const result = await this.#runScheduled(scheduled, task);
			this.#logger.debug("host run task executed", {
				durationMs: this.#now() - startedAtMs,
				hostTaskId: task.id,
				kind: scheduled.kind,
				outcome: result.outcome,
				stop: result.stop === true,
				taskId: scheduled.id,
			});
			return result;
		} catch (error) {
			this.#logger.debug("host run task failed", {
				durationMs: this.#now() - startedAtMs,
				error: errorMessage(error),
				kind: scheduled.kind,
				taskId: scheduled.id,
			});
			throw error;
		}
	}

	async runTick(): Promise<{ candidates: number; delivered: number; skipped: number }> {
		await this.reconcileFollowUps();
		const startedAtMs = this.#now();
		const conversations = await this.#conversations.list();
		let candidates = 0;
		let delivered = 0;
		let skipped = 0;
		const now = this.#now();
		this.#logger.trace("tick started", { conversations: conversations.length, nowMs: now });
		for (const conversation of conversations) {
			if (conversation.status !== "active") {
				this.#logger.trace("tick candidate skipped", {
					conversationId: conversation.id,
					reason: `conversation_${conversation.status}`,
				});
				continue;
			}
			if (conversation.kind === "task" || conversation.kind === "plugin") {
				this.#logger.trace("tick candidate skipped", {
					conversationId: conversation.id,
					reason: `conversation_kind_${conversation.kind}`,
				});
				continue;
			}
			try {
				const [policy, conversationPolicy, state] = await Promise.all([
					this.#repository.effectivePolicy(conversation.id),
					this.#conversations.getPolicy(conversation.id),
					this.#repository.getState(conversation.id),
				]);
				if (!policy.enabled) {
					this.#logger.trace("tick candidate skipped", {
						conversationId: conversation.id,
						reason: "disabled",
					});
					continue;
				}
				candidates += 1;
				const candidate: CandidateContext = {
					conversation,
					conversationPolicy,
					policy,
					state: state ?? emptyState(conversation.id, now),
				};
				const evaluation = this.#evaluateGates(candidate, now, false);
				if (evaluation.blocked) {
					skipped += 1;
					this.#logger.trace("tick candidate blocked", {
						conversationId: conversation.id,
						gates: gateSummary(evaluation.gates),
						reason: evaluation.reason ?? "blocked",
					});
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
					error: errorMessage(error),
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
		this.#logger.debug("tick completed", {
			candidates,
			conversations: conversations.length,
			delivered,
			durationMs: this.#now() - startedAtMs,
			skipped,
		});
		return { candidates, delivered, skipped };
	}

	async simulate(
		input: {
			readonly conversationId?: string;
			readonly nowMs?: number;
		} = {},
	): Promise<readonly SimulationRow[]> {
		const startedAtMs = this.#now();
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
			const evaluation = this.#evaluateGates(
				{
					conversation,
					conversationPolicy,
					policy,
					state: state ?? emptyState(conversation.id, now),
				},
				now,
				true,
			);
			rows.push({
				conversationId: conversation.id,
				dryRun: true,
				eligible: !evaluation.blocked,
				gates: evaluation.gates,
				...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
			});
		}
		this.#logger.debug("simulation completed", {
			durationMs: this.#now() - startedAtMs,
			eligible: rows.filter((row) => row.eligible).length,
			rows: rows.length,
		});
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
		this.#logger.trace("host task registered", {
			conversationId: task.conversationId,
			hostTaskId: host.id,
			kind: task.kind,
			nextRunAtMs: host.nextRunAtMs,
			taskId: task.id,
		});
		return (await this.#repository.updateTask(task.id, { taskId: host.id })) ?? task;
	}

	/**
	 * Materialize every durable follow-up handoff owned by this plugin.
	 *
	 * The host writes the intent before it settles the suppressed reply. Creating the plugin task
	 * from that row is idempotent through `dedupe_key`, so a crash before or after the insert
	 * replays cleanly. The row is only completed after the task and its host timer exist.
	 */
	async reconcileFollowUps(): Promise<number> {
		if (this.#reconcilingFollowUps !== undefined) return await this.#reconcilingFollowUps;
		this.#reconcilingFollowUps = this.#reconcileFollowUps().finally(() => {
			this.#reconcilingFollowUps = undefined;
		});
		return await this.#reconcilingFollowUps;
	}

	async #reconcileFollowUps(): Promise<number> {
		const followUps = this.#followUps;
		if (followUps === undefined) return 0;
		const pending = await followUps.list({ limit: 500, status: "pending" });
		let materialized = 0;
		for (const intent of pending) {
			try {
				const conversation = await this.#conversations.get(intent.conversationId);
				if (conversation === undefined) {
					this.#logger.warn("follow-up intent has no conversation", {
						conversationId: intent.conversationId,
						followUpId: intent.id,
					});
					continue;
				}
				const dedupeKey = `follow-up:${intent.pluginId}:${intent.submissionRequestId}`;
				let task = await this.#repository.findTaskByDedupeKey(dedupeKey);
				if (task === undefined) {
					const policy = await this.#repository.effectivePolicy(conversation.id);
					task = await this.#repository.insertTask({
						attempts: 0,
						cancelIfReplied: true,
						chatObjectId: conversation.chatObjectId,
						conversationId: conversation.id,
						createdAtMs: this.#now(),
						createdById: "proactive-engine",
						createdByKind: "agent",
						dedupeKey,
						dueWindowMs: null,
						kind:
							intent.followUpKind === "remind" ||
							intent.followUpKind === "workflow" ||
							intent.followUpKind === "nudge"
								? intent.followUpKind
								: "proactive",
						lastError: null,
						maxAttempts: policy.maxAttempts,
						occurrences: 0,
						prompt: "Continue the pending proactive follow-up when it feels natural.",
						repeat: null,
						scheduledForMs: intent.scheduledForMs,
						status: "scheduled",
						taskId: "",
					});
					materialized += 1;
				}
				await this.ensureHostTask(task);
				await followUps.complete(intent.id);
				this.#logger.debug("follow-up intent materialized", {
					conversationId: intent.conversationId,
					followUpId: intent.id,
					taskId: task.id,
				});
			} catch (error) {
				this.#logger.warn("follow-up intent materialization failed", {
					conversationId: intent.conversationId,
					error: errorMessage(error),
					followUpId: intent.id,
				});
			}
		}
		return materialized;
	}

	async #runScheduled(
		task: ScheduledTask,
		hostTask: PluginTask,
	): Promise<PluginTaskExecutionResult> {
		if (task.status === "cancelled" || task.status === "completed") {
			this.#logger.debug("scheduled task run skipped", {
				reason: `task_${task.status}`,
				taskId: task.id,
			});
			return { outcome: { status: task.status }, stop: true };
		}
		const startedAtMs = this.#now();
		const now = startedAtMs;
		const claimed = await this.#repository.claimTask(task.id, now);
		if (claimed === undefined) {
			this.#logger.trace("scheduled task claim lost", {
				status: task.status,
				taskId: task.id,
			});
			return { outcome: { unclaimed: true }, stop: task.status !== "running" };
		}
		const dueExpired =
			claimed.dueWindowMs !== null && now > claimed.scheduledForMs + claimed.dueWindowMs;
		const policy = await this.#repository.effectivePolicy(claimed.conversationId);
		const gate = this.#scheduledGate(claimed, policy, now);
		this.#logger.trace("scheduled task claimed", {
			attempts: claimed.attempts,
			conversationId: claimed.conversationId,
			dueExpired,
			gate: gate ?? null,
			kind: claimed.kind,
			promptPreview: logPreview(claimed.prompt),
			scheduledForMs: claimed.scheduledForMs,
			taskId: claimed.id,
		});
		if (dueExpired || gate !== undefined) {
			const reason = dueExpired ? "due_window_expired" : (gate ?? "policy_blocked");
			this.#logger.debug("scheduled task skipped by gate", {
				conversationId: claimed.conversationId,
				durationMs: this.#now() - startedAtMs,
				kind: claimed.kind,
				reason,
				taskId: claimed.id,
			});
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
				followUpKind: claimed.kind,
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
			this.#logger.debug("scheduled task executed", {
				conversationId: claimed.conversationId,
				deliveryStatus: result.deliveryStatus,
				durationMs: this.#now() - startedAtMs,
				kind: claimed.kind,
				marker: result.marker ?? null,
				status: outcome.status,
				taskId: claimed.id,
			});
			return {
				logs: [`run ${outcome.status}`],
				outcome: { deliveryStatus: result.deliveryStatus, status: outcome.status },
				stop: outcome.stop || (claimed.repeat !== null && next.status === "completed"),
			};
		} catch (error) {
			const message = errorMessage(error);
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
			this.#logger.info("scheduled proactive task attempt failed", {
				attempts,
				conversationId: claimed.conversationId,
				durationMs: this.#now() - startedAtMs,
				error: message,
				kind: claimed.kind,
				maxAttempts: claimed.maxAttempts,
				taskId: claimed.id,
				terminal: failed,
			});
			this.#logger.warn("scheduled proactive task failed", {
				attempts,
				taskId: claimed.id,
			});
			throw error;
		}
	}

	/**
	 * Runs the pure gate engine and traces the full decision context (policy, state, backoff,
	 * gate results) so operators can replay why a candidate was blocked.
	 */
	#evaluateGates(candidate: CandidateContext, nowMs: number, dryRun: boolean): GateEvaluation {
		const evaluation = evaluateProactiveGates({
			candidate,
			...(dryRun ? { dryRun: true } : {}),
			nowMs,
			random: this.#random,
		});
		const { policy, state } = candidate;
		this.#logger.trace("proactive gates evaluated", {
			blocked: evaluation.blocked,
			conversationId: candidate.conversation.id,
			conversationKind: candidate.conversation.kind,
			dryRun,
			gates: gateSummary(evaluation.gates),
			policy: {
				bubbleGate: policy.bubbleGate,
				cooldownMs: policy.cooldownMs,
				dailyCap: policy.dailyCap,
				hourlyCap: policy.hourlyCap,
				minIdleMs: policy.minIdleMs,
				minWarmness: policy.minWarmness,
				probability: policy.probability,
			},
			reason: evaluation.reason ?? null,
			state: {
				inboundCount: state.inboundCount,
				lastMessageAtMs: state.lastMessageAtMs,
				lastOutboundAtMs: state.lastOutboundAtMs,
				refusedCount: state.refusedCount,
				silenceUntilMs: state.silenceUntilMs,
				unansweredStreak: state.unansweredStreak,
				warmness: state.warmness,
			},
		});
		return evaluation;
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
			// The conversation service already wrote the durable follow-up intent before settling
			// the reply. If that handoff failed, do not record a successful suppression.
			if (
				result.followUpPending === true ||
				(result.followUpRecorded !== undefined && !result.followUpRecorded)
			) {
				await this.#recordDecision({
					conversationId: task.conversationId,
					deliveryStatus: result.deliveryStatus,
					gateResult: "failed",
					gates: [{ gate: "follow_up", reason: "follow_up_pending", status: "blocked" }],
					kind: task.kind,
					marker: result.marker,
					skippedReason: "follow_up_pending",
					taskId: task.id,
				});
				return {
					status: task.repeat === null ? "skipped" : "scheduled",
					stop: task.repeat === null,
				};
			}
			this.#logger.debug("scheduled task requested schedule-later", {
				conversationId: task.conversationId,
				taskId: task.id,
			});
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
			this.#logger.debug("scheduled task suppressed by marker", {
				conversationId: task.conversationId,
				marker: result.marker,
				taskId: task.id,
			});
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
		this.#logger.debug("scheduled task turn result", {
			conversationId: task.conversationId,
			delivered,
			deliveryStatus: result.deliveryStatus,
			marker: result.marker ?? null,
			skippedReason: result.skippedReason ?? null,
			textChars: (result.text ?? "").length,
			taskId: task.id,
		});
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
			this.#logger.info("scheduled task delivered", {
				conversationId: task.conversationId,
				deliveryStatus: result.deliveryStatus,
				kind: task.kind,
				textChars: (result.text ?? "").length,
				taskId: task.id,
			});
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
		const startedAtMs = this.#now();
		const recent = await this.#conversations.recentMessages(candidate.conversation.id, 8);
		const prompt =
			"You are initiating a short, natural follow-up in this conversation. Keep it brief and relevant.";
		this.#logger.trace("proactive turn submitting", {
			conversationId: candidate.conversation.id,
			conversationKind: candidate.conversation.kind,
			promptPreview: logPreview(prompt),
			recentMessages: recent.length,
		});
		const result = await this.#conversations.submitBackgroundTurn({
			context: compactStateContext({
				conversationKind: candidate.conversation.kind,
				recent,
				state: candidate.state,
			}),
			conversationId: candidate.conversation.id,
			followUpKind: "proactive",
			kind: "proactive",
			prompt: promptWithGuardrails(prompt),
		});
		this.#logger.debug("proactive turn finished", {
			conversationId: candidate.conversation.id,
			delivered: result.delivered,
			deliveryStatus: result.deliveryStatus,
			durationMs: this.#now() - startedAtMs,
			marker: result.marker ?? null,
			skippedReason: result.skippedReason ?? null,
			textChars: (result.text ?? "").length,
		});
		if (result.marker === "schedule-later") {
			if (
				result.followUpPending === true ||
				(result.followUpRecorded !== undefined && !result.followUpRecorded)
			) {
				await this.#recordDecision({
					conversationId: candidate.conversation.id,
					deliveryStatus: result.deliveryStatus,
					gateResult: "failed",
					gates: [
						...(candidate.gatesForRecord ?? []),
						{ gate: "follow_up", reason: "follow_up_pending", status: "blocked" },
					],
					kind: "tick",
					marker: result.marker,
					skippedReason: "follow_up_pending",
					taskId: null,
				});
				await this.#repository.saveState(
					backoffState({
						hard: true,
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
			this.#logger.info("proactive turn delivered", {
				conversationId: candidate.conversation.id,
				deliveryStatus: result.deliveryStatus,
				durationMs: this.#now() - startedAtMs,
				textChars: (result.text ?? "").length,
			});
			await this.#repository.saveState(
				await this.#deliveredState(candidate.state, candidate.policy, now, result.text),
			);
		} else {
			this.#logger.debug("proactive turn not delivered", {
				conversationId: candidate.conversation.id,
				deliveryStatus: result.deliveryStatus,
				skippedReason: result.skippedReason ?? null,
			});
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
		this.#logger.debug("proactive decision recorded", {
			conversationId: input.conversationId,
			deliveryStatus: input.deliveryStatus ?? null,
			gateResult: input.gateResult,
			gates: gateSummary(input.gates),
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
