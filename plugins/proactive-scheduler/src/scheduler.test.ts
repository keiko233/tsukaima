import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
	consumeProactiveMarkers,
	defaultConversationPolicy,
	type ConversationPolicy,
} from "@elaina/contracts";
import type {
	PluginBackgroundTurnInput,
	PluginBackgroundTurnResult,
	PluginConversationMessage,
	PluginConversationsApi,
	PluginConversationSummary,
	PluginDatabaseApi,
	PluginLogger,
	PluginTask,
	PluginTaskCancelQuery,
	PluginTaskCreateInput,
	PluginTaskHandler,
	PluginTaskListQuery,
	PluginTaskUpdateInput,
	PluginTaskWatchEvent,
	PluginTasksApi,
} from "@elaina/sdk";
import {
	CONVERSATION_POLICY_SCOPE,
	DEFAULT_PROACTIVE_POLICY,
	GLOBAL_POLICY_SCOPE,
	emptyState,
	isQuietHours,
	type ProactivePolicy,
} from "./domain.ts";
import { evaluateProactiveGates } from "./engine.ts";
const MIGRATIONS = readdirSync(new URL("../migrations", import.meta.url))
	.filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
	.toSorted()
	.map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
import { ProactiveSchedulerService } from "./service.ts";

class TestDatabase implements PluginDatabaseApi {
	readonly prefix = "plugin_proactive_scheduler_";
	readonly #database = new Database(":memory:");

	constructor() {
		for (const sql of MIGRATIONS) {
			this.#database.exec(sql);
		}
	}

	async exec(sql: string): Promise<void> {
		this.#database.exec(sql);
	}

	async query<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
		return this.#database.query(sql).all(...(params as never[])) as T[];
	}
}

class FakeConversations implements PluginConversationsApi {
	readonly conversations = new Map<string, PluginConversationSummary>();
	readonly policies = new Map<string, ConversationPolicy>();
	readonly turns: PluginBackgroundTurnInput[] = [];
	readonly results: PluginBackgroundTurnResult[] = [];
	defaultResult: PluginBackgroundTurnResult = {
		delivered: true,
		deliveryStatus: "sent",
		text: "hello there",
	};
	error: Error | undefined;

	add(conversationId: string, kind: PluginConversationSummary["kind"] = "private"): void {
		this.conversations.set(conversationId, {
			channelId: "fake",
			chatObjectId: `chat-${conversationId}`,
			durableConversationId: `durable-${conversationId}`,
			id: conversationId,
			kind,
			status: "active",
			title: "Test",
			updatedAt: new Date(0).toISOString(),
		});
	}

	async list(): Promise<readonly PluginConversationSummary[]> {
		return [...this.conversations.values()];
	}

	async get(conversationId: string): Promise<PluginConversationSummary | undefined> {
		return this.conversations.get(conversationId);
	}

	async getPolicy(): Promise<ConversationPolicy> {
		return defaultConversationPolicy;
	}

	async recentMessages(): Promise<readonly PluginConversationMessage[]> {
		return [];
	}

	async submitBackgroundTurn(
		input: PluginBackgroundTurnInput,
	): Promise<PluginBackgroundTurnResult> {
		if (this.error !== undefined) throw this.error;
		this.turns.push(input);
		return this.results.shift() ?? this.defaultResult;
	}
}

class FakeTasks implements PluginTasksApi {
	readonly tasks = new Map<string, PluginTask>();
	readonly handlers = new Map<string, PluginTaskHandler>();
	readonly cancelled: string[] = [];

	async create(input: PluginTaskCreateInput): Promise<PluginTask> {
		const now = Date.now();
		const task: PluginTask = {
			attempts: 0,
			createdAtMs: now,
			id: randomUUID(),
			kind: input.kind,
			logs: [],
			maxAttempts: input.maxAttempts ?? 3,
			nextRunAtMs: input.nextRunAtMs ?? now,
			payload: input.payload,
			permissions: { permissions: ["tasks.create"] },
			pluginId: "proactive-scheduler",
			status: "pending",
			updatedAtMs: now,
			...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
			...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
			...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
			...(input.chatObjectId === undefined ? {} : { chatObjectId: input.chatObjectId }),
		};
		this.tasks.set(task.id, task);
		return task;
	}

