import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDurableConversationHost, createFakeModel } from "@tsukaima/core";
import {
	conversations,
	messages,
	openDomainDatabase,
	migrateDomainDatabase,
	personaBindings,
	personas,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { openDurableStorage } from "@tsukaima/durable";
import { createLogger } from "../src/logging.ts";
import {
	DrizzleContextProvider,
	type ContextCompletionRequest,
	type DrizzleContextProviderOptions,
} from "../src/services/context-provider.ts";
import { DEFAULT_PROMPTS } from "../src/services/prompt-defaults.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error", target: "tsukaima::test" });

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function openFixture(): Promise<{ database: TsukaimaDatabase; directory: string }> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-1-server-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return { database, directory };
}

function provider(
	database: TsukaimaDatabase,
	overrides: Partial<DrizzleContextProviderOptions> = {},
): DrizzleContextProvider {
	return new DrizzleContextProvider({ database: () => database, logger, ...overrides });
}

const groupEnvelope = (id: string, text: string, sender: string, platformId: string) => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { groupId: "group-1", kind: "group" as const, peerId: platformId },
	id,
	mentions: [],
	parts: [{ text, type: "text" as const }],
	sender: { displayName: sender, id: platformId, platformId },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

type ChatKind = "group" | "private" | "webui" | "workspace";

async function linkConversation(
	database: TsukaimaDatabase,
	durableConversationId: string,
	kind: ChatKind,
): Promise<string> {
	const sessionId = `session-${durableConversationId}`;
	await database.insert(conversations).values({
		durableConversationId,
		id: sessionId,
		kind,
		title: `Synthetic ${kind} chat`,
		updatedAt: new Date().toISOString(),
	});
	return sessionId;
}

type CapturedRequest = {
	readonly messages?: readonly {
		readonly content?: unknown;
		readonly role?: string;
	}[];
};

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

const captureModel = (
	model: ReturnType<typeof createFakeModel>,
	contexts: CapturedRequest[],
): void => {
	const stream = model.models.streamSimple.bind(model.models);
	model.models.streamSimple = (target, context, options) => {
		contexts.push(context as CapturedRequest);
		return stream(target, context, options);
	};
};

