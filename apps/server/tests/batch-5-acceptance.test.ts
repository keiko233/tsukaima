import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { TurnContextRequest } from "@tsukaima/core";
import {
	conversations,
	memories,
	memoryConsolidationState,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	type TsukaimaDatabase,
	users,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import { createLogger } from "../src/logging.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { DrizzleContextProvider } from "../src/services/context-provider.ts";
import { isPhaticMessage, mergeWarmState } from "../src/services/memory-consolidation.ts";
import { MemoryService, type MemoryServiceOptions } from "../src/services/memory-service.ts";
import { PluginTaskService } from "../src/services/plugin-task-service.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error", target: "tsukaima::test" });
const fixedNow = new Date("2026-11-13T12:00:00.000Z");

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

interface Fixture {
	readonly audits: AuditEntry[];
	readonly database: TsukaimaDatabase;
	readonly memory: MemoryService;
	readonly policy: ConversationPolicyService;
	readonly tasks: PluginTaskService;
}

function memoryService(
	fixture: Pick<Fixture, "audits" | "database" | "policy" | "tasks">,
	options: Partial<MemoryServiceOptions> = {},
): MemoryService {
	return new MemoryService({
		audit: async (entry) => {
			fixture.audits.push(entry);
		},
		database: () => fixture.database,
		logger,
		now: () => fixedNow,
		policyService: fixture.policy,
		tasks: fixture.tasks,
		...options,
	});
}

async function setup(options: Partial<MemoryServiceOptions> = {}): Promise<Fixture> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-5-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const policy = new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
	const tasks = new PluginTaskService({
		database,
		logger,
		now: () => fixedNow.getTime(),
	});
	const audits: AuditEntry[] = [];
	const fixture = { audits, database, policy, tasks } as Fixture;
	const memory = memoryService(fixture, options);
	memory.registerTaskHandlers(tasks);
	return { ...fixture, memory };
}

async function seedConversation(
	database: TsukaimaDatabase,
	input: {
		readonly id: string;
		readonly kind?: "group" | "private";
		readonly title?: string;
	},
): Promise<void> {
	await database.insert(conversations).values({
		durableConversationId: `durable-${input.id}`,
		id: input.id,
		kind: input.kind ?? "private",
		title: input.title ?? input.id,
	});
}

async function seedMessage(
	database: TsukaimaDatabase,
	input: {
		readonly at?: string;
		readonly conversationId: string;
		readonly direction?: "inbound" | "outbound";
		readonly id: string;
		readonly senderDisplayName?: string;
		readonly senderUserId?: string;
		readonly text: string;
	},
): Promise<void> {
	await database.insert(messages).values({
		contentText: input.text,
		conversationId: input.conversationId,
		direction: input.direction ?? "inbound",
		id: input.id,
		kind: "onebot-v11",
		occurredAt: input.at ?? fixedNow.toISOString(),
		...(input.senderDisplayName === undefined
			? {}
			: { senderDisplayName: input.senderDisplayName }),
		...(input.senderUserId === undefined ? {} : { senderUserId: input.senderUserId }),
	});
}

async function seedUsers(database: TsukaimaDatabase, ids: readonly string[]): Promise<void> {
	await database
		.insert(users)
		.values(ids.map((id) => ({ id, kind: "human" as const, displayName: id })));
}

function validConsolidation(summary: string): string {
	return JSON.stringify({
		memories: [],
		state: {
			answers: [],
			atmosphere: "",
			commitments: [],
			glossary: [],
			people: [],
			summary,
			topics: [],
		},
	});
}

