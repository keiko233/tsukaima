import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope } from "@tsukaima/contracts";
import {
	PiDurableConversationHost,
	createFakeModel,
	type DurableToolRegistration,
} from "@tsukaima/core";
import {
	conversationMembers,
	conversations,
	memories,
	messages,
	openDomainDatabase,
	migrateDomainDatabase,
	personaBindings,
	personas,
	users,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { openDurableStorage } from "@tsukaima/durable";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransportFactory,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logging.ts";
import {
	DrizzleContextProvider,
	type DrizzleContextProviderOptions,
} from "../src/services/context-provider.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { createPromptTools } from "../src/services/prompt-tools.ts";
import { DEFAULT_PROMPTS } from "../src/services/prompt-defaults.ts";
import { PromptService } from "../src/services/prompts.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const logger = createLogger({ level: "error", target: "tsukaima::test" });

async function openFixture(): Promise<{ database: TsukaimaDatabase; directory: string }> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-context-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return { database, directory };
}

function provider(
	database: TsukaimaDatabase | (() => TsukaimaDatabase | undefined),
	overrides: Partial<
		Pick<
			DrizzleContextProviderOptions,
			"budgetChars" | "memoryTopK" | "personaBudgetChars" | "renderSystem"
		>
	> = {},
): DrizzleContextProvider {
	return new DrizzleContextProvider({
		database: typeof database === "function" ? database : () => database,
		logger,
		...overrides,
	});
}

async function insertMemory(
	database: TsukaimaDatabase,
	row: {
		content?: string;
		conversationId?: string;
		expiresAt?: string;
		id: string;
		importance?: number;
		revokedAt?: string;
		scope: "conversation" | "global" | "persona" | "user";
		subjectUserId?: string;
		summary: string;
	},
): Promise<void> {
	await database.insert(memories).values({
		content: row.content ?? row.summary,
		createdBy: "migration",
		id: row.id,
		kind: "fact",
		scope: row.scope,
		summary: row.summary,
		...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
		...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
		...(row.importance === undefined ? {} : { importance: row.importance }),
		...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
		...(row.subjectUserId === undefined ? {} : { subjectUserId: row.subjectUserId }),
	});
}

