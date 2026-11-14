import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { auditLog, chatObjects, conversations, messages } from "@tsukaima/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
import { createLocalChat } from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

type RecordedAction = { readonly action: string; readonly params: Record<string, unknown> };

const createOneBotTransportSpy = (options: { failSendAttempts?: readonly number[] } = {}) => {
	const actions: RecordedAction[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	let sendAttempts = 0;
	const createTransport: OneBotTransportFactory = (): OneBotTransport => {
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
				const isSend = parsed.action === "send_private_msg";
				if (isSend) sendAttempts += 1;
				const failing = isSend && (options.failSendAttempts?.includes(sendAttempts) ?? false);
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify(
							failing
								? { echo: parsed.echo, message: "synthetic send failure", retcode: 1200 }
								: { data: { message_id: 9001 }, echo: parsed.echo, retcode: 0 },
						),
					);
				});
			},
		};
	};
	return { actions, connections, createTransport };
};

async function createLifecycle(onebot: ReturnType<typeof createOneBotTransportSpy>) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-pacing-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		},
		{ pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.createTransport]]) },
	);
	await lifecycle.start();
	onebot.connections[0]?.emitOpen();
	return lifecycle;
}

async function createExternalSession(lifecycle: Awaited<ReturnType<typeof createLifecycle>>) {
	const host = lifecycle.conversationHost;
	const database = lifecycle.domainDatabase;
	if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
	const durableConversationId = await host.createConversation();
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: "private",
		platformConversationId: "user-1",
		title: "Tester",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "private",
		platformConversationId: "user-1",
		title: "Main",
		updatedAt: now,
	});
	return { chatId, durableConversationId, sessionId };
}

async function waitFor<T>(read: () => T | Promise<T> | undefined, timeoutMs = 5_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("lurk suppression and humanlike output pacing", () => {
	test("suppresses TSUKAIMA_LURK before outbound history and audits the no-send", async () => {
		const lifecycle = await createLifecycle(createOneBotTransportSpy());
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Main",
				title: "Local",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [session] = await database
				.select()
				.from(conversations)
				.where(eq(conversations.id, chat.sessionId))
				.limit(1);
			if (session === undefined) throw new Error("session missing");
			await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-lurk",
				conversationId: session.durableConversationId,
				entryId: "entry-lurk",
				text: "TSUKAIMA_LURK",
			});
			const outbound = await database
				.select()
				.from(messages)
				.where(and(eq(messages.direction, "outbound"), eq(messages.durableEntryId, "entry-lurk")));
			expect(outbound).toHaveLength(0);
			const audits = await database.select().from(auditLog);
			expect(audits.some((row) => row.action === "message.lurk" && row.result === "ok")).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	});

	test("strips Markdown, sends newline units, caps immediate output, and toggles typing", async () => {
		const onebot = createOneBotTransportSpy();
		const lifecycle = await createLifecycle(onebot);
		try {
			const { durableConversationId, sessionId } = await createExternalSession(lifecycle);
			await lifecycle.conversationPolicy.update({
				conversationId: sessionId,
				policy: {
					pacing: {
						maxImmediateOutputMessages: 2,
						replyDelayEnabled: false,
						replyDelayMaxMs: 0,
						sendIntervalMs: 0,
						stripMarkdown: true,
						typingEnabled: true,
					},
				},
				scope: "conversation",
			});
			await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-output",
				conversationId: durableConversationId,
				entryId: "entry-output",
				text: "# Title\n**one**\ntwo\nthree",
			});
			const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
			expect(
				sent.map((action) => (action.params.message as { data: { text: string } }[])[0]?.data.text),
			).toEqual(["Title", "one\ntwo\nthree"]);
			expect(
				onebot.actions
					.filter((action) => action.action === "set_input_status")
					.map((action) => action.params),
			).toEqual([
				{ event_type: 1, user_id: "user-1" },
				{ event_type: 2, user_id: "user-1" },
			]);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [row] = await database
				.select()
				.from(messages)
				.where(eq(messages.durableEntryId, "entry-output"))
				.limit(1);
			expect(row?.deliveryStatus).toBe("sent");
			expect(row?.contentText).toBe("Title\none\ntwo\nthree");
		} finally {
			await lifecycle.stop();
		}
	});

	test("continues with remaining chunks when one send fails", async () => {
		const onebot = createOneBotTransportSpy({ failSendAttempts: [1] });
		const lifecycle = await createLifecycle(onebot);
		try {
			const { durableConversationId, sessionId } = await createExternalSession(lifecycle);
			await lifecycle.conversationPolicy.update({
				conversationId: sessionId,
				policy: {
					pacing: {
						replyDelayEnabled: false,
						sendIntervalMs: 0,
						stripMarkdown: false,
						typingEnabled: false,
					},
				},
				scope: "conversation",
			});
			const outcome = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-partial",
				conversationId: durableConversationId,
				entryId: "entry-partial",
				text: "one\ntwo\nthree",
			});
			expect(outcome?.deliveryStatus).toBe("uncertain");
			const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
			expect(
				sent.map((action) => (action.params.message as { data: { text: string } }[])[0]?.data.text),
			).toEqual(["one", "two", "three"]);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [row] = await database
				.select()
				.from(messages)
				.where(eq(messages.durableEntryId, "entry-partial"))
				.limit(1);
			expect(row?.deliveryStatus).toBe("uncertain");
			const audits = await database.select().from(auditLog);
			expect(
				audits.some((audit) => audit.action === "message.send-reply" && audit.result === "failed"),
			).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	});

	test("cancels remaining output units on a new inbound trigger without fake success", async () => {
		const onebot = createOneBotTransportSpy();
		const lifecycle = await createLifecycle(onebot);
		try {
			const { durableConversationId, sessionId } = await createExternalSession(lifecycle);
			await lifecycle.conversationPolicy.update({
				conversationId: sessionId,
				policy: {
					pacing: {
						replyDelayEnabled: false,
						sendIntervalMs: 120,
						stripMarkdown: false,
						typingEnabled: false,
					},
				},
				scope: "conversation",
			});
			const task = lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-cancel",
				conversationId: durableConversationId,
				entryId: "entry-cancel",
				text: "one\ntwo\nthree",
			});
			await waitFor(() =>
				onebot.actions.some((action) => action.action === "send_private_msg") ? true : undefined,
			);
			expect(lifecycle.replyDispatcher.cancelPendingOutput(durableConversationId)).toBe(true);
			await task;
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [row] = await database
				.select()
				.from(messages)
				.where(eq(messages.durableEntryId, "entry-cancel"))
				.limit(1);
			expect(row?.deliveryStatus).not.toBe("sent");
			const audits = await database.select().from(auditLog);
			expect(audits.some((audit) => audit.action === "message.cancel-output")).toBe(true);
			const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
			expect(sent.length).toBeLessThan(3);
		} finally {
			await lifecycle.stop();
		}
	});
});
