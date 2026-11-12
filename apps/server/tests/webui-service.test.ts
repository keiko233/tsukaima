import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { conversations } from "@tsukaima/db";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import {
	createLocalChat,
	createSession,
	listChats,
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
	channelKind: "onebot-v11",
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
});