async function seedContextFixture(database: TsukaimaDatabase): Promise<void> {
	const now = new Date().toISOString();
	await database.insert(users).values([
		{ id: "user-member", kind: "human" },
		{ id: "user-stranger", kind: "human" },
	]);
	await database.insert(conversations).values([
		{
			durableConversationId: "42",
			id: "session-main",
			kind: "private",
			title: "Main",
			updatedAt: now,
		},
		{
			durableConversationId: "43",
			id: "session-other",
			kind: "private",
			title: "Other",
			updatedAt: now,
		},
		{
			durableConversationId: "44",
			id: "session-free",
			kind: "private",
			title: "Free",
			updatedAt: now,
		},
	]);
	await database.insert(conversationMembers).values({
		conversationId: "session-main",
		role: "member",
		userId: "user-member",
	});
	await database.insert(personas).values([
		{
			behaviorJson: "{}",
			id: "persona-conv",
			isActive: 1,
			name: "Conversation persona",
			promptJson: JSON.stringify("PERSONA-CONVERSATION-BINDING"),
			summary: "conversation-bound persona",
			version: 1,
		},
		{
			behaviorJson: "{}",
			id: "persona-global",
			isActive: 1,
			name: "Global persona",
			promptJson: JSON.stringify("PERSONA-GLOBAL-FALLBACK"),
			summary: "global persona",
			version: 1,
		},
		{
			behaviorJson: "{}",
			id: "persona-inactive",
			isActive: 0,
			name: "Inactive persona",
			promptJson: JSON.stringify("PERSONA-INACTIVE"),
			summary: "inactive persona",
			version: 1,
		},
	]);
	await database.insert(personaBindings).values([
		{
			conversationId: "session-main",
			id: "binding-conversation",
			isActive: 1,
			isGlobal: 0,
			personaId: "persona-conv",
		},
		{
			id: "binding-global",
			isActive: 1,
			isGlobal: 1,
			personaId: "persona-global",
		},
		{
			conversationId: "session-other",
			id: "binding-inactive",
			isActive: 1,
			isGlobal: 0,
			personaId: "persona-inactive",
		},
	]);
	await insertMemory(database, {
		id: "mem-global",
		scope: "global",
		summary: "MARKER-GLOBAL stays everywhere",
	});
	await insertMemory(database, {
		conversationId: "session-main",
		id: "mem-conversation",
		scope: "conversation",
		summary: "MARKER-CONVERSATION local fact",
	});
	await insertMemory(database, {
		conversationId: "session-other",
		id: "mem-other-conversation",
		scope: "conversation",
		summary: "MARKER-OTHER-CONVERSATION must not leak",
	});
	await insertMemory(database, {
		conversationId: "session-main",
		id: "mem-persona",
		scope: "persona",
		summary: "MARKER-PERSONA tone note",
	});
	await insertMemory(database, {
		conversationId: "session-other",
		id: "mem-persona-other",
		scope: "persona",
		summary: "MARKER-PERSONA-OTHER must not leak",
	});
	await insertMemory(database, {
		id: "mem-member",
		scope: "user",
		subjectUserId: "user-member",
		summary: "MARKER-MEMBER preference",
	});
	await insertMemory(database, {
		id: "mem-stranger",
		scope: "user",
		subjectUserId: "user-stranger",
		summary: "MARKER-STRANGER must not leak",
	});
	await insertMemory(database, {
		id: "mem-revoked",
		revokedAt: now,
		scope: "global",
		summary: "MARKER-REVOKED must not leak",
	});
	await insertMemory(database, {
		expiresAt: new Date(Date.now() - 60_000).toISOString(),
		id: "mem-expired",
		scope: "global",
		summary: "MARKER-EXPIRED must not leak",
	});
	await database.insert(messages).values({
		contentText: "I love matcha drinks",
		conversationId: "session-main",
		direction: "inbound",
		id: "message-main-1",
		kind: "onebot-v11",
		occurredAt: now,
		senderUserId: "user-member",
	});
}