	async get(taskId: string): Promise<PluginTask | undefined> {
		return this.tasks.get(taskId);
	}

	async list(query: PluginTaskListQuery = {}): Promise<readonly PluginTask[]> {
		return [...this.tasks.values()].filter(
			(task) =>
				(query.kind === undefined || task.kind === query.kind) &&
				(query.conversationId === undefined || task.conversationId === query.conversationId),
		);
	}

	async cancel(taskId: string): Promise<PluginTask | undefined> {
		const task = this.tasks.get(taskId);
		if (task === undefined) return undefined;
		const next = { ...task, status: "cancelled" as const };
		this.tasks.set(taskId, next);
		this.cancelled.push(taskId);
		return next;
	}

	async cancelMany(query: PluginTaskCancelQuery): Promise<readonly PluginTask[]> {
		const matches = [...this.tasks.values()].filter(
			(task) =>
				(query.dedupeKey === undefined || task.dedupeKey === query.dedupeKey) &&
				(query.conversationId === undefined || task.conversationId === query.conversationId),
		);
		const cancelled: PluginTask[] = [];
		for (const task of matches) {
			const next = await this.cancel(task.id);
			if (next !== undefined) cancelled.push(next);
		}
		return cancelled;
	}

	async update(taskId: string, input: PluginTaskUpdateInput): Promise<PluginTask | undefined> {
		const task = this.tasks.get(taskId);
		if (task === undefined) return undefined;
		const next = {
			...task,
			...(input.payload === undefined ? {} : { payload: input.payload }),
			...(input.nextRunAtMs === undefined ? {} : { nextRunAtMs: input.nextRunAtMs }),
			...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
			...(input.intervalMs === undefined || input.intervalMs === null
				? {}
				: { intervalMs: input.intervalMs }),
		};
		this.tasks.set(taskId, next);
		return next;
	}

	watch(_taskId: string, _listener: (event: PluginTaskWatchEvent) => void): () => void {
		return () => {};
	}

	registerHandler(kind: string, handler: PluginTaskHandler): () => void {
		this.handlers.set(kind, handler);
		return () => this.handlers.delete(kind);
	}
}

interface LogRecord {
	readonly details: unknown;
	readonly level: "debug" | "error" | "info" | "trace" | "warn";
	readonly message: string;
}

/** Recording `PluginLogger` double; child loggers share the buffer and prefix their target. */
function createRecordingLogger(records: LogRecord[], prefix = ""): PluginLogger {
	const write =
		(level: LogRecord["level"]) =>
		(message: string, details?: unknown): void => {
			records.push({ details, level, message: `${prefix}${message}` });
		};
	const logger: PluginLogger = {
		debug: write("debug"),
		error: write("error"),
		info: write("info"),
		trace: write("trace"),
		warn: write("warn"),
	};
	logger.child = (target) => createRecordingLogger(records, `${prefix}[${target}] `);
	return logger;
}

function loggedMessages(
	logs: readonly LogRecord[],
	level: LogRecord["level"],
	needle: string,
): LogRecord[] {
	return logs.filter((entry) => entry.level === level && entry.message.includes(needle));
}

