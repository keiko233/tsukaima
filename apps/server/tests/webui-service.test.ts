import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { conversations, messages as messagesTable } from "@tsukaima/db";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import {
	createLocalChat,
	createSession,
	getSessionContextStats,
	getSessionMessage,
	listChats,
	listMessagePage,
	listMessages,
	listRequests,
	sendMessage,
	setReceivingSession,
} from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const envelope = (id: string, text: string, timestampMs = Date.now()): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "test-channel",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs },
});

async function createLifecycle() {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-webui-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		TSUKAIMA_DATA_DIR: directory,
		TSUKAIMA_PORT: "7420",
		TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
	});
	await lifecycle.start();
	return lifecycle;
}

const pagedMessageAt = (offsetMs: number) =>
	new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(40);
	}
	throw new Error("Timed out waiting for condition");
}

describe("WebUI chat and session service", () => {
	test("keeps multiple sessions under one chat and routes external messages to the receiving session", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.processEnvelope(envelope("external-1", "first"));
			const initialChats = await listChats(lifecycle);
			expect(initialChats).toHaveLength(1);
			const chat = initialChats[0];
			if (chat === undefined) throw new Error("Chat was not created");
			expect(chat.sessions).toHaveLength(1);
			expect(chat.sessions[0]?.isReceiving).toBe(true);
			const firstSessionId = chat.sessions[0]?.id;
			if (firstSessionId === undefined) throw new Error("Receiving session was not created");

			const second = await createSession(lifecycle, chat.id, "Second context");
			await setReceivingSession(lifecycle, second.id);
			await lifecycle.processEnvelope(envelope("external-2", "second"));

			const chats = await listChats(lifecycle);
			expect(chats[0]?.sessions).toHaveLength(2);
			expect(chats[0]?.sessions.find((session) => session.id === second.id)?.isReceiving).toBe(
				true,
			);
			const firstMessages = await listMessages(lifecycle, firstSessionId);
			const secondMessages = await listMessages(lifecycle, second.id);
			expect(firstMessages.map((message) => message.contentText)).toEqual(["first"]);
			expect(secondMessages.map((message) => message.contentText)).toEqual(["second"]);

			await lifecycle.processEnvelope(envelope("external-2", "second"));
			expect(await listMessages(lifecycle, second.id)).toHaveLength(1);

			const [stored] = await lifecycle
				.domainDatabase!.select()
				.from(conversations)
				.where(eq(conversations.id, firstSessionId))
				.limit(1);
			if (stored === undefined) throw new Error("Session row missing");
			const host = lifecycle.conversationHost;
			if (host === undefined) throw new Error("Conversation host missing");
			const duplicate = await host.append({
				conversationId: stored.durableConversationId,
				envelope: envelope("external-1", "first"),
				submittedAtMs: Date.now(),
			});
			expect(duplicate.deduplicated).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	});

	test("sends a local message to Tsukaima and returns the durable assistant reply", async () => {
		const lifecycle = await createLifecycle();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Main",
				title: "Local chat",
			});
			const sent = await sendMessage(lifecycle, {
				sessionId: chat.sessionId,
				target: "tsukaima",
				text: "hello tsukaima",
			});
			expect(sent.deliveryStatus).toBe("accepted");
			const messages = await waitFor(async () => {
				const rows = await listMessages(lifecycle, chat.sessionId);
				return rows.some((message) => message.senderKind === "assistant") ? rows : undefined;
			});
			expect(messages[0]?.contentText).toBe("hello tsukaima");
			expect(messages.at(-1)?.contentText).toBe("ok");
			expect(messages.at(-1)?.senderKind).toBe("assistant");
		} finally {
			await lifecycle.stop();
		}
	});

	test("pages a transcript by a stable (occurredAt, id) cursor", async () => {
		const lifecycle = await createLifecycle();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Paged",
				title: "Paged chat",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			await database.insert(messagesTable).values([
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "m-1",
					kind: "webui",
					occurredAt: pagedMessageAt(0),
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "m-2",
					kind: "webui",
					occurredAt: pagedMessageAt(1),
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "m-3",
					kind: "webui",
					occurredAt: pagedMessageAt(1),
					durableEntryId: "entry-3",
					platformMessageId: "platform-3",
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "m-4",
					kind: "webui",
					occurredAt: pagedMessageAt(2),
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "m-5",
					kind: "webui",
					occurredAt: pagedMessageAt(3),
				},
			]);

			await expect(
				listMessagePage(lifecycle, { cursor: "not-a-cursor", sessionId: chat.sessionId }),
			).rejects.toThrow("Invalid message cursor");
			const first = await listMessagePage(lifecycle, { limit: 3, sessionId: chat.sessionId });
			expect(first.messages.map((message) => message.id)).toEqual(["m-3", "m-4", "m-5"]);
			if (first.nextCursor === null) throw new Error("Expected an older page");
			// `m-2` shares `m-3`'s timestamp. A cursor made only of occurredAt would skip it.
			const second = await listMessagePage(lifecycle, {
				cursor: first.nextCursor,
				limit: 3,
				sessionId: chat.sessionId,
			});
			expect(second.messages.map((message) => message.id)).toEqual(["m-1", "m-2"]);
			expect(second.nextCursor).toBeNull();

			// Every row still comes back in chronological order through the legacy full read.
			expect((await listMessages(lifecycle, chat.sessionId)).map((message) => message.id)).toEqual([
				"m-1",
				"m-2",
				"m-3",
				"m-4",
				"m-5",
			]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("resolves a live event row by platform id, row id, or durable entry id", async () => {
		const lifecycle = await createLifecycle();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Lookup",
				title: "Lookup chat",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			await database.insert(messagesTable).values({
				conversationId: chat.sessionId,
				direction: "outbound",
				durableEntryId: "entry-lookup",
				id: "row-lookup",
				kind: "webui",
				occurredAt: "2026-01-01T00:00:00.000Z",
				platformMessageId: "platform-lookup",
			});

			expect(
				(
					await getSessionMessage(lifecycle, {
						messageId: "platform-lookup",
						sessionId: chat.sessionId,
					})
				)?.id,
			).toBe("row-lookup");
			expect(
				(
					await getSessionMessage(lifecycle, {
						messageId: "row-lookup",
						sessionId: chat.sessionId,
					})
				)?.id,
			).toBe("row-lookup");
			expect(
				(
					await getSessionMessage(lifecycle, {
						durableEntryId: "entry-lookup",
						sessionId: chat.sessionId,
					})
				)?.id,
			).toBe("row-lookup");
			expect(
				await getSessionMessage(lifecycle, {
					messageId: "platform-lookup",
					sessionId: "another-session",
				}),
			).toBeNull();
		} finally {
			await lifecycle.stop();
		}
	});

	test("shows mention display names in transcripts without rewriting stored rows", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.processEnvelope({
				...envelope("mention-source", "hi"),
				sender: { displayName: "ExampleUser", id: "10001", platformId: "10001" },
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			const chats = await listChats(lifecycle);
			const sessionId = chats[0]?.sessions[0]?.id;
			if (sessionId === undefined) throw new Error("Session was not created");
			const mentionText = "@10001 ping, @10003 too";
			await database.insert(messagesTable).values({
				contentText: mentionText,
				conversationId: sessionId,
				direction: "inbound",
				id: "mention-row",
				kind: "onebot-test",
				// Later than the live traffic above, so it is also the chat's preview row.
				occurredAt: "2026-12-01T00:00:00.000Z",
				partsJson: JSON.stringify([{ text: mentionText, type: "text" }]),
				senderDisplayName: "Observer",
				senderExternalId: "user-2",
			});

			const page = await listMessagePage(lifecycle, { sessionId });
			const mention = page.messages.find((message) => message.id === "mention-row");
			// Known ids become names; an id with no known identity has to stay readable as sent.
			expect(mention?.contentText).toBe("@ExampleUser ping, @10003 too");
			expect(mention?.parts).toEqual([{ text: "@ExampleUser ping, @10003 too", type: "text" }]);
			expect((await listMessages(lifecycle, sessionId)).at(-1)?.contentText).toBe(
				"@ExampleUser ping, @10003 too",
			);
			expect((await listChats(lifecycle))[0]?.sessions[0]?.latestMessage?.contentText).toBe(
				"@ExampleUser ping, @10003 too",
			);
			expect(
				(
					await getSessionMessage(lifecycle, {
						messageId: "mention-row",
						sessionId,
					})
				)?.contentText,
			).toBe("@ExampleUser ping, @10003 too");

			const [stored] = await database
				.select({ contentText: messagesTable.contentText, partsJson: messagesTable.partsJson })
				.from(messagesTable)
				.where(eq(messagesTable.id, "mention-row"))
				.limit(1);
			expect(stored?.contentText).toBe(mentionText);
			expect(stored?.partsJson).toContain("@10001");
		} finally {
			await lifecycle.stop();
		}
	});

	test("deduplicates request events and never retries when the channel is unavailable", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.processRequest({
				accountId: "99",
				channelId: "onebot-test",
				comment: "please add me",
				flag: "request-1",
				kind: "friend",
				receivedAtMs: 1_000,
				requesterId: "user-1",
			});
			await lifecycle.processRequest({
				accountId: "99",
				channelId: "onebot-test",
				comment: "updated comment",
				flag: "request-1",
				kind: "friend",
				receivedAtMs: 2_000,
				requesterId: "user-1",
			});
			const requests = await listRequests(lifecycle);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.comment).toBe("updated comment");
			expect(requests[0]?.status).toBe("pending");
			const request = requests[0];
			if (request === undefined) throw new Error("Request was not persisted");
			await expect(lifecycle.resolveChannelRequest(request.id, "approve")).rejects.toThrow(
				"Channel onebot-test is not registered",
			);
		} finally {
			await lifecycle.stop();
		}
	});

	test("computes session context stats without exposing coding tools to chat", async () => {
		const lifecycle = await createLifecycle();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Context",
				title: "Context chat",
			});
			expect(await getSessionContextStats(lifecycle, "missing-session")).toBeNull();

			await sendMessage(lifecycle, {
				sessionId: chat.sessionId,
				target: "tsukaima",
				text: "Remember that my favorite drink is Darjeeling tea.",
			});
			await waitFor(async () => {
				const rows = await listMessages(lifecycle, chat.sessionId);
				return rows.some((message) => message.senderKind === "assistant") ? rows : undefined;
			});

			const withoutCoding = await getSessionContextStats(lifecycle, chat.sessionId);
			expect(withoutCoding).not.toBeNull();
			if (withoutCoding === null) throw new Error("Expected context stats");
			expect(withoutCoding.messageCount).toBeGreaterThanOrEqual(2);
			expect(withoutCoding.categories.messagesTokens).toBeGreaterThan(0);
			expect(withoutCoding.categories.policyTokens).toBeGreaterThan(0);
			// Recent messages only seed recall now; they are not injected as a memory tier.
			expect(withoutCoding.categories.memoriesTokens).toBe(0);
			expect(withoutCoding.memories.enabled).toBe(true);
			expect(withoutCoding.memories.items).toHaveLength(0);
			expect(withoutCoding.memories.recentCount).toBeGreaterThanOrEqual(1);
			const codingTools = lifecycle.pluginHost.modelToolNames("self-iteration");
			for (const toolName of codingTools) {
				expect(withoutCoding.tools.some((tool) => tool.name === toolName)).toBe(false);
			}
			expect(withoutCoding.tools.some((tool) => tool.name === "workspace_git_identity")).toBe(
				false,
			);

			const currentPolicy = await lifecycle.conversationPolicy.effectivePolicy(chat.sessionId);
			await lifecycle.conversationPolicy.update({
				policy: {
					...currentPolicy,
					capabilities: [...new Set([...currentPolicy.capabilities, "coding"])],
				},
				scope: "conversation",
				conversationId: chat.sessionId,
			});
			const withCoding = await getSessionContextStats(lifecycle, chat.sessionId);
			expect(withCoding).not.toBeNull();
			if (withCoding === null) throw new Error("Expected context stats with coding");
			if (codingTools.length > 0) {
				expect(withCoding.tools.some((tool) => codingTools.includes(tool.name))).toBe(false);
			}
			expect(withCoding.tools.some((tool) => tool.name === "workspace_spawn")).toBe(true);
			expect(withCoding.tools.some((tool) => tool.name === "workspace_git_identity")).toBe(false);
		} finally {
			await lifecycle.stop();
		}
	});
});
