import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import {
	chatObjects,
	conversations,
	memories,
	memoryConsolidationState,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	users,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import { createLogger, type Logger } from "../src/logging.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { MemoryService, extractMemoryTokens } from "../src/services/memory-service.ts";
import { WARM_STATE_EVIDENCE_KEY } from "../src/services/memory-consolidation.ts";
import { PluginTaskService } from "../src/services/plugin-task-service.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error" });
const now = () => new Date("2026-11-13T12:00:00.000Z");

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function setup(
	options: {
		readonly audit?: (entry: AuditEntry) => Promise<void>;
		readonly complete?: (prompt: string) => Promise<string | undefined>;
		readonly llmEnabled?: boolean;
		readonly logger?: Logger;
		readonly tasks?: PluginTaskService;
	} = {},
): Promise<{
	database: TsukaimaDatabase;
	memory: MemoryService;
	policy: ConversationPolicyService;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-memory-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const policy = new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger: options.logger ?? logger,
	});
	const memory = new MemoryService({
		...(options.audit === undefined ? {} : { audit: options.audit }),
		database: () => database,
		...(options.complete === undefined ? {} : { complete: options.complete }),
		...(options.llmEnabled === undefined ? {} : { llmEnabled: () => options.llmEnabled === true }),
		logger: options.logger ?? logger,
		now,
		policyService: policy,
		...(options.tasks === undefined ? {} : { tasks: options.tasks }),
	});
	return { database, memory, policy };
}

async function seedSession(
	database: TsukaimaDatabase,
	input: {
		readonly id: string;
		readonly kind?: "private" | "group" | "workspace";
		readonly messageCount?: number;
	},
): Promise<void> {
	await database.insert(conversations).values({
		durableConversationId: `durable-${input.id}`,
		id: input.id,
		kind: input.kind ?? "private",
		title: input.id,
	});
	const count = input.messageCount ?? 0;
	for (let index = 0; index < count; index += 1) {
		const content = [
			"I love matcha drinks",
			"TODO: buy beans tomorrow",
			"Remember that the code name is Aurora",
			"We decided to use SQLite",
			"Should we invite the group?",
		][index % 5]!;
		await database.insert(messages).values({
			contentText: `${content} (#${index})`,
			conversationId: input.id,
			direction: index % 2 === 0 ? "inbound" : "outbound",
			id: `${input.id}-message-${index}`,
			kind: "onebot-v11",
			occurredAt: new Date(Date.parse("2026-11-13T00:00:00.000Z") + index * 1_000).toISOString(),
			senderExternalId: index % 2 === 0 ? "user-1" : "tsukaima",
			senderUserId: null,
		});
	}
}

describe("memory lifecycle", () => {
	test("supports create, review transitions, pin, revoke, list filters, and tombstones", async () => {
		const { memory } = await setup();
		const pending = await memory.create({
			kind: "fact",
			scope: "global",
			status: "pending",
			summary: "The build uses SQLite",
		});
		expect(pending.memory.status).toBe("pending");
		expect((await memory.list({ status: "pending" })).map((row) => row.id)).toEqual([
			pending.memory.id,
		]);

		const approved = await memory.approve(pending.memory.id);
		expect(approved.status).toBe("active");
		const pinned = await memory.pin(approved.id, true);
		expect(pinned.pinned).toBe(1);
		expect((await memory.list({ query: "SQLite" })).map((row) => row.id)).toContain(approved.id);

		const rejected = await memory.create({
			kind: "fact",
			scope: "global",
			status: "pending",
			summary: "Reject this candidate",
		});
		expect((await memory.reject(rejected.memory.id)).status).toBe("rejected");
		await expect(memory.approve(rejected.memory.id)).rejects.toThrow("Only pending");

		const revoked = await memory.revoke(approved.id);
		expect(revoked.status).toBe("revoked");
		expect(revoked.revokedAt).not.toBeNull();
		expect(await memory.get(approved.id)).toMatchObject({ status: "revoked" });
	});

	test("dedupes identical memories and supersedes contradictory facts", async () => {
		const { memory } = await setup();
		const first = await memory.create({
			confidence: 0.5,
			importance: 0.4,
			kind: "preference",
			scope: "global",
			summary: "Prefers tea",
		});
		const duplicate = await memory.create({
			confidence: 0.8,
			importance: 0.7,
			kind: "preference",
			scope: "global",
			summary: "Prefers tea",
		});
		expect(duplicate.merged).toBe(true);
		expect(duplicate.memory.id).toBe(first.memory.id);
		expect(duplicate.memory.confidence).toBeGreaterThan(first.memory.confidence);
		expect(duplicate.memory.importance).toBe(0.7);
		expect((await memory.list()).filter((row) => row.kind === "preference")).toHaveLength(1);
		expect(JSON.parse(duplicate.memory.evidenceJson ?? "{}")).toMatchObject({ occurrences: 2 });

		const contradiction = await memory.create({
			kind: "preference",
			scope: "global",
			summary: "Dislikes tea",
		});
		const old = await memory.get(first.memory.id);
		expect(old?.status).toBe("revoked");
		expect(contradiction.memory.status).toBe("active");
	});

	test("expires due todos and excludes them from recall", async () => {
		const { memory } = await setup();
		const due = await memory.create({
			expiresAt: "2026-11-13T11:00:00.000Z",
			kind: "todo",
			scope: "conversation",
			summary: "Buy beans",
		});
		const future = await memory.create({
			expiresAt: "2026-11-20T11:00:00.000Z",
			kind: "todo",
			scope: "global",
			summary: "Buy rice",
		});
		expect(await memory.expireDue()).toBe(1);
		expect((await memory.get(due.memory.id))?.status).toBe("expired");
		expect((await memory.get(future.memory.id))?.status).toBe("active");
		const recalled = await memory.recall({ query: "Buy", scopeFilter: undefined });
		expect(recalled.map((entry) => entry.memory.id)).not.toContain(due.memory.id);
	});
});