async function setup(now = 1_000_000, globalEnabled = false) {
	const clock = { now };
	const database = new TestDatabase();
	const conversations = new FakeConversations();
	const tasks = new FakeTasks();
	const logs: LogRecord[] = [];
	const logger = createRecordingLogger(logs);
	const service = new ProactiveSchedulerService({
		conversations,
		database,
		logger,
		now: () => clock.now,
		random: () => 0,
		tasks,
	});
	conversations.add("c1");
	conversations.add("c2", "group");
	if (globalEnabled) {
		await service.repository.savePolicyExact(GLOBAL_POLICY_SCOPE, "", {
			...DEFAULT_PROACTIVE_POLICY,
			enabled: true,
		});
	}
	await service.repository.savePolicyExact(CONVERSATION_POLICY_SCOPE, "c1", {
		...DEFAULT_PROACTIVE_POLICY,
		enabled: true,
	});
	await service.repository.savePolicyExact(CONVERSATION_POLICY_SCOPE, "c2", {
		...DEFAULT_PROACTIVE_POLICY,
		enabled: true,
	});
	return { clock, conversations, database, logger, logs, service, tasks };
}

function candidate(input: {
	conversationId: string;
	policy?: ProactivePolicy;
	state?: ReturnType<typeof emptyState>;
	kind?: "private" | "group";
}) {
	return {
		conversation: {
			channelId: "fake",
			chatObjectId: `chat-${input.conversationId}`,
			durableConversationId: `durable-${input.conversationId}`,
			id: input.conversationId,
			kind: input.kind ?? ("private" as const),
			status: "active",
			title: "Test",
			updatedAt: new Date(0).toISOString(),
		},
		conversationPolicy: defaultConversationPolicy,
		policy: input.policy ?? { ...DEFAULT_PROACTIVE_POLICY, enabled: true },
		state: input.state ?? emptyState(input.conversationId, 1_000_000),
	};
}

describe("proactive policy and gates", () => {
	test("proactive is disabled by default", async () => {
		const { service, conversations } = await setup();
		const overview = await service.overview();
		expect(overview.enabled).toBe(false);
		const rows = await service.simulate({ conversationId: "c1" });
		expect(rows[0]).toEqual(expect.objectContaining({ eligible: false, reason: "disabled" }));
		expect(conversations.turns).toHaveLength(0);
	});

	test("quiet hours wrap across midnight and respect timezone offsets", () => {
		const quiet = {
			enabled: true,
			ranges: [{ end: "07:00", start: "22:00" }],
			timezoneOffsetMinutes: 0,
		};
		expect(isQuietHours(quiet, Date.UTC(2026, 0, 1, 23, 30))).toBe(true);
		expect(isQuietHours(quiet, Date.UTC(2026, 0, 1, 6, 30))).toBe(true);
		expect(isQuietHours(quiet, Date.UTC(2026, 0, 1, 12, 0))).toBe(false);
		expect(
			isQuietHours({ ...quiet, timezoneOffsetMinutes: 120 }, Date.UTC(2026, 0, 1, 6, 30)),
		).toBe(false);
	});

	test("caps, cooldown, and backoff block independently per conversation", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const activeState = {
			...emptyState("c1", now),
			inboundCount: 10,
			lastMessageAtMs: now - 30 * 60_000,
			warmness: 0.9,
		};
		const capped = evaluateProactiveGates({
			candidate: candidate({
				conversationId: "c1",
				policy: { ...DEFAULT_PROACTIVE_POLICY, enabled: true, dailyCap: 1 },
				state: { ...activeState, dailyCount: 1, dailyCountDate: "2026-01-01" },
			}),
			nowMs: now,
			random: () => 0,
		});
		expect(capped).toEqual(expect.objectContaining({ blocked: true, reason: "daily_cap_reached" }));

		const otherConversation = evaluateProactiveGates({
			candidate: candidate({
				conversationId: "c2",
				kind: "group",
				policy: { ...DEFAULT_PROACTIVE_POLICY, enabled: true, dailyCap: 1 },
				state: { ...emptyState("c2", now), ...activeState, conversationId: "c2" },
			}),
			nowMs: now,
			random: () => 0,
		});
		expect(otherConversation.blocked).toBe(false);

		const cooling = evaluateProactiveGates({
			candidate: candidate({
				conversationId: "c1",
				policy: { ...DEFAULT_PROACTIVE_POLICY, enabled: true, cooldownMs: 10 * 60_000 },
				state: { ...activeState, lastOutboundAtMs: now - 1_000 },
			}),
			nowMs: now,
			random: () => 0,
		});
		expect(cooling.reason).toBe("cooldown");

		const silenced = evaluateProactiveGates({
			candidate: candidate({
				conversationId: "c1",
				state: { ...activeState, silenceUntilMs: now + 1_000 },
			}),
			nowMs: now,
			random: () => 0,
		});
		expect(silenced.reason).toBe("silence_backoff");
	});

	test("probabilistic and bubble gates stop before the model", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const state = {
			...emptyState("c1", now),
			inboundCount: 10,
			lastMessageAtMs: now - 30 * 60_000,
			unansweredStreak: 1,
			warmness: 0.9,
		};
		const probability = evaluateProactiveGates({
			candidate: candidate({
				conversationId: "c1",
				policy: { ...DEFAULT_PROACTIVE_POLICY, enabled: true, probability: 0.2 },
				state,
			}),
			nowMs: now,
			random: () => 0.9,
		});
		expect(probability.reason).toBe("probability");
		const bubble = evaluateProactiveGates({
			candidate: candidate({
				conversationId: "c1",
				policy: { ...DEFAULT_PROACTIVE_POLICY, bubbleGate: true, enabled: true, probability: 1 },
				state,
			}),
			nowMs: now,
			random: () => 0,
		});
		expect(bubble.reason).toBe("unanswered_streak");
	});
});

