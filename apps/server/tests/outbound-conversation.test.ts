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

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

type RecordedAction = { readonly action: string; readonly params: Record<string, unknown> };

const createOneBotTransportSpy = () => {
	const actions: RecordedAction[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	let messageId = 9_000;
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
				messageId += 1;
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify({ data: { message_id: messageId }, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return { actions, connections, createTransport };
};

async function createLifecycle(
	options: { onebot?: ReturnType<typeof createOneBotTransportSpy> } = {},
) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-outbound-conversation-"));
	directories.push(directory);
	const onebot = options.onebot ?? createOneBotTransportSpy();
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
	onebot.connections[0]?.emitOpen();
	return { lifecycle, onebot };
}

async function createExternalSession(
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>["lifecycle"],
	input: { kind: "group" | "private"; platformConversationId: string },
) {
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
		kind: input.kind,
		platformConversationId: input.platformConversationId,
		title: input.kind === "group" ? "Synthetic Group" : "Synthetic Tester",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: input.kind,
		platformConversationId: input.platformConversationId,
		title: "Synthetic conversation",
		updatedAt: now,
	});
	return { chatId, durableConversationId, sessionId };
}

async function createWebUiSession(
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>["lifecycle"],
) {
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("lifecycle not ready");
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const durableConversationId = `durable-${sessionId}`;
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: null,
		createdAt: now,
		id: chatId,
		kind: "webui",
		platformConversationId: null,
		title: "Synthetic WebUI chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: null,
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "webui",
		platformConversationId: null,
		title: "Synthetic WebUI session",
		updatedAt: now,
	});
	return { chatId, durableConversationId, sessionId };
}

const outboundRows = async (
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>["lifecycle"],
	sessionId: string,
) => {
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("lifecycle not ready");
	return await database
		.select({
			contentText: messages.contentText,
			deliveryStatus: messages.deliveryStatus,
			durableEntryId: messages.durableEntryId,
			partsJson: messages.partsJson,
		})
		.from(messages)
		.where(and(eq(messages.conversationId, sessionId), eq(messages.direction, "outbound")));
};