describe("background extraction", () => {
	test("keeps workspace transcripts out of the chat memory graph", async () => {
		const { database, memory } = await setup();
		await seedSession(database, { id: "session-work", kind: "workspace", messageCount: 3 });
		expect(await memory.extractForConversation("session-work")).toEqual({
			candidates: 0,
			written: 0,
		});
		expect(await memory.compactSession({ conversationId: "session-work" })).toEqual({
			created: false,
			memory: undefined,
		});
		expect(await database.select().from(memories)).toHaveLength(0);
	});

	test("runs through tasks.create with the deterministic fallback extractor", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-memory-task-"));
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
			now: () => Date.parse("2026-11-13T12:00:00.000Z"),
		});
		const memory = new MemoryService({
			database: () => database,
			logger,
			now,
			policyService: policy,
			tasks,
		});
		memory.registerTaskHandlers(tasks);
		await policy.update({
			policy: { memoryConsolidation: { idleMs: 0, minNewMessages: 1 } },
			scope: "global",
		});
		await seedSession(database, { id: "session-extract", messageCount: 3 });
		await database.insert(messages).values({
			contentText: "TODO: buy beans tomorrow",
			conversationId: "session-extract",
			direction: "inbound",
			id: "session-extract-extra-todo",
			kind: "onebot-v11",
			occurredAt: "2026-11-13T00:00:03.000Z",
			senderUserId: null,
		});
		await memory.scheduleExtraction({ conversationId: "session-extract" });
		expect(await tasks.tick()).toBeGreaterThan(0);
		const rows = await database
			.select()
			.from(memories)
			.where(eq(memories.conversationId, "session-extract"));
		expect(rows.some((row) => row.kind === "summary")).toBe(true);
		expect(rows.some((row) => row.kind === "preference" && row.summary.includes("matcha"))).toBe(
			true,
		);
		const todo = rows.find((row) => row.kind === "todo");
		expect(todo?.expiresAt).not.toBeNull();
		expect(rows.some((row) => row.summary.includes("Aurora"))).toBe(true);
		expect(rows.every((row) => row.status === "active")).toBe(true);
		expect(rows.every((row) => row.sourceMessageId !== null)).toBe(true);
	});

	test("uses strict LLM JSON when configured and validates malformed output", async () => {
		const { database, memory, policy } = await setup({
			complete: async () =>
				JSON.stringify([
					{
						confidence: 0.9,
						content: "The user's project is called Aurora.",
						importance: 0.8,
						kind: "fact",
						summary: "Project is called Aurora",
					},
				]),
			llmEnabled: true,
		});
		await policy.update({
			policy: { memoryExtractModel: "test-extract" },
			scope: "global",
		});
		await seedSession(database, { id: "session-llm", messageCount: 1 });
		const result = await memory.extractForConversation("session-llm");
		expect(result.written).toBeGreaterThan(0);
		const rows = await database.select().from(memories);
		expect(rows).toEqual([
			expect.objectContaining({
				extractionModel: "test-extract",
				status: "active",
				summary: "Project is called Aurora",
			}),
		]);

		const invalid = new MemoryService({
			complete: async () => "not json",
			database: () => database,
			llmEnabled: () => true,
			logger,
			now,
			policyService: policy,
		});
		await database.delete(memories);
		await expect(invalid.extractForConversation("session-llm")).resolves.toMatchObject({
			written: expect.any(Number),
		});
	});

	test("honors memoryEnabled and sharedMemoryWriteEnabled review gates", async () => {
		const { database, memory, policy } = await setup();
		await seedSession(database, { id: "session-gated", messageCount: 2 });
		await policy.update({ policy: { memoryEnabled: false }, scope: "global" });
		expect(await memory.extractForConversation("session-gated")).toEqual({
			candidates: 0,
			written: 0,
		});
		await policy.update({ policy: { memoryEnabled: true }, scope: "global" });
		const extracted = await memory.extractForConversation("session-gated");
		expect(extracted.written).toBeGreaterThan(0);

		const group = await setup();
		await seedSession(group.database, { id: "session-group", kind: "group", messageCount: 1 });
		await group.policy.update({
			policy: { sharedMemoryWriteEnabled: false },
			scope: "global",
		});
		const groupResult = await group.memory.extractForConversation("session-group");
		expect(groupResult.written).toBeGreaterThan(0);
		const rows = await group.database
			.select()
			.from(memories)
			.where(eq(memories.conversationId, "session-group"));
		expect(rows).toEqual([
			expect.objectContaining({
				scope: "conversation",
				status: "pending",
				visibility: "private",
			}),
		]);
	});

	test("keeps automatic group extraction local even when the model requests global scope", async () => {
		const { database, memory } = await setup({
			complete: async (prompt) => {
				expect(prompt).not.toContain("synthetic tool output");
				return JSON.stringify([
					{
						confidence: 0.9,
						content: "The group chose the Aurora theme.",
						importance: 0.8,
						kind: "fact",
						scope: "global",
						summary: "Aurora is the chosen theme",
					},
				]);
			},
			llmEnabled: true,
		});
		await seedSession(database, { id: "group-local", kind: "group", messageCount: 1 });
		await database.insert(messages).values({
			contentText: "synthetic tool output",
			conversationId: "group-local",
			direction: "outbound",
			id: "tool-local",
			kind: "tool",
			occurredAt: "2026-11-13T00:00:10.000Z",
		});
		expect(await memory.extractForConversation("group-local")).toEqual({
			candidates: 1,
			written: 1,
		});
		expect(await database.select().from(memories)).toEqual([
			expect.objectContaining({
				conversationId: "group-local",
				scope: "conversation",
				sourceConversationId: "group-local",
				sourceMessageId: "group-local-message-0",
				visibility: "private",
			}),
		]);
	});

	test("does not infer a memory when the extractor returns an empty array", async () => {
		const { database, memory } = await setup({
			complete: async () => "[]",
			llmEnabled: true,
		});
		await seedSession(database, { id: "session-empty", messageCount: 1 });
		expect(await memory.extractForConversation("session-empty")).toEqual({
			candidates: 0,
			written: 0,
		});
	});
});