describe("durable tasks", () => {
	test("persists, repeats, stops at maxOccurrences, and ignores double claims", async () => {
		const { logs, service, tasks } = await setup();
		const task = await service.createTask(
			{
				conversationId: "c1",
				delayMs: 0,
				kind: "remind",
				prompt: "drink water",
				repeat: { intervalMs: 10_000, maxOccurrences: 2 },
			},
			undefined,
			{ id: "agent-1", kind: "agent" },
		);
		expect(loggedMessages(logs, "debug", "task created")).toHaveLength(1);
		expect(loggedMessages(logs, "debug", "task created")[0]?.message).toStartWith("[service] ");
		expect(loggedMessages(logs, "debug", "task created")[0]?.details).toEqual(
			expect.objectContaining({ conversationId: "c1", kind: "remind", taskId: task.id }),
		);
		expect(loggedMessages(logs, "trace", "task create requested")[0]?.details).toEqual(
			expect.objectContaining({
				conversationId: "c1",
				createdBy: "agent-1",
				kind: "remind",
				promptPreview: "drink water",
			}),
		);
		const host = tasks.tasks.get(task.taskId);
		expect(host).toBeDefined();
		const first = await service.runHostTask(host!);
		expect(first.stop).toBe(false);
		expect(loggedMessages(logs, "debug", "host run task executed")[0]?.details).toEqual(
			expect.objectContaining({ kind: "remind", stop: false, taskId: task.id }),
		);
		expect(typeof loggedMessages(logs, "debug", "host run task executed")[0]?.details).not.toBe(
			"undefined",
		);
		const afterFirst = await service.repository.getTask(task.id);
		expect(afterFirst?.status).toBe("scheduled");
		expect(afterFirst?.occurrences).toBe(1);
		expect(afterFirst?.scheduledForMs).toBe(1_000_000 + 10_000);
		const second = await service.runHostTask(host!);
		expect(second.stop).toBe(true);
		const afterSecond = await service.repository.getTask(task.id);
		expect(afterSecond?.status).toBe("completed");
		expect(afterSecond?.occurrences).toBe(2);
		const third = await service.runHostTask(host!);
		expect(third.stop).toBe(true);
		expect((await service.repository.listDecisions({ taskId: task.id })).length).toBe(2);
	});

	test("claims a one-shot task atomically and stops a repeat at untilMs", async () => {
		const { conversations, service, tasks } = await setup();
		const once = await service.createTask({
			conversationId: "c1",
			delayMs: 0,
			kind: "remind",
			prompt: "single fire",
		});
		const host = tasks.tasks.get(once.taskId)!;
		await Promise.all([service.runHostTask(host), service.runHostTask(host)]);
		expect(conversations.turns).toHaveLength(1);
		expect((await service.repository.getTask(once.id))?.status).toBe("completed");

		const until = await service.createTask({
			conversationId: "c1",
			delayMs: 0,
			kind: "remind",
			prompt: "until",
			repeat: { intervalMs: 10_000, untilMs: 1_000_000 + 5_000 },
		});
		const result = await service.runHostTask(tasks.tasks.get(until.taskId)!);
		expect(result.stop).toBe(true);
		expect((await service.repository.getTask(until.id))?.status).toBe("completed");
	});

	test("records skipped when the due window expires", async () => {
		const { clock, service, tasks } = await setup(1_000_000);
		const task = await service.createTask({
			conversationId: "c1",
			delayMs: 0,
			dueWindowMs: 1,
			kind: "remind",
			prompt: "late",
		});
		clock.now += 10_000;
		const host = tasks.tasks.get(task.taskId);
		const result = await service.runHostTask(host!);
		expect(result.stop).toBe(true);
		expect((await service.repository.getTask(task.id))?.status).toBe("skipped");
		expect((await service.repository.listDecisions({ taskId: task.id }))[0]?.skippedReason).toBe(
			"due_window_expired",
		);
	});

	test("retries after failure and records attempts", async () => {
		const { conversations, logs, service, tasks } = await setup();
		const task = await service.createTask({
			conversationId: "c1",
			delayMs: 0,
			kind: "remind",
			maxAttempts: 2,
			prompt: "retry me",
		});
		conversations.error = new Error("model down");
		await expect(service.runHostTask(tasks.tasks.get(task.taskId)!)).rejects.toThrow("model down");
		const failed = await service.repository.getTask(task.id);
		expect(failed).toEqual(expect.objectContaining({ attempts: 1, status: "scheduled" }));
		expect(
			loggedMessages(logs, "info", "scheduled proactive task attempt failed")[0]?.details,
		).toEqual(
			expect.objectContaining({
				attempts: 1,
				conversationId: "c1",
				error: "model down",
				taskId: task.id,
				terminal: false,
			}),
		);
		expect(loggedMessages(logs, "debug", "host run task failed")[0]?.details).toEqual(
			expect.objectContaining({ error: "model down", taskId: task.id }),
		);
		conversations.error = undefined;
		const host = tasks.tasks.get(task.taskId)!;
		const retried = await service.runHostTask({ ...host, attempts: 1 });
		expect(retried.stop).toBe(true);
		expect((await service.repository.getTask(task.id))?.status).toBe("completed");
	});

	test("cancelIfReplied cancels pending nudges on inbound activity", async () => {
		const { service, tasks } = await setup();
		const task = await service.createTask({
			cancelIfReplied: true,
			conversationId: "c1",
			delayMs: 60_000,
			kind: "nudge",
			prompt: "nudge",
		});
		await service.handleMessageReceived({ sessionId: "c1" });
		expect((await service.repository.getTask(task.id))?.status).toBe("cancelled");
		expect(tasks.cancelled.length).toBeGreaterThan(0);
		const state = await service.repository.getState("c1");
		expect(state).toEqual(expect.objectContaining({ inboundCount: 1, unansweredStreak: 0 }));
		expect(state?.activeHoursHistogram["0"]).toBe(1);
	});

	test("enforces tool bounds for delay, prompt, attempts, and pending tasks", async () => {
		const { service } = await setup();
		await expect(
			service.createTask({ conversationId: "c1", delayMs: 10 * 365 * 24 * 3_600_000, prompt: "x" }),
		).rejects.toThrow("maxDelayMs");
		await expect(
			service.createTask({ conversationId: "c1", delayMs: 0, prompt: "x".repeat(5_000) }),
		).rejects.toThrow("prompt exceeds");
		await expect(
			service.createTask({ conversationId: "c1", delayMs: 0, maxAttempts: 99, prompt: "x" }),
		).rejects.toThrow("maxAttempts");
		await service.repository.savePolicyExact(CONVERSATION_POLICY_SCOPE, "c1", {
			...DEFAULT_PROACTIVE_POLICY,
			enabled: true,
			maxPendingPerConversation: 1,
		});
		await service.createTask({ conversationId: "c1", delayMs: 1000, prompt: "first" });
		await expect(
			service.createTask({ conversationId: "c1", delayMs: 1000, prompt: "second" }),
		).rejects.toThrow("pending tasks");
	});
});

