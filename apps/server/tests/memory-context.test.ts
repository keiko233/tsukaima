import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	conversations,
	memories,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { createLogger } from "../src/logging.ts";
import { DrizzleContextProvider } from "../src/services/context-provider.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { MemoryService } from "../src/services/memory-service.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error" });
const fixedNow = new Date("2026-11-13T12:00:00.000Z");
const vectorEmbed = async (texts: readonly string[]) => ({
	modelId: "mock-embed",
	vectors: texts.map((text) => (/(?:latte|matcha)/iu.test(text) ? [1, 0] : [0, 1])),
});

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function setup(): Promise<{
	database: TsukaimaDatabase;
	policy: ConversationPolicyService;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-memory-context-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const policy = new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
	return { database, policy };
}

async function insertConversation(
	database: TsukaimaDatabase,
	input: { readonly id: string; readonly kind?: "private" | "group" },
): Promise<void> {
	await database.insert(conversations).values({
		durableConversationId: `durable-${input.id}`,
		id: input.id,
		kind: input.kind ?? "private",
		title: input.id,
	});
	await database.insert(messages).values({
		contentText: "I want a latte",
		conversationId: input.id,
		direction: "inbound",
		id: `${input.id}-message`,
		kind: "onebot-v11",
		occurredAt: fixedNow.toISOString(),
	});
}

function provider(
	database: TsukaimaDatabase,
	policy: ConversationPolicyService,
	options: {
		readonly embed?: (texts: readonly string[]) => Promise<{
			modelId: string;
			vectors: readonly (readonly number[])[];
		}>;
		readonly memoryTopK?: number;
	} = {},
): DrizzleContextProvider {
	const memory = new MemoryService({
		database: () => database,
		...(options.embed === undefined ? {} : { embed: options.embed }),
		logger,
		now: () => fixedNow,
		policyService: policy,
	});
	return new DrizzleContextProvider({
		budgetChars: 1_200,
		database: () => database,
		logger,
		memoryService: memory,
		memoryTopK: options.memoryTopK ?? 2,
		policyService: policy,
	});
}