describe("DrizzleContextProvider", () => {
	test("prefers a conversation persona binding over the global binding", async () => {
		const { database } = await openFixture();
		try {
			await seedContextFixture(database);
			const context = provider(database);
			expect(await context.renderPersona("42")).toContain("PERSONA-CONVERSATION-BINDING");
			// Conversation 43 binds an inactive persona: no active version, no fallback.
			expect(await context.renderPersona("43")).toBeUndefined();
			expect(await context.renderPersona("44")).toContain("PERSONA-GLOBAL-FALLBACK");
		} finally {
			database.$client.close();
		}
	});

	test("selects global, conversation, persona, and member memories only", async () => {
		const { database } = await openFixture();
		try {
			await seedContextFixture(database);
			const text = await provider(database).renderMemories("42");
			if (text === undefined) throw new Error("Expected memory text");
			expect(text).toContain("MARKER-GLOBAL");
			expect(text).toContain("MARKER-CONVERSATION");
			expect(text).toContain("MARKER-PERSONA");
			expect(text).toContain("MARKER-MEMBER");
			expect(text).not.toContain("MARKER-OTHER-CONVERSATION");
			expect(text).not.toContain("MARKER-PERSONA-OTHER");
			expect(text).not.toContain("MARKER-STRANGER");
			expect(text).not.toContain("MARKER-REVOKED");
			expect(text).not.toContain("MARKER-EXPIRED");
		} finally {
			database.$client.close();
		}
	});

	test("keeps imported tool output out of the recent conversation window", async () => {
		const { database } = await openFixture();
		try {
			await seedContextFixture(database);
			await database.insert(messages).values(
				Array.from({ length: 6 }, (_, index) => ({
					contentText: "SYNTHETIC-TOOL-RESULT",
					conversationId: "session-main",
					direction: "outbound" as const,
					id: `imported-tool-${index}`,
					kind: "tool",
					occurredAt: "2099-01-01T00:00:00.000Z",
				})),
			);
			const text = await provider(database).renderMemories("42");
			expect(text).toContain("I love matcha drinks");
			expect(text).not.toContain("SYNTHETIC-TOOL-RESULT");
		} finally {
			database.$client.close();
		}
	});

	test("does not inject shared chat memories into workspace sessions", async () => {
		const { database } = await openFixture();
		try {
			await seedContextFixture(database);
			const now = new Date().toISOString();
			await database.insert(conversations).values({
				durableConversationId: "45",
				id: "session-workspace",
				kind: "workspace",
				title: "Workspace",
				updatedAt: now,
			});
			await database.insert(messages).values({
				contentText: "I love matcha drinks",
				conversationId: "session-workspace",
				direction: "inbound",
				id: "message-workspace-1",
				kind: "onebot-v11",
				occurredAt: now,
			});
			const text = await provider(database).renderMemories("45");
			// The workspace's own recent transcript remains visible, but chat-scoped recall does not.
			expect(text).toContain("matcha drinks");
			expect(text ?? "").not.toContain("MARKER-GLOBAL");
			expect(text ?? "").not.toContain("MARKER-MEMBER");
			expect(text ?? "").not.toContain("MARKER-CONVERSATION");
		} finally {
			database.$client.close();
		}
	});

	test("ranks keyword matches from recent messages above importance alone", async () => {
		const { database } = await openFixture();
		try {
			await seedContextFixture(database);
			await insertMemory(database, {
				id: "mem-keyword",
				importance: 0.1,
				scope: "global",
				summary: "MARKER-KEYWORD loves matcha",
			});
			await insertMemory(database, {
				id: "mem-important",
				importance: 0.9,
				scope: "global",
				summary: "MARKER-IMPORTANT unrelated",
			});
			const text = await provider(database, { memoryTopK: 1 }).renderMemories("42");
			if (text === undefined) throw new Error("Expected memory text");
			expect(text).toContain("MARKER-KEYWORD");
			expect(text).not.toContain("MARKER-IMPORTANT");
		} finally {
			database.$client.close();
		}
	});

	test("keeps persona and memory in separate budgets", async () => {
		const { database } = await openFixture();
		try {
			await seedContextFixture(database);
			await database.insert(personas).values({
				behaviorJson: "{}",
				id: "persona-long",
				isActive: 1,
				name: "Long persona",
				promptJson: JSON.stringify("P".repeat(600)),
				summary: "long persona",
				version: 1,
			});
			await database
				.update(personaBindings)
				.set({ personaId: "persona-long" })
				.where(eq(personaBindings.conversationId, "session-main"));
			const full = provider(database);
			const intactPersona = await full.renderPersona("42");
			expect(intactPersona).toBe("P".repeat(600));
			const tight = provider(database, { budgetChars: 120, personaBudgetChars: 80 });
			const personaText = await tight.renderPersona("42");
			const memoryText = await tight.renderMemories("42");
			if (personaText === undefined || memoryText === undefined) {
				throw new Error("Expected persona and memory text");
			}
			expect(personaText).toContain("truncated");
			expect(personaText.length).toBeLessThanOrEqual(80);
			expect(memoryText).toContain("more not shown");
			expect(memoryText.length).toBeLessThanOrEqual(120);
			expect(personaText.length + memoryText.length).toBeLessThanOrEqual(200);
		} finally {
			database.$client.close();
		}
	});

	test("degrades to undefined without a database or when the database fails", async () => {
		const missing = provider(() => undefined);
		expect(await missing.renderPersona("42")).toBeUndefined();
		expect(await missing.renderMemories("42")).toBeUndefined();
		const broken = provider(() => {
			throw new Error("database exploded");
		});
		expect(await broken.renderPersona("42")).toBeUndefined();
		expect(await broken.renderMemories("42")).toBeUndefined();
	});
});

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(40);
	}
	throw new Error("Timed out waiting for condition");
}