describe("proactive delivery and markers", () => {
	test("delivers a tick and increments per-conversation counters", async () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const { logs, service } = await setup(now, true);
		await service.repository.saveState({
			...emptyState("c1", now),
			inboundCount: 10,
			lastMessageAtMs: now - 30 * 60_000,
			warmness: 0.9,
		});
		const result = await service.runTick();
		expect(result.delivered).toBe(1);
		const gateTrace = loggedMessages(logs, "trace", "proactive gates evaluated").find(
			(entry) => (entry.details as { dryRun?: boolean }).dryRun === false,
		);
		expect(gateTrace?.details).toEqual(
			expect.objectContaining({
				blocked: false,
				conversationId: "c1",
				reason: null,
				state: expect.objectContaining({ inboundCount: 10, unansweredStreak: 0, warmness: 0.9 }),
			}),
		);
		expect((gateTrace?.details as { gates?: string } | undefined)?.gates).toContain(
			"bubble_gate:passed",
		);
		expect(loggedMessages(logs, "info", "proactive turn delivered")[0]?.details).toEqual(
			expect.objectContaining({ conversationId: "c1", deliveryStatus: "sent" }),
		);
		expect(loggedMessages(logs, "debug", "tick completed")[0]?.details).toEqual(
			expect.objectContaining({ candidates: 2, delivered: 1, skipped: 1 }),
		);
		const state = await service.repository.getState("c1");
		expect(state?.dailyCount).toBe(1);
		expect(state?.unansweredStreak).toBe(1);
		expect((await service.repository.listDecisions({ conversationId: "c1" }))[0]?.gateResult).toBe(
			"delivered",
		);
	});

	test("consumes ELAINA_SKIP/ELAINA_LURK markers without sending and backs off", async () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const { conversations, service } = await setup(now, true);
		await service.repository.saveState({
			...emptyState("c1", now),
			inboundCount: 10,
			lastMessageAtMs: now - 30 * 60_000,
			warmness: 0.9,
		});
		conversations.results.push({
			delivered: false,
			deliveryStatus: "suppressed",
			marker: "skip",
			skippedReason: "marker_skip",
			text: "",
		});
		await service.runTick();
		const decisions = await service.repository.listDecisions({ conversationId: "c1" });
		expect(decisions[0]).toEqual(
			expect.objectContaining({ gateResult: "suppressed", marker: "skip" }),
		);
		const state = await service.repository.getState("c1");
		expect(state?.refusedCount).toBe(1);
		expect(state?.silenceUntilMs).toBeGreaterThan(now);
		expect(conversations.turns[0]?.prompt).toContain("ELAINA_SKIP");
	});

	test("schedules later when the model emits ELAINA_SCHEDULE_LATER", async () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const { conversations, service } = await setup(now, true);
		await service.repository.saveState({
			...emptyState("c1", now),
			inboundCount: 10,
			lastMessageAtMs: now - 30 * 60_000,
			warmness: 0.9,
		});
		conversations.results.push({
			delivered: false,
			deliveryStatus: "suppressed",
			marker: "schedule-later",
			scheduleLaterMs: 15 * 60_000,
			text: "",
		});
		await service.runTick();
		const tasks = await service.repository.listTasks({ conversationId: "c1" });
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toEqual(
			expect.objectContaining({
				kind: "proactive",
				status: "scheduled",
				scheduledForMs: now + 900_000,
			}),
		);
	});

	test("consumes every output marker before text can be delivered", () => {
		expect(consumeProactiveMarkers("ELAINA_SKIP")).toEqual({ marker: "skip", text: "" });
		expect(consumeProactiveMarkers("ELAINA_LURK")).toEqual({ marker: "lurk", text: "" });
		expect(consumeProactiveMarkers("ELAINA_SCHEDULE_LATER 15m")).toEqual({
			marker: "schedule-later",
			scheduleLaterMs: 900_000,
			text: "",
		});
		expect(consumeProactiveMarkers("hello ELAINA_SKIP world")).toEqual({
			marker: "skip",
			text: "hello world",
		});
	});

	test("simulate never sends and explains every gate", async () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const { conversations, logs, service } = await setup(now, true);
		await service.repository.saveState({
			...emptyState("c1", now),
			inboundCount: 10,
			lastMessageAtMs: now - 30 * 60_000,
			warmness: 0.9,
		});
		const rows = await service.simulate({ conversationId: "c1" });
		expect(conversations.turns).toHaveLength(0);
		expect(rows[0]?.eligible).toBe(true);
		expect(loggedMessages(logs, "trace", "proactive gates evaluated").at(-1)?.details).toEqual(
			expect.objectContaining({ blocked: false, conversationId: "c1", dryRun: true }),
		);
		expect(loggedMessages(logs, "debug", "simulation completed")[0]?.details).toEqual(
			expect.objectContaining({ eligible: 1, rows: 1 }),
		);
		expect(rows[0]?.gates.map((gate) => gate.gate)).toEqual(
			expect.arrayContaining([
				"candidate",
				"policy",
				"quiet_hours",
				"daily_cap",
				"hourly_cap",
				"cooldown",
				"activity",
				"warmness",
				"probability",
				"bubble_gate",
				"model_decision",
				"audit",
			]),
		);
	});
});