describe("Batch 5 acceptance: hot path", () => {
	test("prompt rendering performs zero network embedding calls; backfill is a separate async task", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-hot" });
		await seedMessage(fixture.database, {
			conversationId: "session-hot",
			id: "hot-message-1",
			text: "I want a latte",
		});
		let embedCalls = 0;
		const memory = memoryService(fixture, {
			embed: async (texts) => {
				embedCalls += 1;
				return { modelId: "embed-test", vectors: texts.map(() => [1, 0]) };
			},
		});
		const context = new DrizzleContextProvider({
			budgetChars: 1_200,
			database: () => fixture.database,
			logger,
			memoryService: memory,
			policyService: fixture.policy,
		});
		const inserted = await memory.create({
			kind: "preference",
			scope: "global",
			summary: "Loves latte",
		});
		expect(inserted.memory.embeddingJson).toBeNull();
		const before = await context.renderMemories("durable-session-hot");
		expect(before).toContain("Loves latte");
		expect(embedCalls).toBe(0);
		expect((await memory.get(inserted.memory.id))?.embeddingJson).toBeNull();
		const backfilled = await memory.embedPending();
		expect(backfilled).toEqual({ embedded: 1, modelId: "embed-test" });
		expect((await memory.get(inserted.memory.id))?.embeddingModel).toBe("embed-test");
		const after = await context.renderMemories("durable-session-hot");
		expect(after).toContain("Loves latte");
	});

	test("re-embeds rows when the embedding model changes and leaves them untouched on failure", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-reembed" });
		let currentModel = "embed-old";
		let fail = false;
		const memory = memoryService(fixture, {
			embed: async (texts) => {
				if (fail) throw new Error("synthetic embedding outage");
				return { modelId: currentModel, vectors: texts.map(() => [0.5, 0.5]) };
			},
			embeddingModelId: async () => currentModel,
		});
		const created = await memory.create({
			kind: "fact",
			scope: "global",
			summary: "Synthetic embedding fact",
		});
		await fixture.database
			.update(memories)
			.set({ embeddingJson: JSON.stringify([1, 0]), embeddingModel: "embed-old" })
			.where(eq(memories.id, created.memory.id));
		currentModel = "embed-new";
		expect(await memory.embedPending()).toEqual({ embedded: 1, modelId: "embed-new" });
		expect((await memory.get(created.memory.id))?.embeddingModel).toBe("embed-new");
		fail = true;
		currentModel = "embed-newer";
		expect(await memory.embedPending()).toEqual({ embedded: 0 });
		expect((await memory.get(created.memory.id))?.embeddingModel).toBe("embed-new");
	});

	test("coalesces after.reply and activity.closed notes into one job and one model call", async () => {
		let sawAbortSignal = false;
		const fixture = await setup({
			complete: async (_prompt, _modelId, signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				return validConsolidation("Five messages and one reply were merged.");
			},
			llmEnabled: () => true,
		});
		await fixture.policy.update({
			policy: { memoryConsolidation: { idleMs: 0, minNewMessages: 1 } },
			scope: "global",
		});
		await seedConversation(fixture.database, { id: "session-coalesce" });
		for (let index = 0; index < 5; index += 1) {
			await seedMessage(fixture.database, {
				conversationId: "session-coalesce",
				id: `coalesce-in-${index}`,
				text: `Message ${index} about the weekend plan`,
			});
		}
		await seedMessage(fixture.database, {
			conversationId: "session-coalesce",
			direction: "outbound",
			id: "coalesce-reply",
			text: "Sounds good.",
		});
		await Promise.all(
			Array.from({ length: 6 }, () =>
				fixture.memory.noteConversationActivity({
					conversationId: "session-coalesce",
				}),
			),
		);
		const pending = await fixture.tasks.list("memory", {
			kind: "memory.consolidate",
			status: ["pending", "running"],
		});
		expect(pending).toHaveLength(1);
		const ticks = await fixture.tasks.tick();
		expect(ticks).toBeGreaterThan(0);
		expect(sawAbortSignal).toBe(true);
		const warm = await fixture.memory.warmState("session-coalesce");
		expect(warm?.state?.summary).toContain("Five messages and one reply");
		const after = await fixture.tasks.list("memory", { kind: "memory.consolidate" });
		expect(after).toHaveLength(1);
		expect(after[0]?.status).toBe("completed");
	});
});