describe("Batch 1 acceptance: full persona budget", () => {
	test("delivers a 6,000-character persona intact without a truncation note", async () => {
		const { database, directory } = await openFixture();
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const model = createFakeModel({ responses: ["ack"] });
		const captured: CapturedRequest[] = [];
		captureModel(model, captured);
		const persona = "P".repeat(6_000);
		const providerInstance = provider(database);
		const host = new PiDurableConversationHost({
			contextProvider: providerInstance,
			model,
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
			timeZone: "UTC",
		});
		try {
			const durableConversationId = await host.createConversation();
			const sessionId = await linkConversation(database, durableConversationId, "private");
			await database.insert(personas).values({
				behaviorJson: "{}",
				id: "persona-long",
				isActive: 1,
				name: "Long persona",
				promptJson: JSON.stringify(persona),
				summary: "synthetic long persona",
				version: 1,
			});
			await database.insert(personaBindings).values({
				conversationId: sessionId,
				id: "binding-long",
				isActive: 1,
				isGlobal: 0,
				personaId: "persona-long",
			});
			await host.append({
				conversationId: durableConversationId,
				envelope: groupEnvelope("persona-turn", "hello", "Tester", "1001"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			const request = await waitForAsync(async () =>
				captured.find((entry) => JSON.stringify(entry).includes("P".repeat(200))),
			);
			const serialized = JSON.stringify(request);
			expect(serialized).toContain(persona);
			expect(serialized).not.toContain("[persona truncated");
			expect(persona).toHaveLength(6_000);
		} finally {
			await host.close();
			database.$client.close();
		}
	});
});

describe("Batch 1 acceptance: ambient observation window", () => {
	test("shows named, timestamped ambient lines and filters the current input", async () => {
		const { database, directory } = await openFixture();
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const model = createFakeModel({ responses: ["ack"] });
		const captured: CapturedRequest[] = [];
		captureModel(model, captured);
		const providerInstance = provider(database, { timeZone: "UTC" });
		const host = new PiDurableConversationHost({
			contextProvider: providerInstance,
			model,
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
			timeZone: "UTC",
		});
		try {
			const durableConversationId = await host.createConversation();
			const sessionId = await linkConversation(database, durableConversationId, "group");
			await database.insert(messages).values([
				{
					contentText: "EARLIER-A",
					conversationId: sessionId,
					direction: "inbound",
					id: "message-earlier-a",
					kind: "onebot-v11",
					occurredAt: "2026-05-06T03:04:00.000Z",
					platformMessageId: "earlier-a",
					senderDisplayName: "Alice",
					senderExternalId: "1002",
				},
				{
					contentText: "EARLIER-B",
					conversationId: sessionId,
					direction: "inbound",
					id: "message-earlier-b",
					kind: "onebot-v11",
					occurredAt: "2026-05-06T03:05:00.000Z",
					platformMessageId: "earlier-b",
					senderDisplayName: "Bob",
					senderExternalId: "1003",
				},
				{
					contentText: "MY-OWN-REPLY",
					conversationId: sessionId,
					direction: "outbound",
					id: "message-self",
					kind: "onebot-v11",
					occurredAt: "2026-05-06T03:06:00.000Z",
					platformMessageId: "self-message",
					senderDisplayName: "Tsukaima",
					senderExternalId: "tsukaima",
				},
				{
					contentText: "CURRENT-UNIQUE-INPUT",
					conversationId: sessionId,
					direction: "inbound",
					id: "message-current",
					kind: "onebot-v11",
					occurredAt: "2026-05-06T03:07:00.000Z",
					platformMessageId: "current-1",
					senderDisplayName: "Carol",
					senderExternalId: "1004",
				},
			]);
			await host.append({
				conversationId: durableConversationId,
				envelope: {
					...groupEnvelope("current-1", "CURRENT-UNIQUE-INPUT", "Carol", "1004"),
					source: {
						messageId: "current-1",
						receivedAtMs: Date.UTC(2026, 4, 6, 3, 7),
						timestampMs: 1,
					},
				},
				forceSubmit: true,
				submittedAtMs: Date.UTC(2026, 4, 6, 3, 7),
			});
			const context = await waitForAsync(async () =>
				captured.find((entry) => JSON.stringify(entry.messages ?? []).includes("<observation>")),
			);
			const observation = (context.messages ?? [])
				.filter((message) => message.role === "user")
				.map((message) => (typeof message.content === "string" ? message.content : ""))
				.find((text) => text.includes("<observation>"));
			if (observation === undefined) throw new Error("Observation block missing");
			expect(observation).toContain("[03:04] Alice(1002): EARLIER-A");
			expect(observation).toContain("[03:05] Bob(1003): EARLIER-B");
			expect(observation).toContain("[03:06] (you): MY-OWN-REPLY");
			expect(observation).not.toContain("CURRENT-UNIQUE-INPUT");
			expect(JSON.stringify(context.messages ?? []).match(/CURRENT-UNIQUE-INPUT/g)).toHaveLength(1);
		} finally {
			await host.close();
			database.$client.close();
		}
	});
});

describe("Batch 1 acceptance: chat-native compaction", () => {
	test("uses the chat prompt for every chat surface and coding format only for workspace", async () => {
		const { database, directory } = await openFixture();
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const completions: ContextCompletionRequest[] = [];
		const providerInstance = provider(database, {
			completeText: async (request) => {
				completions.push(request);
				return "CHAT-COMPACTED-SUMMARY";
			},
			renderPrompt: async (key) => DEFAULT_PROMPTS[key],
		});
		const model = createFakeModel({ responses: [] });
		const contexts: CapturedRequest[] = [];
		captureModel(model, contexts);
		const host = new PiDurableConversationHost({
			contextProvider: providerInstance,
			model,
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
			timeZone: "UTC",
		});
		const largeChunk = "synthetic chat detail ".repeat(1_500);
		const fill = async (durableConversationId: string, turns = 4) => {
			for (let index = 0; index < turns; index += 1) {
				await host.append({
					conversationId: durableConversationId,
					envelope: groupEnvelope(
						`bulk-${durableConversationId}-${index}`,
						`${index}: ${largeChunk}`,
						"Tester",
						"1001",
					),
					forceSubmit: true,
					submittedAtMs: Date.now() + index,
				});
			}
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const stats = await host.inspectConversationContext(durableConversationId);
				if ((stats?.messageCount ?? 0) >= 8) return;
				await Bun.sleep(20);
			}
		};
		try {
			const chatConversations: string[] = [];
			for (const kind of ["private", "group", "webui"] as const) {
				const durableConversationId = await host.createConversation();
				chatConversations.push(durableConversationId);
				await linkConversation(database, durableConversationId, kind);
				await fill(durableConversationId);
				const compacted = await host.compactConversation(durableConversationId, "KEEP-FACTS");
				if (!compacted.compacted) throw new Error(`Chat compaction did not run for ${kind}`);
			}
			expect(completions).toHaveLength(3);
			for (const completion of completions) {
				expect(completion.system).toBe(DEFAULT_PROMPTS["chat-compaction"]);
				expect(completion.prompt).toContain("<chat-transcript>");
				expect(completion.prompt).toContain("KEEP-FACTS");
				expect(completion.prompt).not.toContain("## Goal");
			}

			const workspaceId = await host.createConversation();
			await linkConversation(database, workspaceId, "workspace");
			await fill(workspaceId);
			const workspaceCompaction = await host.compactConversation(workspaceId, "KEEP-FACTS");
			expect(workspaceCompaction.compacted).toBe(true);
			expect(completions).toHaveLength(3);
			const summarizer = contexts.find((context) =>
				JSON.stringify(context.messages ?? []).includes("context summarization assistant"),
			);
			expect(summarizer).toBeDefined();
			expect(JSON.stringify(summarizer)).toContain("## Goal");
			expect(JSON.stringify(summarizer)).toContain("Preserve exact file paths");
		} finally {
			await host.close();
			database.$client.close();
		}
	});

	test("carries a previous chat summary into the next compaction", async () => {
		const { database } = await openFixture();
		const durableConversationId = "77";
		const sessionId = await linkConversation(database, durableConversationId, "webui");
		const completions: ContextCompletionRequest[] = [];
		const providerInstance = provider(database, {
			completeText: async (request) => {
				completions.push(request);
				return "SECOND-SUMMARY";
			},
			renderPrompt: async (key) => DEFAULT_PROMPTS[key],
		});
		try {
			expect(
				await providerInstance.summarizeCompaction({
					conversationId: durableConversationId,
					previousSummary: "FIRST-SUMMARY",
					reason: "manual",
					transcript: "new messages after the first summary",
				}),
			).toBe("SECOND-SUMMARY");
			expect(completions[0]?.prompt).toContain("<previous-summary>");
			expect(completions[0]?.prompt).toContain("FIRST-SUMMARY");
			expect(completions[0]?.prompt).toContain("new messages after the first summary");
			expect(await providerInstance.isChatConversation(durableConversationId)).toBe(true);
			expect(completions[0]?.system).toBe(DEFAULT_PROMPTS["chat-compaction"]);
			void sessionId;
		} finally {
			database.$client.close();
		}
	});
});