describe("hybrid memory retrieval", () => {
	test("uses stored embeddings without a network call on the prompt-render path", async () => {
		const { database, policy } = await setup();
		await insertConversation(database, { id: "session-vector" });
		let embedCalls = 0;
		const memory = new MemoryService({
			database: () => database,
			embed: async (texts) => {
				embedCalls += 1;
				return vectorEmbed(texts);
			},
			logger,
			now: () => fixedNow,
			policyService: policy,
		});
		const context = new DrizzleContextProvider({
			budgetChars: 1_200,
			database: () => database,
			logger,
			memoryService: memory,
			memoryTopK: 1,
			policyService: policy,
		});
		await database.insert(memories).values([
			{
				content: "Loves matcha latte",
				createdBy: "agent",
				embeddingJson: JSON.stringify([1, 0]),
				embeddingModel: "mock-embed",
				id: "mem-matcha",
				importance: 0.1,
				kind: "preference",
				scope: "global",
				summary: "Loves matcha latte",
			},
			{
				content: "Uses Postgres",
				createdBy: "agent",
				embeddingJson: JSON.stringify([0, 1]),
				embeddingModel: "mock-embed",
				id: "mem-postgres",
				importance: 0.95,
				kind: "fact",
				scope: "global",
				summary: "Uses Postgres",
			},
		]);
		const text = await context.renderMemories("durable-session-vector");
		expect(embedCalls).toBe(0);
		expect(text).toContain("Loves matcha latte");
		expect(text).not.toContain("Uses Postgres");
		const cached = await database.select().from(memories).where(eq(memories.id, "mem-matcha"));
		expect(cached[0]?.embeddingModel).toBe("mock-embed");
	});

	test("applies pinned and importance weighting", async () => {
		const { database, policy } = await setup();
		await insertConversation(database, { id: "session-pin" });
		const context = provider(database, policy);
		await database.insert(memories).values([
			{
				content: "Low importance but pinned",
				createdBy: "agent",
				id: "mem-pinned",
				importance: 0.1,
				kind: "fact",
				pinned: 1,
				scope: "global",
				summary: "Pinned fact",
			},
			{
				content: "High importance unpinned",
				createdBy: "agent",
				id: "mem-important",
				importance: 0.95,
				kind: "fact",
				scope: "global",
				summary: "Important fact",
			},
		]);
		const text = await context.renderMemories("durable-session-pin");
		expect(text).toContain("Pinned fact");
	});

	test("renders structured warm state and long-term memories inside the budget", async () => {
		const { database, policy } = await setup();
		await insertConversation(database, { id: "session-warm" });
		const context = provider(database, policy);
		await database.insert(memories).values([
			{
				content: "Warm summary",
				conversationId: "session-warm",
				createdBy: "task",
				evidenceJson: JSON.stringify({
					compactedThroughMessageId: "session-warm-message",
					state: {
						answers: [],
						atmosphere: "Dry humor, short replies.",
						commitments: [],
						glossary: [],
						people: [],
						summary: "Warm session summary through 2026-11-13.",
						topics: ["sqlite", "beans"],
						version: 2,
					},
				}),
				id: "mem-warm",
				importance: 0.65,
				kind: "summary",
				scope: "conversation",
				summary: "Warm session summary through 2026-11-13.",
			},
			{
				content: "Long-term preference",
				createdBy: "agent",
				id: "mem-long",
				importance: 0.8,
				kind: "preference",
				scope: "global",
				summary: "Prefers oolong tea",
			},
		]);
		const text = await context.renderMemories("durable-session-warm");
		if (text === undefined) throw new Error("Expected memory text");
		expect(text).toContain("Conversation state:");
		expect(text).toContain("- Topics: sqlite, beans");
		expect(text).toContain("Known memories, most relevant first:");
		expect(text).not.toContain("Recent conversation window:");
		expect(text.length).toBeLessThanOrEqual(1_200);
	});

	test("gates shared memories in groups and disables recall when memory is off", async () => {
		const { database, policy } = await setup();
		await insertConversation(database, { id: "session-group", kind: "group" });
		const context = provider(database, policy);
		await database.insert(memories).values([
			{
				content: "Shared marker",
				createdBy: "agent",
				id: "mem-shared",
				kind: "fact",
				scope: "global",
				summary: "MARKER-SHARED",
				visibility: "shared",
			},
			{
				content: "Private marker",
				createdBy: "agent",
				id: "mem-private",
				kind: "fact",
				scope: "global",
				summary: "MARKER-PRIVATE",
				visibility: "private",
			},
			{
				content: "Conversation marker",
				conversationId: "session-group",
				createdBy: "agent",
				id: "mem-conversation",
				kind: "fact",
				scope: "conversation",
				summary: "MARKER-CONVERSATION",
			},
		]);
		await policy.update({ policy: { sharedMemoryEnabled: false }, scope: "global" });
		const text = await context.renderMemories("durable-session-group");
		if (text === undefined) throw new Error("Expected memory text");
		expect(text).toContain("MARKER-PRIVATE");
		expect(text).toContain("MARKER-CONVERSATION");
		expect(text).not.toContain("MARKER-SHARED");

		await policy.update({ policy: { memoryEnabled: false }, scope: "global" });
		expect(await context.renderMemories("durable-session-group")).toBeUndefined();
	});

	test("injects keyword-matched glossary and persona memories into the latest turn context", async () => {
		const { database, policy } = await setup();
		await insertConversation(database, { id: "session-keyword" });
		const context = provider(database, policy, { memoryTopK: 2 });
		await database.insert(memories).values([
			{
				content: "Unrelated pinned memory",
				createdBy: "agent",
				id: "mem-unrelated-pin",
				importance: 0.95,
				kind: "fact",
				pinned: 1,
				scope: "global",
				summary: "Unrelated pinned note about weather",
			},
			{
				content: "热梗: 尊嘟假嘟 意思是 真的假的",
				createdBy: "agent",
				id: "mem-meme",
				importance: 0.4,
				kind: "glossary",
				scope: "global",
				summary: "热梗: 尊嘟假嘟 (真的假的)",
			},
		]);

		const sections = await context.renderTurnContext({
			conversationId: "durable-session-keyword",
			inputs: [{ envelopeId: "env-1", text: "今天群里都在刷尊嘟假嘟这个热梗" }],
			nowMs: fixedNow.getTime(),
			triggers: [{ classification: "direct" }],
		});
		const memorySection = sections.find((section) => section.key === "memories");
		expect(memorySection).toBeDefined();
		expect(memorySection?.text).toContain("[id:mem-meme]");
		expect(memorySection?.text).toContain("尊嘟假嘟");
	});
});