describe("context injection end to end", () => {
	test("puts configured system, persona, and memory text into the live model request", async () => {
		const { database, directory } = await openFixture();
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const model = createFakeModel({ responses: ["ok"] });
		const captured: string[] = [];
		const originalStream = model.models.streamSimple.bind(model.models);
		model.models.streamSimple = (target, context, options) => {
			captured.push(JSON.stringify(context));
			return originalStream(target, context, options);
		};
		const prompts = new PromptService(
			() => database,
			async () => {},
		);
		const host = new PiDurableConversationHost({
			contextProvider: provider(database, { renderSystem: (id) => prompts.renderSystem(id) }),
			model,
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
		});
		try {
			await prompts.update(
				{ key: "chat-system", expectedOverride: null, override: "E2E-SYSTEM-MARKER" },
				"user",
			);
			await prompts.update(
				{ key: "coding-system", expectedOverride: null, override: "E2E-CODING-MARKER" },
				"user",
			);
			const durableConversationId = await host.createConversation();
			await database.insert(conversations).values({
				durableConversationId,
				id: "session-e2e",
				kind: "webui",
				title: "E2E",
			});
			await database.insert(personas).values({
				behaviorJson: "{}",
				id: "persona-e2e",
				isActive: 1,
				name: "E2E persona",
				promptJson: JSON.stringify("E2E-PERSONA-MARKER"),
				summary: "e2e persona",
				version: 1,
			});
			await database.insert(personaBindings).values({
				conversationId: "session-e2e",
				id: "binding-e2e",
				isActive: 1,
				isGlobal: 0,
				personaId: "persona-e2e",
			});
			await insertMemory(database, {
				id: "mem-e2e",
				scope: "global",
				summary: "E2E-MEMORY-MARKER",
			});
			await host.append({
				conversationId: durableConversationId,
				envelope: envelope("message-e2e", "hello"),
				submittedAtMs: Date.now(),
			});
			const request = await waitFor(() =>
				captured.find(
					(entry) => entry.includes("E2E-PERSONA-MARKER") && entry.includes("E2E-MEMORY-MARKER"),
				),
			);
			expect(request).toContain("E2E-PERSONA-MARKER");
			expect(request).toContain("E2E-MEMORY-MARKER");
			expect(request).toContain("E2E-SYSTEM-MARKER");
			expect(request).not.toContain("E2E-CODING-MARKER");
		} finally {
			await host.close();
			database.$client.close();
		}
	});

	test("prompt tools enforce access before saving shared instructions", async () => {
		const { database } = await openFixture();
		try {
			database
				.insert(conversations)
				.values([
					{ id: "prompt-webui", kind: "webui", durableConversationId: "101" },
					{ id: "prompt-im", kind: "private", durableConversationId: "102" },
					{ id: "prompt-workspace", kind: "workspace", durableConversationId: "103" },
				])
				.run();
			const prompts = new PromptService(
				() => database,
				async () => {},
			);
			const policy = new ConversationPolicyService({
				database: () => database,
				host: () => undefined,
				logger,
			});
			expect(prompts.agentAccess()).toBe(true);
			const update = createPromptTools(prompts, policy).tools?.find(
				({ name }) => name === "prompt_update",
			);
			if (update === undefined) throw new Error("Prompt update tool is missing");
			const run = (conversationId: number, override: string) =>
				update.execute(
					{ key: "coding-system", expectedOverride: null, override },
					{ conversationId } as Parameters<DurableToolRegistration["execute"]>[1],
					{} as Parameters<DurableToolRegistration["execute"]>[2],
				);
			await prompts.setAgentAccess(false);
			expect((await run(101, "Disabled write")).isError).toBe(true);
			await prompts.setAgentAccess(true);
			expect((await run(102, "IM write")).isError).toBe(true);
			expect((await run(103, "Workspace without coding access")).isError).toBe(true);
			await policy.update({
				conversationId: "prompt-workspace",
				scope: "conversation",
				policy: { capabilities: ["coding"] },
			});
			expect((await run(101, "Coding instructions")).isError).toBeUndefined();
			expect(await prompts.renderSystem("103")).toBe("Coding instructions");
			expect(await prompts.renderSystem("101")).toBe(DEFAULT_PROMPTS["chat-system"]);
			expect(
				(
					await update.execute(
						{
							key: "coding-system",
							expectedOverride: "Coding instructions",
							override: "Updated by workspace",
						},
						{ conversationId: 103 } as Parameters<DurableToolRegistration["execute"]>[1],
						{} as Parameters<DurableToolRegistration["execute"]>[2],
					)
				).isError,
			).toBeUndefined();
			expect(await prompts.renderSystem("103")).toBe("Updated by workspace");
			await prompts.setAgentAccess(false);
			expect(prompts.agentAccess()).toBe(false);
			expect((await run(101, "Revoked write")).isError).toBe(true);
		} finally {
			database.$client.close();
		}
	});
});