describe("conversation-scoped immediate outbound", () => {
	test("persists a WebUI send and emits the live update without a channel", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createWebUiSession(lifecycle);
			const events: { readonly entryId?: unknown; readonly text?: unknown }[] = [];
			const dispose = lifecycle.hooks.on("after.reply", (payload) => {
				if (typeof payload === "object" && payload !== null) events.push(payload);
			});
			try {
				const result = await lifecycle.outbound.sendToConversation("sticker-meme", {
					conversationId: session.durableConversationId,
					parts: [{ sha256: "synthetic-sticker-hash", type: "sticker" }],
				});
				expect(result).toEqual({});
				const rows = await outboundRows(lifecycle, session.sessionId);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({ deliveryStatus: "sent" });
				expect(rows[0]?.durableEntryId).toMatch(/^outbound:/u);
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(events.some((event) => event.text === "[sticker]")).toBe(true);
				expect(lifecycle.replyDispatcher.hasDirectSendThisTurn(session.durableConversationId)).toBe(
					false,
				);
			} finally {
				dispose();
			}
		} finally {
			await lifecycle.stop();
		}
	});

	test("sends over the external channel and records a same-turn text emission", async () => {
		const { lifecycle, onebot } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			lifecycle.replyDispatcher.beginTurn(session.durableConversationId);
			const result = await lifecycle.outbound.sendToConversation("sticker-meme", {
				conversationId: session.durableConversationId,
				parts: [{ text: "Immediate line.", type: "text" }],
			});
			expect(result.platformMessageId).toBeDefined();
			const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
			expect(sent).toHaveLength(1);
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.map((row) => row.contentText)).toEqual(["Immediate line."]);
			expect(rows[0]?.deliveryStatus).toBe("sent");
			expect(lifecycle.replyDispatcher.hasDirectSendThisTurn(session.durableConversationId)).toBe(
				true,
			);

			// A conversation send must not create an audit row unless it fails.
			const auditRows = await lifecycle.domainDatabase?.select().from(auditLog);
			expect(auditRows?.some((row) => row.action === "channel.outbound-send")).toBe(false);
		} finally {
			await lifecycle.stop();
		}
	});

	test("a repeated text after an immediate conversation send is suppressed", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: { pacing: { replyDelayEnabled: false, sendIntervalMs: 0 } },
				scope: "conversation",
			});
			lifecycle.replyDispatcher.beginTurn(session.durableConversationId);
			await lifecycle.outbound.sendToConversation("sticker-meme", {
				conversationId: session.durableConversationId,
				parts: [{ text: "Already sent.", type: "text" }],
			});
			const answer = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-immediate",
				conversationId: session.durableConversationId,
				entryId: "entry-immediate",
				text: "Already sent.",
			});
			expect(answer).toMatchObject({ deliveryStatus: "suppressed" });
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.map((row) => row.contentText)).toEqual(["Already sent."]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("a same-conversation mid-turn tool send splits the running segment", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			const run = await lifecycle.conversationRuns.startRun({
				conversationId: session.sessionId,
				triggerMessageId: null,
			});
			await lifecycle.liveRuns.record(session.sessionId, {
				attempt: 1,
				conversationId: session.sessionId,
				draftTools: [],
				failure: undefined,
				generationStartedAtMs: undefined,
				model: undefined,
				partialText: "synthetic partial",
				partialThinking: "synthetic outbound split round",
				retry: undefined,
				settled: false,
				startedAtMs: Date.now(),
				tools: [],
				turns: 1,
			});

			const result = await lifecycle.outbound.send("onebot-napcat", {
				originConversationId: session.durableConversationId,
				parts: [{ text: "Mid-turn status.", type: "text" }],
				target: {
					channelId: "onebot",
					kind: "private",
					platformConversationId: "user-1",
				},
			});
			expect(result.platformMessageId).toBeDefined();

			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows).toHaveLength(1);
			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(
				session.sessionId,
			);
			expect(segments).toHaveLength(2);
			const [closed, continuation] = segments;
			const [messageRow] = await lifecycle
				.domainDatabase!.select({ id: messages.id, seq: messages.seq })
				.from(messages)
				.where(
					and(eq(messages.conversationId, session.sessionId), eq(messages.direction, "outbound")),
				)
				.limit(1);
			expect(closed).toMatchObject({
				finalMessageId: messageRow?.id,
				runId: run.anchor.runId,
				segmentIndex: 0,
				status: "completed",
				triggerKind: "initial",
			});
			expect(closed?.rounds).toMatchObject([
				{ thinking: "synthetic outbound split round", toolCalls: [] },
			]);
			expect(continuation).toMatchObject({
				runId: run.anchor.runId,
				segmentIndex: 1,
				status: "running",
				triggerKind: "initial",
				triggerMessageId: null,
			});
			expect(continuation?.seq).toBeGreaterThan(messageRow?.seq ?? 0);
			expect(await lifecycle.liveRuns.segmentAnchor(session.sessionId)).toMatchObject({
				runId: run.anchor.runId,
				segmentId: continuation?.id,
				segmentIndex: 1,
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a cross-conversation tool send leaves the target run segment unchanged", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-1",
			});
			const run = await lifecycle.conversationRuns.startRun({
				conversationId: session.sessionId,
				triggerMessageId: null,
			});
			await lifecycle.liveRuns.record(session.sessionId, {
				attempt: undefined,
				conversationId: session.sessionId,
				draftTools: [],
				failure: undefined,
				generationStartedAtMs: undefined,
				model: undefined,
				partialText: "synthetic cross-chat target partial",
				partialThinking: undefined,
				retry: undefined,
				runId: "synthetic-cross-chat-run",
				settled: false,
				startedAtMs: Date.now(),
				tools: [],
				turns: 0,
			});

			await lifecycle.outbound.send("onebot-napcat", {
				originConversationId: "synthetic-other-conversation",
				parts: [{ text: "Cross-chat note.", type: "text" }],
				target: {
					channelId: "onebot",
					kind: "group",
					platformConversationId: "group-1",
				},
			});

			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(
				session.sessionId,
			);
			expect(segments).toHaveLength(1);
			expect(segments[0]).toMatchObject({
				finalMessageId: null,
				runId: run.anchor.runId,
				segmentIndex: 0,
				status: "running",
			});
			expect(await lifecycle.liveRuns.segmentAnchor(session.sessionId)).toMatchObject({
				runId: run.anchor.runId,
				segmentId: run.anchor.segmentId,
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("transforms text with sticker markers via reply.transform hook before sending to external channel", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-outbound-conversation-"));
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
		const unsubscribe = lifecycle.hooks.on("reply.transform", async (payload) => {
			const p = payload as { text: string };
			if (p.text.includes("[表情:开心]")) {
				return {
					parts: [
						{ text: "看这个", type: "text" },
						{ mediaId: "media-happy-1", sha256: "sha-happy-1", type: "sticker" },
					],
				};
			}
			return undefined;
		});
		await lifecycle.start();
		onebot.connections[0]?.emitOpen();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-1",
			});
			await lifecycle.outbound.send("onebot-napcat", {
				originConversationId: "other-conversation",
				parts: [{ text: "看这个 [表情:开心]", type: "text" }],
				target: {
					channelId: "onebot",
					kind: "group",
					platformConversationId: "group-1",
				},
			});

			const sent = onebot.actions.filter((action) => action.action === "send_group_msg");
			expect(sent).toHaveLength(1);
			expect(sent[0]?.params?.group_id).toBe("group-1");
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows).toHaveLength(1);
			const parts = JSON.parse(rows[0]?.partsJson ?? "[]");
			expect(parts).toEqual([
				{ text: "看这个", type: "text" },
				{ mediaId: "media-happy-1", sha256: "sha-happy-1", type: "sticker" },
			]);
		} finally {
			unsubscribe();
			await lifecycle.stop();
		}
	}, 30_000);
});