describe("Batch 5 acceptance: warm state quality", () => {
	test("phatic chatter produces no bogus topics, decisions, todos, or commitments", async () => {
		let modelCalls = 0;
		const fixture = await setup({
			complete: async () => {
				modelCalls += 1;
				return JSON.stringify({
					memories: [],
					state: {
						commitments: [{ key: "bogus", status: "open", text: "Should not appear" }],
						summary: "Bogus summary",
						topics: ["Bogus topic"],
					},
				});
			},
			llmEnabled: () => true,
		});
		await seedUsers(fixture.database, ["synthetic-user"]);
		await seedConversation(fixture.database, { id: "session-phatic" });
		for (const [index, text] of ["哈哈", "什么", "笑死", "lol", "233"].entries()) {
			await seedMessage(fixture.database, {
				conversationId: "session-phatic",
				id: `phatic-${index}`,
				senderDisplayName: "Synthetic speaker",
				senderUserId: "synthetic-user",
				text,
			});
		}
		const result = await fixture.memory.consolidateConversation("session-phatic");
		expect(result).toMatchObject({ status: "consolidated" });
		expect(modelCalls).toBe(0);
		const warm = await fixture.memory.warmState("session-phatic");
		expect(warm?.state).toMatchObject({
			atmosphere: "",
			commitments: [],
			summary: "",
			topics: [],
		});
		const table: readonly [string, boolean][] = [
			["哈哈", true],
			["什么", true],
			["笑死", true],
			["lol", true],
			["233", true],
			["今天天气怎么样？", true],
			["你猜", true],
			["[表情:笑]", true],
			["我喜欢抹茶", false],
			["明天下午三点开会", false],
			["The launch is on Friday", false],
		];
		for (const [text, expected] of table) expect(isPhaticMessage(text)).toBe(expected);
	});

	test("orders person cards deterministically by last seen time before enforcing the cap", () => {
		const state = mergeWarmState({
			nowIso: fixedNow.toISOString(),
			next: {
				answers: [],
				atmosphere: "",
				commitments: [],
				glossary: [],
				people: [
					{
						aliases: [],
						key: "old",
						lastSeenAt: "2026-11-01T00:00:00.000Z",
						name: "Old",
						notes: ["x"],
					},
					{
						aliases: [],
						key: "new",
						lastSeenAt: "2026-11-13T00:00:00.000Z",
						name: "New",
						notes: ["y"],
					},
				],
				summary: "Synthetic state",
				topics: [],
			},
			policy: { maxPersonCards: 1, summaryMaxChars: 1_200 },
			previous: undefined,
		});
		expect(state.people.map((card) => card.key)).toEqual(["new"]);
	});

	test("writes a fact about an identified speaker to the cross-conversation user scope", async () => {
		const fixture = await setup({
			complete: async () =>
				JSON.stringify({
					memories: [
						{
							confidence: 0.9,
							importance: 0.7,
							kind: "preference",
							subject: "synthetic-user",
							summary: "Prefers jasmine tea",
						},
					],
					state: {
						people: [
							{
								aliases: [],
								key: "synthetic-user",
								name: "Synthetic speaker",
								notes: ["Likes jasmine tea"],
							},
						],
						summary: "Synthetic speaker joined.",
						topics: ["tea"],
					},
				}),
			llmEnabled: () => true,
		});
		await seedUsers(fixture.database, ["synthetic-user"]);
		await seedConversation(fixture.database, { id: "session-user-fact" });
		await seedMessage(fixture.database, {
			conversationId: "session-user-fact",
			id: "user-fact-message",
			senderDisplayName: "Synthetic speaker",
			senderUserId: "synthetic-user",
			text: "I really like jasmine tea.",
		});
		await fixture.memory.consolidateConversation("session-user-fact");
		const rows = await fixture.database.select().from(memories);
		const stored = rows.find((row) => row.summary === "Prefers jasmine tea");
		expect(stored).toMatchObject({
			scope: "user",
			subjectUserId: "synthetic-user",
			visibility: "shared",
		});
		expect(stored?.conversationId).toBeNull();
	});
});

function turnContextRequest(conversationId: string, envelopeId: string): TurnContextRequest {
	return {
		conversationId,
		inputs: [{ envelopeId }],
		nowMs: fixedNow.getTime(),
		triggers: [],
	};
}

async function renderCrossSession(
	fixture: Fixture,
	conversationId: string,
	envelopeId: string,
): Promise<readonly { key: string; text: string }[]> {
	const memory = memoryService(fixture);
	const context = new DrizzleContextProvider({
		budgetChars: 1_200,
		database: () => fixture.database,
		logger,
		memoryService: memory,
		policyService: fixture.policy,
	});
	return context.renderTurnContext(turnContextRequest(conversationId, envelopeId));
}