type RecordedAction = {
	readonly action: string;
	readonly params: Record<string, unknown>;
};

/** OneBot transport double that records actions and answers every action with `retcode: 0`. */
const createOneBotTransportSpy = () => {
	const actions: RecordedAction[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	const createTransport: OneBotTransportFactory = () => {
		const listeners = new Map<string, (value?: unknown) => void>();
		connections.push({ emitOpen: () => listeners.get("open")?.() });
		return {
			close: () => listeners.get("close")?.(),
			on: (name, listener) => {
				listeners.set(name, listener as (value?: unknown) => void);
			},
			send: (data) => {
				const parsed = JSON.parse(data) as {
					action: string;
					echo: string;
					params: Record<string, unknown>;
				};
				actions.push({ action: parsed.action, params: parsed.params });
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify({ data: { message_id: 9001 }, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return { actions, connections, createTransport };
};

describe("activity and reply hooks", () => {
	test("fires activity.opened, activity.closed, and before.reply around a delivered answer", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-context-hooks-"));
		directories.push(directory);
		const onebot = createOneBotTransportSpy();
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.createTransport]]),
			},
		);
		await lifecycle.start();
		try {
			onebot.connections[0]?.emitOpen();
			const events: string[] = [];
			let openedPayload: Record<string, unknown> | undefined;
			let closedPayload: Record<string, unknown> | undefined;
			let beforePayload: Record<string, unknown> | undefined;
			lifecycle.hooks.on("activity.opened", (payload) => {
				events.push("activity.opened");
				openedPayload = payload as Record<string, unknown>;
			});
			lifecycle.hooks.on("activity.closed", (payload) => {
				events.push("activity.closed");
				closedPayload = payload as Record<string, unknown>;
			});
			lifecycle.hooks.on("before.reply", (payload) => {
				events.push("before.reply");
				beforePayload = payload as Record<string, unknown>;
			});
			lifecycle.hooks.on("after.reply", () => {
				events.push("after.reply");
			});

			await lifecycle.processEnvelope(envelope("message-hooks", "hi"));
			await waitFor(() => (events.includes("after.reply") ? true : undefined), 20_000);

			expect(events.indexOf("activity.opened")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("activity.opened")).toBeLessThan(events.indexOf("activity.closed"));
			expect(events).toContain("before.reply");
			expect(events.indexOf("before.reply")).toBeLessThan(events.indexOf("after.reply"));
			expect(openedPayload).toMatchObject({
				activityId: expect.any(String),
				conversationId: expect.any(String),
			});
			expect(closedPayload).toMatchObject({ envelopeCount: 1 });
			expect(beforePayload).toMatchObject({
				channelId: "onebot",
				text: "ok",
			});
			expect(typeof beforePayload?.sessionId).toBe("string");
		} finally {
			await lifecycle.stop();
		}
	}, 25_000);
});
