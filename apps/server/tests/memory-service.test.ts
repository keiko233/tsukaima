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
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { MemoryService } from "../src/services/memory-service.ts";
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
		readonly complete?: (prompt: string) => Promise<string | undefined>;
		readonly llmEnabled?: boolean;
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
		logger,
	});
	const memory = new MemoryService({
		database: () => database,
		...(options.complete === undefined ? {} : { complete: options.complete }),
		...(options.llmEnabled === undefined ? {} : { llmEnabled: () => options.llmEnabled === true }),
		logger,
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
		await seedSession(database, { id: "session-extract", messageCount: 3 });
		await memory.scheduleExtraction({ conversationId: "session-extract" });
		expect(await tasks.tick()).toBeGreaterThan(0);
		const rows = await database
			.select()
			.from(memories)
			.where(eq(memories.conversationId, "session-extract"));
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
			compactedThroughMessageId: "session-compact-message-6",
			messageCount: 7,
		});
		expect(Array.isArray(evidence.decisions)).toBe(true);
		expect(Array.isArray(evidence.todos)).toBe(true);
		expect(Array.isArray(evidence.openThreads)).toBe(true);
		expect(typeof evidence.topic).toBe("string");
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
});