describe("Batch 5 acceptance: cross-session awareness", () => {
	test("covers every identified speaker in a multi-speaker burst without mixing their histories", async () => {
		const fixture = await setup();
		await seedUsers(fixture.database, ["synthetic-a", "synthetic-b"]);
		for (const [id, title] of [
			["session-burst-current", "Current group"],
			["session-burst-a", "Group A"],
			["session-burst-b", "Group B"],
		]) {
			await seedConversation(fixture.database, { id: id ?? "", kind: "group", title: title ?? "" });
		}
		await seedMessage(fixture.database, {
			conversationId: "session-burst-current",
			id: "burst-current-a",
			senderDisplayName: "Speaker A",
			senderUserId: "synthetic-a",
			text: "First input",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T12:00:01.000Z",
			conversationId: "session-burst-current",
			id: "burst-current-b",
			senderDisplayName: "Speaker B",
			senderUserId: "synthetic-b",
			text: "Second input",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T11:50:00.000Z",
			conversationId: "session-burst-a",
			id: "burst-source-a",
			senderDisplayName: "Speaker A",
			senderUserId: "synthetic-a",
			text: "MARKER-FROM-A",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T11:55:00.000Z",
			conversationId: "session-burst-b",
			id: "burst-source-b",
			senderDisplayName: "Speaker B",
			senderUserId: "synthetic-b",
			text: "MARKER-FROM-B",
		});
		const memory = memoryService(fixture);
		const context = new DrizzleContextProvider({
			budgetChars: 1_200,
			database: () => fixture.database,
			logger,
			memoryService: memory,
			policyService: fixture.policy,
		});
		const sections = await context.renderTurnContext({
			conversationId: "durable-session-burst-current",
			inputs: [{ envelopeId: "burst-current-a" }, { envelopeId: "burst-current-b" }],
			nowMs: fixedNow.getTime(),
			triggers: [],
		});
		const cross = sections.find((section) => section.key === "cross-session")?.text ?? "";
		expect(cross).toContain("Speaker A recently in other chats");
		expect(cross).toContain("MARKER-FROM-A");
		expect(cross).toContain("Speaker B recently in other chats");
		expect(cross).toContain("MARKER-FROM-B");
	});

	test("surfaces same-user group continuity, redacts private chat text, and fails closed for unknown speakers", async () => {
		const fixture = await setup();
		await seedUsers(fixture.database, ["synthetic-user", "unknown-user"]);
		await seedConversation(fixture.database, {
			id: "session-current-group",
			kind: "group",
			title: "Current group",
		});
		await seedConversation(fixture.database, {
			id: "session-other-group",
			kind: "group",
			title: "Other group",
		});
		await seedConversation(fixture.database, {
			id: "session-private",
			kind: "private",
			title: "Private chat",
		});
		await seedConversation(fixture.database, {
			id: "session-unknown-group",
			kind: "group",
			title: "Unknown speaker group",
		});
		await seedMessage(fixture.database, {
			conversationId: "session-current-group",
			id: "current-group-message",
			senderDisplayName: "Synthetic speaker",
			senderUserId: "synthetic-user",
			text: "What did we plan for the weekend?",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T11:50:00.000Z",
			conversationId: "session-other-group",
			id: "other-group-message",
			senderDisplayName: "Synthetic speaker",
			senderUserId: "synthetic-user",
			text: "GROUP-CONTINUITY-MARKER",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T11:55:00.000Z",
			conversationId: "session-private",
			id: "private-message",
			senderDisplayName: "Synthetic speaker",
			senderUserId: "synthetic-user",
			text: "PRIVATE-SECRET-MARKER",
		});
		await seedMessage(fixture.database, {
			conversationId: "session-unknown-group",
			id: "unknown-group-message",
			text: "No canonical speaker",
		});
		const sections = await renderCrossSession(
			fixture,
			"durable-session-current-group",
			"current-group-message",
		);
		const cross = sections.find((section) => section.key === "cross-session")?.text ?? "";
		expect(cross).toContain("GROUP-CONTINUITY-MARKER");
		expect(cross).toContain("a private chat with you");
		expect(cross).not.toContain("PRIVATE-SECRET-MARKER");
		expect(cross).not.toContain("Private chat");
		const unknown = await renderCrossSession(
			fixture,
			"durable-session-unknown-group",
			"unknown-group-message",
		);
		expect(unknown.some((section) => section.key === "cross-session")).toBe(false);
		await fixture.policy.update({
			policy: { crossSession: { privateToGroup: "text" } },
			scope: "global",
		});
		const explicit = await renderCrossSession(
			fixture,
			"durable-session-current-group",
			"current-group-message",
		);
		expect(explicit.find((section) => section.key === "cross-session")?.text).toContain(
			"PRIVATE-SECRET-MARKER",
		);
	});
});