describe("additive compaction", () => {
	test("writes a summary memory with warm state without deleting raw messages", async () => {
		const { database, memory } = await setup();
		await seedSession(database, { id: "session-compact", messageCount: 27 });
		const first = await memory.compactSession({ conversationId: "session-compact" });
		expect(first.created).toBe(true);
		expect(first.memory?.kind).toBe("summary");
		const evidence = JSON.parse(first.memory?.evidenceJson ?? "{}");
		expect(evidence).toMatchObject({
			compactedThroughMessageId: "session-compact-message-26",
			messageCount: 27,
			model: "deterministic",
			promptVersion: "memory-consolidate-v2",
		});
		expect(evidence.decisions).toBeUndefined();
		expect(evidence.todos).toBeUndefined();
		expect(evidence.openThreads).toBeUndefined();
		expect(evidence.topic).toBeUndefined();
		expect(evidence.state).toMatchObject({ version: 2 });
		const raw = await database
			.select()
			.from(messages)
			.where(eq(messages.conversationId, "session-compact"));
		expect(raw).toHaveLength(27);
		const second = await memory.compactSession({ conversationId: "session-compact" });
		expect(second.created).toBe(false);
		expect(second.memory?.id).toBe(first.memory?.id);
		const summaries = await database.select().from(memories).where(eq(memories.kind, "summary"));
		expect(summaries).toHaveLength(1);
	});

	test("honors throughMessageId and keeps the watermark at the requested message", async () => {
		const { database, memory } = await setup();
		await seedSession(database, { id: "session-through", messageCount: 9 });
		const capped = await memory.compactSession({
			conversationId: "session-through",
			throughMessageId: "session-through-message-3",
		});
		expect(capped.created).toBe(true);
		const evidence = JSON.parse(capped.memory?.evidenceJson ?? "{}");
		expect(evidence).toMatchObject({
			compactedThroughMessageId: "session-through-message-3",
			messageCount: 4,
		});
		expect(
			await memory.compactSession({
				conversationId: "session-through",
				throughMessageId: "missing",
			}),
		).toEqual({
			created: false,
			memory: capped.memory,
		});
	});

	test("logs concrete parse error and writes deterministic fallback on max consolidation failures", async () => {
		const auditEntries: AuditEntry[] = [];
		const logWarnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
		const testLogger = createLogger({
			level: "trace",
			sink: (entry) => {
				if (entry.level === "warn") {
					logWarnings.push({ fields: entry.fields, message: entry.message });
				}
			},
		});

		const { database, memory } = await setup({
			audit: async (entry) => {
				auditEntries.push(entry);
			},
			complete: async () => "invalid output without json braces",
			llmEnabled: true,
			logger: testLogger,
		});

		await seedSession(database, { id: "session-fail", messageCount: 10 });

		// Attempt 1: fails and logs concrete parse reason
		const run1 = await memory.consolidateConversation("session-fail");
		expect(run1.status).toBe("failed");
		if (run1.status !== "failed") throw new Error("Expected failed");
		expect(run1.reason).toContain("no JSON object found");
		expect(
			logWarnings.some((w) => w.message === "failed to parse memory consolidation output"),
		).toBe(true);
		const lastWarning = logWarnings.findLast(
			(w) => w.message === "failed to parse memory consolidation output",
		);
		expect(lastWarning?.fields?.error).toContain("no JSON object found");

		// Attempt 2: fails again
		const run2 = await memory.consolidateConversation("session-fail");
		expect(run2.status).toBe("failed");

		// Attempt 3: hits maxFailures (default 3), drops batch, writes fallback warm state & heuristic memories
		const run3 = await memory.consolidateConversation("session-fail");
		expect(run3.status).toBe("dropped");
		if (run3.status !== "dropped") throw new Error("Expected dropped");
		expect(run3.reason).toBe("max-failures");

		// Verify fallback warm state was written
		const warmMemories = await database
			.select()
			.from(memories)
			.where(and(eq(memories.conversationId, "session-fail"), eq(memories.kind, "summary")));
		expect(warmMemories).toHaveLength(1);
		const evidence = JSON.parse(warmMemories[0]?.evidenceJson ?? "{}");
		expect(evidence.model).toBe("deterministic-fallback");
		expect(evidence.state.version).toBe(2);

		// Verify fallback heuristic candidates were written
		const durableMemories = await database
			.select()
			.from(memories)
			.where(and(eq(memories.conversationId, "session-fail"), ne(memories.kind, "summary")));
		expect(durableMemories.length).toBeGreaterThan(0);
		expect(
			durableMemories.some((m) => m.summary.includes("Aurora") || m.summary.includes("buy beans")),
		).toBe(true);

		// Verify watermark was advanced past the batch
		const [stateRow] = await database
			.select()
			.from(memoryConsolidationState)
			.where(eq(memoryConsolidationState.conversationId, "session-fail"));
		expect(stateRow?.watermarkMessageId).toBe("session-fail-message-9");
		expect(stateRow?.droppedBatches).toBe(1);
		expect(stateRow?.lastError).toContain("no JSON object found");

		// Verify audit drop was recorded
		expect(auditEntries.some((entry) => entry.action === "memory.consolidate.drop")).toBe(true);
	});

	test("handles 3-4 char CJK tokens, stopword filtering, and long unpunctuated CJK recall", async () => {
		const short4 = extractMemoryTokens("我想减肥");
		expect(short4).toContain("减肥");
		expect(short4).toContain("我想减肥");

		const short3 = extractMemoryTokens("吃不了");
		expect(short3).toContain("吃不");
		expect(short3).toContain("不了");

		const longQuery = "哎呀我其实一直都在纠结这个那个到底是不是应该这样因为我最近总是胃疼";
		const longTokens = extractMemoryTokens(longQuery);
		expect(longTokens).toContain("胃疼");
		expect(longTokens).not.toContain("其实");
		expect(longTokens).not.toContain("这个");
		expect(longTokens).not.toContain("那个");

		const { database, memory } = await setup();
		await database.insert(conversations).values({
			durableConversationId: "durable-cjk-recall",
			id: "session-cjk-recall",
			kind: "private",
			title: "CJK Recall",
		});
		await memory.create({
			content: "体检医生提醒最近忌生冷因为总是胃疼",
			conversationId: "session-cjk-recall",
			createdBy: "agent",
			kind: "fact",
			scope: "conversation",
			summary: "最近忌生冷胃疼注意保暖",
		});
		await memory.create({
			content: "正在控制饮食打算夏天前减肥",
			conversationId: "session-cjk-recall",
			createdBy: "agent",
			kind: "fact",
			scope: "conversation",
			summary: "最近目标控制饮食减肥",
		});

		const stomachHits = await memory.recall({
			conversationId: "session-cjk-recall",
			query: longQuery,
		});
		expect(stomachHits[0]?.memory.summary).toContain("胃疼");

		const dietHits = await memory.recall({
			conversationId: "session-cjk-recall",
			query: "我想减肥",
		});
		expect(dietHits[0]?.memory.summary).toContain("减肥");
	});

	test("never resurrects revoked or rejected dedupeKey rows from background tasks, while explicit allowRevive succeeds", async () => {
		const { database, memory } = await setup();
		await database.insert(conversations).values({
			durableConversationId: "durable-revive-guard",
			id: "session-revive-guard",
			kind: "private",
			title: "Revive guard",
		});

		const created = await memory.create({
			content: "Do not keep this joke fact",
			conversationId: "session-revive-guard",
			createdBy: "task",
			kind: "fact",
			scope: "conversation",
			status: "active",
			summary: "Temporary joke fact",
		});
		await memory.revoke(created.memory.id);

		const pendingRow = await memory.create({
			content: "Rejected review candidate",
			conversationId: "session-revive-guard",
			createdBy: "task",
			kind: "preference",
			scope: "conversation",
			status: "pending",
			summary: "Rejected style candidate",
		});
		await memory.reject(pendingRow.memory.id);

		// Background task creating matching dedupeKeys must not flip status back to active.
		const attemptedRevoked = await memory.create({
			content: "Do not keep this joke fact",
			conversationId: "session-revive-guard",
			createdBy: "task",
			kind: "fact",
			scope: "conversation",
			status: "active",
			summary: "Temporary joke fact",
		});
		expect(attemptedRevoked.merged).toBe(false);
		expect(attemptedRevoked.memory.status).toBe("revoked");
		expect((await memory.get(created.memory.id))?.status).toBe("revoked");

		const attemptedRejected = await memory.create({
			content: "Rejected review candidate",
			conversationId: "session-revive-guard",
			createdBy: "task",
			kind: "preference",
			scope: "conversation",
			status: "active",
			summary: "Rejected style candidate",
		});
		expect(attemptedRejected.merged).toBe(false);
		expect(attemptedRejected.memory.status).toBe("rejected");
		expect((await memory.get(pendingRow.memory.id))?.status).toBe("rejected");

		// Explicit manual/tool re-save with allowRevive can re-activate when not createdBy='task'.
		const revived = await memory.create({
			allowRevive: true,
			content: "User explicitly asked to remember again",
			conversationId: "session-revive-guard",
			createdBy: "agent",
			kind: "fact",
			scope: "conversation",
			status: "active",
			summary: "Temporary joke fact",
		});
		expect(revived.merged).toBe(true);
		expect(revived.memory.status).toBe("active");
	});

	test("uses bound persona name in consolidation prompt, inherits cross-day warmState, and strips assistant/meta-rule leakage", async () => {
		const promptsSeen: string[] = [];
		const { database, memory, policy } = await setup({
			complete: async (prompt) => {
				promptsSeen.push(prompt);
				return JSON.stringify({
					memories: [
						{
							confidence: 0.9,
							importance: 0.8,
							kind: "style",
							summary: "每条消息必须带表情包",
						},
						{
							confidence: 0.9,
							importance: 0.8,
							kind: "fact",
							summary: "AI助手设定是温柔回答问题",
						},
						{
							confidence: 0.9,
							importance: 0.8,
							kind: "preference",
							summary: "用户喜欢喝茉莉花茶",
						},
					],
					state: {
						answers: [],
						atmosphere: "自然轻松",
						commitments: [
							{ key: "meta-rule", owner: "self", status: "open", text: "每条回复都要带表情包" },
							{ key: "real-plan", owner: "user-1", status: "open", text: "明晚带笔记过来" },
						],
						glossary: [],
						people: [],
						summary: "用户分享了自己喜欢喝茉莉花茶。",
						topics: ["茶饮"],
					},
				});
			},
			llmEnabled: true,
		});

		const persona = await policy.upsertPersona({
			id: "persona-kuroha",
			name: "Kuroha",
			prompt: "Speak directly in character.",
			summary: "Kuroha",
		});
		await database.insert(chatObjects).values({
			id: "chat-consolidate-rollover",
			kind: "private",
			title: "Consolidate rollover",
		});
		await database.insert(users).values({
			displayName: "SyntheticFriend",
			id: "u-day1",
			kind: "human",
		});
		await policy.bindPersona({
			chatObjectId: "chat-consolidate-rollover",
			personaId: persona.id,
			scope: "chat-object",
		});

		await database.insert(conversations).values([
			{
				chatObjectId: "chat-consolidate-rollover",
				durableConversationId: "durable-cons-d1",
				id: "session-cons-d1",
				isReceiving: 0,
				kind: "private",
				title: "2026-11-12",
				updatedAt: "2026-11-12T10:00:00.000Z",
			},
			{
				chatObjectId: "chat-consolidate-rollover",
				durableConversationId: "durable-cons-d2",
				id: "session-cons-d2",
				isReceiving: 1,
				kind: "private",
				title: "2026-11-13",
				updatedAt: "2026-11-13T10:00:00.000Z",
			},
		]);

		await memory.create({
			content: "Day 1 warm summary",
			conversationId: "session-cons-d1",
			createdBy: "task",
			dedupeKey: "warm:session-cons-d1",
			evidence: {
				compactedThroughAt: "2026-11-13T11:50:00.000Z",
				compactedThroughMessageId: "msg-day1-final",
				[WARM_STATE_EVIDENCE_KEY]: {
					answers: [],
					atmosphere: "温和",
					commitments: [],
					glossary: [],
					people: [
						{
							aliases: [],
							key: "u-day1",
							name: "SyntheticFriend",
							notes: ["上周刚搬完家"],
						},
					],
					summary: "昨天聊过搬家后的整理。",
					topics: ["搬家"],
					version: 2,
				},
			},
			kind: "summary",
			scope: "conversation",
			status: "active",
			summary: "昨天聊过搬家后的整理。",
		});

		// Day 2 has messages earlier than Day 1's synthetic watermark timestamp to verify Day 2 cursor stays independent.
		await database.insert(messages).values([
			{
				contentText: "我平时比较喜欢喝茉莉花茶，明晚把笔记带给你",
				conversationId: "session-cons-d2",
				direction: "inbound",
				id: "msg-d2-1",
				kind: "onebot-v11",
				occurredAt: "2026-11-13T08:00:00.000Z",
				senderDisplayName: "SyntheticFriend",
				senderUserId: "u-day1",
			},
			{
				contentText: "好呀，茶凉了可就不好喝了。",
				conversationId: "session-cons-d2",
				direction: "outbound",
				id: "msg-d2-2",
				kind: "onebot-v11",
				occurredAt: "2026-11-13T08:01:00.000Z",
			},
		]);

		const consolidated = await memory.consolidateConversation("session-cons-d2");
		expect(consolidated.status).toBe("consolidated");
		if (consolidated.status !== "consolidated") throw new Error("Expected consolidated");
		expect(consolidated.written).toBe(1);

		const prompt = promptsSeen[0] ?? "";
		expect(prompt).toContain("] Kuroha: 好呀，茶凉了可就不好喝了。");
		expect(prompt).not.toContain("] (assistant):");
		expect(prompt).toContain("昨天聊过搬家后的整理。");

		const d2Warm = await memory.warmState("session-cons-d2");
		expect(d2Warm?.state?.people.map((person) => person.name)).toContain("SyntheticFriend");
		expect(d2Warm?.state?.commitments.map((item) => item.text)).toEqual(["明晚带笔记过来"]);

		const rows = await database
			.select()
			.from(memories)
			.where(and(eq(memories.conversationId, "session-cons-d2"), ne(memories.kind, "summary")));
		expect(rows.map((row) => row.summary)).toEqual(["用户喜欢喝茉莉花茶"]);
	});
});
