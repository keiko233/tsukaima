import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MessageEnvelope } from "@elaina/contracts";
import {
	auditLog,
	chatObjects,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@elaina/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
} from "@elaina-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
import { splitMessageParts } from "../src/services/reply-dispatcher.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
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

type HistoryMessage = {
	message: Array<{ data: Record<string, unknown>; type: string }>;
	message_id: string;
	sender: { user_id: string };
	time: number;
};

function createReconTransport(options: { autoOpen?: boolean } = {}) {
	const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
	const history: HistoryMessage[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	const factory: OneBotTransportFactory = (): OneBotTransport => {
		const listeners = new Map<string, (value?: unknown) => void>();
		connections.push({ emitOpen: () => listeners.get("open")?.() });
		if (options.autoOpen === true) queueMicrotask(() => listeners.get("open")?.());
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
					const response =
						parsed.action === "get_friend_msg_history" || parsed.action === "get_group_msg_history"
							? { messages: history }
							: { message_id: 9001 };
					listeners.get("message")?.(
						JSON.stringify({ data: response, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return { actions, connections, factory, history };
}

async function createLifecycle(
	onebot: ReturnType<typeof createReconTransport>,
	directory?: string,
	reply?: { pendingGraceMs?: number; reconcileIntervalMs?: number },
) {
	const dataDir = directory ?? (await fs.mkdtemp(join(tmpdir(), "elaina-reconcile-")));
	if (directory === undefined) directories.push(dataDir);
	const { lifecycle } = createApp(
		{
			ELAINA_DATA_DIR: dataDir,
			ELAINA_ONEBOT_WS_URL: "ws://napcat:3001",
			ELAINA_PORT: "7420",
		},
		{
			pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.factory]]),
			...(reply === undefined ? {} : { reply }),
		},
	);
	await lifecycle.start();
	return { dataDir, lifecycle };
}

async function insertPending(
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>["lifecycle"],
	text: string,
): Promise<string> {
	await lifecycle.processEnvelope(envelope(`source-${text}`, text));
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("Domain database not ready");
	const [chat] = await database
		.select()
		.from(chatObjects)
		.where(eq(chatObjects.channelId, "onebot"))
		.limit(1);
	const [session] = await database
		.select()
		.from(conversations)
		.where(eq(conversations.chatObjectId, chat?.id ?? ""))
		.limit(1);
	if (chat === undefined || session === undefined) throw new Error("Session not created");
	const id = randomUUID();
	await database.insert(messages).values({
		chatObjectId: chat.id,
		contentText: text,
		conversationId: session.id,
		direction: "outbound",
		deliveryStatus: "pending",
		id,
		kind: "onebot-v11",
		occurredAt: new Date(Date.now() - 120_000).toISOString(),
		partsJson: JSON.stringify([{ text, type: "text" }]),
		senderDisplayName: "Elaina",
		senderExternalId: "elaina",
	});
	return id;
}

describe("pending outbound reconciliation", () => {
	test("confirms a stale pending row from bounded read history without resending", async () => {
		const onebot = createReconTransport();
		const { lifecycle } = await createLifecycle(onebot);
		try {
			onebot.connections[0]?.emitOpen();
			const messageId = await insertPending(lifecycle, "already delivered");
			onebot.history.push({
				message: [{ data: { text: "already delivered" }, type: "text" }],
				message_id: "platform-9001",
				sender: { user_id: "elaina" },
				time: Math.floor(Date.now() / 1_000),
			});
			const result = await lifecycle.replyDispatcher.reconcilePendingDeliveries({
				graceMs: 0,
			});
			expect(result).toEqual({ confirmed: 1, skipped: 0, uncertain: 0 });
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const [row] = await database
				.select()
				.from(messages)
				.where(eq(messages.id, messageId))
				.limit(1);
			expect(row).toMatchObject({
				deliveryStatus: "sent",
				platformMessageId: "platform-9001",
			});
			expect(onebot.actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const audits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "message.reconcile-sent"));
			expect(audits).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("marks unconfirmed stale pending rows uncertain, audits, and never resends", async () => {
		const onebot = createReconTransport();
		const { lifecycle } = await createLifecycle(onebot);
		try {
			onebot.connections[0]?.emitOpen();
			const messageId = await insertPending(lifecycle, "not in history");
			const result = await lifecycle.replyDispatcher.reconcilePendingDeliveries({
				graceMs: 0,
			});
			expect(result).toEqual({ confirmed: 0, skipped: 0, uncertain: 1 });
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const [row] = await database
				.select()
				.from(messages)
				.where(eq(messages.id, messageId))
				.limit(1);
			expect(row?.deliveryStatus).toBe("uncertain");
			expect(onebot.actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const audits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "message.reconcile-uncertain"));
			expect(audits[0]).toMatchObject({ result: "failed" });
		} finally {
			await lifecycle.stop();
		}
	});

	test("reconciles on a periodic tick", async () => {
		const onebot = createReconTransport();
		const { lifecycle } = await createLifecycle(onebot, undefined, {
			pendingGraceMs: 0,
			reconcileIntervalMs: 20,
		});
		try {
			onebot.connections[0]?.emitOpen();
			const messageId = await insertPending(lifecycle, "periodic delivery");
			onebot.history.push({
				message: [{ data: { text: "periodic delivery" }, type: "text" }],
				message_id: "platform-periodic",
				sender: { user_id: "elaina" },
				time: Math.floor(Date.now() / 1_000),
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const deadline = Date.now() + 2_000;
			let status: string | undefined;
			while (Date.now() < deadline) {
				const [row] = await database
					.select({ deliveryStatus: messages.deliveryStatus })
					.from(messages)
					.where(eq(messages.id, messageId))
					.limit(1);
				status = row?.deliveryStatus;
				if (status === "sent") break;
				await Bun.sleep(20);
			}
			expect(status).toBe("sent");
		} finally {
			await lifecycle.stop();
		}
	});

	test("reconciles stale rows during startup", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "elaina-reconcile-startup-"));
		directories.push(directory);
		const seed = await openDomainDatabase(join(directory, "domain.sqlite"));
		migrateDomainDatabase(seed);
		await seed.insert(chatObjects).values({
			channelId: "onebot",
			id: "chat-startup",
			kind: "private",
			platformConversationId: "user-1",
			title: "Startup",
		});
		await seed.insert(conversations).values({
			chatObjectId: "chat-startup",
			durableConversationId: "900",
			id: "session-startup",
			isReceiving: 1,
			kind: "private",
			platformConversationId: "user-1",
			title: "Main",
		});
		await seed.insert(messages).values({
			chatObjectId: "chat-startup",
			contentText: "startup delivery",
			conversationId: "session-startup",
			direction: "outbound",
			deliveryStatus: "pending",
			id: "pending-startup",
			kind: "onebot-v11",
			occurredAt: new Date(Date.now() - 120_000).toISOString(),
			partsJson: JSON.stringify([{ text: "startup delivery", type: "text" }]),
			senderDisplayName: "Elaina",
			senderExternalId: "elaina",
		});
		seed.$client.close();

		const onebot = createReconTransport({ autoOpen: true });
		onebot.history.push({
			message: [{ data: { text: "startup delivery" }, type: "text" }],
			message_id: "platform-startup",
			sender: { user_id: "elaina" },
			time: Math.floor(Date.now() / 1_000),
		});
		const { lifecycle } = await createLifecycle(onebot, directory, { pendingGraceMs: 0 });
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const [row] = await database
				.select()
				.from(messages)
				.where(
					and(eq(messages.id, "pending-startup"), eq(messages.conversationId, "session-startup")),
				)
				.limit(1);
			expect(row).toMatchObject({
				deliveryStatus: "sent",
				platformMessageId: "platform-startup",
			});
		} finally {
			await lifecycle.stop();
		}
	});
});

describe("outbound chunking", () => {
	test("splits long text while preserving media and part order", () => {
		const chunks = splitMessageParts(
			[
				{ text: "0123456789ABCDEFGHIJ", type: "text" },
				{ sha256: "image-hash", type: "image" },
				{ text: "KLMNOP", type: "text" },
			],
			10,
		);
		expect(chunks).toEqual([
			[{ text: "0123456789", type: "text" }],
			[{ text: "ABCDEFGHIJ", type: "text" }],
			[
				{ sha256: "image-hash", type: "image" },
				{ text: "KLMNOP", type: "text" },
			],
		]);
	});
});