describe("Batch 5 acceptance: consolidation failure and recovery", () => {
	test("drops a malformed batch after three failures, audits it, and consolidates newer messages", async () => {
		let calls = 0;
		const fixture = await setup({
			complete: async () => {
				calls += 1;
				return calls <= 3 ? "this is not json" : validConsolidation("Newer messages consolidated.");
			},
			llmEnabled: () => true,
		});
		await fixture.policy.update({
			policy: {
				memoryConsolidation: { idleMs: 0, maxFailures: 3, minNewMessages: 1 },
			},
			scope: "global",
		});
		await seedConversation(fixture.database, { id: "session-drop" });
		for (let index = 0; index < 2; index += 1) {
			await seedMessage(fixture.database, {
				conversationId: "session-drop",
				id: `drop-old-${index}`,
				text: `Old message ${index}`,
			});
		}
		const first = await fixture.memory.consolidateConversation("session-drop");
		expect(first.status).toBe("failed");
		const second = await fixture.memory.consolidateConversation("session-drop");
		expect(second.status).toBe("failed");
		const third = await fixture.memory.consolidateConversation("session-drop");
		expect(third).toMatchObject({ reason: "max-failures", status: "dropped" });
		expect(
			fixture.audits.some(
				(entry) =>
					entry.action === "memory.consolidate.drop" &&
					entry.result === "failed" &&
					entry.targetKind === "memory",
			),
		).toBe(true);
		const [state] = await fixture.database
			.select()
			.from(memoryConsolidationState)
			.where(eq(memoryConsolidationState.conversationId, "session-drop"));
		expect(state).toMatchObject({
			droppedBatches: 1,
			watermarkMessageId: "drop-old-1",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T12:01:00.000Z",
			conversationId: "session-drop",
			id: "drop-new-0",
			text: "We decided the launch is Friday.",
		});
		await seedMessage(fixture.database, {
			at: "2026-11-13T12:02:00.000Z",
			conversationId: "session-drop",
			id: "drop-new-1",
			text: "I will bring the checklist.",
		});
		await fixture.memory.noteConversationActivity({ conversationId: "session-drop" });
		expect(await fixture.tasks.tick()).toBeGreaterThan(0);
		const warm = await fixture.memory.warmState("session-drop");
		expect(warm?.state?.summary).toBe("Newer messages consolidated.");
		const idempotent = await fixture.memory.consolidateConversation("session-drop");
		expect(idempotent).toMatchObject({ reason: "empty", status: "skipped" });
		const [after] = await fixture.database
			.select()
			.from(memoryConsolidationState)
			.where(eq(memoryConsolidationState.conversationId, "session-drop"));
		expect(after).toMatchObject({ pendingMessages: 0, watermarkMessageId: "drop-new-1" });
	});

	test("resumes a pending consolidation task after a service restart", async () => {
		const fixture = await setup();
		await fixture.policy.update({
			policy: { memoryConsolidation: { idleMs: 0, minNewMessages: 1 } },
			scope: "global",
		});
		await seedConversation(fixture.database, { id: "session-restart" });
		await seedMessage(fixture.database, {
			conversationId: "session-restart",
			id: "restart-message-0",
			text: "Remember that the code name is Aurora.",
		});
		await fixture.memory.noteConversationActivity({ conversationId: "session-restart" });
		const pending = await fixture.tasks.list("memory", {
			kind: "memory.consolidate",
			status: "pending",
		});
		expect(pending).toHaveLength(1);
		const restarted = memoryService(fixture, { complete: async () => undefined });
		restarted.registerTaskHandlers(fixture.tasks);
		expect(await fixture.tasks.tick()).toBeGreaterThan(0);
		const warm = await restarted.warmState("session-restart");
		expect(warm?.state).toBeDefined();
		const rows = await fixture.database
			.select()
			.from(messages)
			.where(eq(messages.conversationId, "session-restart"));
		expect(rows).toHaveLength(1);
	});
});

describe("Batch 5 acceptance: QA consistency", () => {
	test("recalls an earlier answer for a recurring English and CJK question", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-qa" });
		const memory = memoryService(fixture);
		await memory.create({
			content: "Answers already given in this chat.",
			conversationId: "session-qa",
			evidence: {
				state: {
					answers: [
						{
							answer: "Friday at 10:00.",
							answeredAt: "2026-11-13T09:00:00.000Z",
							key: "launch",
							question: "When is the launch date?",
						},
						{
							answer: "在周五上午十点。",
							answeredAt: "2026-11-13T10:00:00.000Z",
							key: "fa-hui",
							question: "发布会是什么时候？",
						},
					],
					version: 2,
				},
			},
			kind: "summary",
			scope: "conversation",
			summary: "Answers already given in this chat.",
		});
		const english = await memory.recallAnsweredQuestions(
			"session-qa",
			"Remind me, when is the launch date again?",
		);
		expect(english.map((entry) => entry.answer)).toContain("Friday at 10:00.");
		const chinese = await memory.recallAnsweredQuestions("session-qa", "发布会几点开始？");
		expect(chinese.map((entry) => entry.answer)).toContain("在周五上午十点。");
	});
});