describe("logging and tracing", () => {
	test("logs tick registration, restored tasks, start, and stop", async () => {
		const { logs, service, tasks } = await setup();
		await service.createTask({ conversationId: "c1", delayMs: 60_000, prompt: "pending" });
		await service.start();
		expect(loggedMessages(logs, "debug", "tick task registered")[0]?.details).toEqual(
			expect.objectContaining({ intervalMs: 60_000 }),
		);
		expect(loggedMessages(logs, "debug", "scheduler started")[0]?.details).toEqual(
			expect.objectContaining({ intervalMs: 60_000, pendingTasks: 1, restoredTasks: 1 }),
		);
		await service.stop();
		expect(loggedMessages(logs, "debug", "scheduler stopped")).toHaveLength(1);
		expect(tasks.cancelled.length).toBeGreaterThan(0);
	});

	test("traces single-line bounded prompt previews", async () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const { logs, service } = await setup(now, true);
		const prompt = `${Array.from({ length: 80 }, () => "word").join(" ")}\nsecond line`;
		await service.createTask({ conversationId: "c1", delayMs: 0, kind: "remind", prompt });
		const trace = loggedMessages(logs, "trace", "task create requested")[0];
		expect(trace?.details).toEqual(expect.objectContaining({ conversationId: "c1" }));
		const preview = (trace?.details as { promptPreview?: string } | undefined)?.promptPreview;
		expect(typeof preview).toBe("string");
		expect(preview?.length ?? 0).toBeLessThanOrEqual(120);
		expect(preview?.includes("\n")).toBe(false);
		expect(preview?.startsWith("word word")).toBe(true);
	});
});
