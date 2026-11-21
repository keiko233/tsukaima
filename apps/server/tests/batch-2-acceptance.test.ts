import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { ChannelNotice, MessageEnvelope } from "@tsukaima/contracts";
import {
	createOpenAICompatibleModelPort,
	type DurableExtension,
	type ModelPort,
} from "@tsukaima/core";
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
	options: {
		model?: ModelPort;
		onebot?: ReturnType<typeof createOneBotTransportSpy>;
	} = {},
) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-2-server-"));
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
			...(options.model === undefined ? {} : { model: options.model }),
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
		title: "Main",
		updatedAt: now,
	});
	return { chatId, durableConversationId, sessionId };
}

async function waitFor<T>(
	read: () => T | Promise<T | undefined> | undefined,
	timeoutMs = 15_000,
): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

const privateEnvelope = (id: string, text: string, peerId: string): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Synthetic Tester", id: peerId, platformId: peerId },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

const groupEnvelope = (id: string, text: string, senderId: string): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { groupId: "group-1", kind: "group", peerId: senderId },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: `Member ${senderId}`, id: senderId, platformId: senderId },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

const pokeNotice = (id: string, input: { actorId: string; group?: boolean }): ChannelNotice => ({
	actorDisplayName: `Member ${input.actorId}`,
	actorId: input.actorId,
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: input.group
		? { groupId: "group-1", kind: "group" }
		: { kind: "private", peerId: input.actorId },
	details: { source: "test" },
	id,
	isSelfTarget: true,
	noticeType: "poke",
	occurredAtMs: Date.now(),
	targetUserId: "bot-account",
});

const completion = (content: string): Response =>
	Response.json({
		choices: [{ finish_reason: "stop", message: { content } }],
		id: "scripted-response",
		model: "scripted-model",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	});

const toolCompletion = (content: string, callId: string): Response =>
	Response.json({
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content,
					tool_calls: [
						{
							function: { arguments: "{}", name: "probe_tool" },
							id: callId,
							type: "function",
						},
					],
				},
			},
		],
		id: `scripted-${callId}`,
		model: "scripted-model",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	});

const outboundRows = async (
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>["lifecycle"],
	conversationId: string,
) => {
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("database missing");
	return database
		.select()
		.from(messages)
		.where(and(eq(messages.direction, "outbound"), eq(messages.conversationId, conversationId)))
		.orderBy(messages.occurredAt);
};

describe("Batch 2 acceptance: pacing and recent activity", () => {
	test("flushes a direct question without the settle wait and merges a rapid burst", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const direct = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			const startedAt = Date.now();
			await lifecycle.processEnvelope(
				privateEnvelope("direct-question", "are you there?", "user-1"),
			);
			const directAnswer = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, direct.sessionId);
				return rows.length > 0 ? rows[0] : undefined;
			});
			expect(Date.now() - startedAt).toBeLessThan(1_500);
			expect(directAnswer?.deliveryStatus).toBe("sent");

			const burst = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-2",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: burst.sessionId,
				policy: {
					pacing: {
						activeBurstWindowMs: 500,
						burstMaxWaitMs: 500,
						burstSettleMs: 200,
						replyDelayEnabled: false,
						sendIntervalMs: 0,
					},
				},
				scope: "conversation",
			});
			await lifecycle.processEnvelope(privateEnvelope("burst-one", "part one", "user-2"));
			await Bun.sleep(20);
			await lifecycle.processEnvelope(privateEnvelope("burst-two", "part two?", "user-2"));
			const merged = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, burst.sessionId);
				return rows.length > 0 ? rows : undefined;
			});
			await Bun.sleep(100);
			expect(merged).toHaveLength(1);
			expect(merged[0]?.deliveryStatus).toBe("sent");
			const inbound = await waitFor(async () => {
				const database = lifecycle.domainDatabase;
				if (database === undefined) throw new Error("database missing");
				const rows = await database
					.select()
					.from(messages)
					.where(
						and(eq(messages.direction, "inbound"), eq(messages.conversationId, burst.sessionId)),
					);
				return rows.length >= 2 ? rows : undefined;
			});
			expect(inbound.map((row) => row.platformMessageId).toSorted()).toEqual([
				"burst-one",
				"burst-two",
			]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("throttled recent activity promotes one ambient group message, then stays ambient", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const group = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: group.sessionId,
				policy: {
					pacing: {
						activeBurstWindowMs: 500,
						burstMaxWaitMs: 500,
						burstSettleMs: 50,
						replyDelayEnabled: false,
						sendIntervalMs: 0,
					},
					trigger: {
						groupAccess: "open",
						recentActivityEscalation: "throttled",
						recentActivityMinIntervalMs: 60_000,
					},
				},
				scope: "conversation",
			});
			lifecycle.conversationPacing.recordReply(group.durableConversationId);
			await lifecycle.processEnvelope(groupEnvelope("activity-one", "just chatting", "user-2"));
			const first = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, group.sessionId);
				return rows.length > 0 ? rows[0] : undefined;
			});
			expect(first?.deliveryStatus).toBe("sent");

			await lifecycle.processEnvelope(groupEnvelope("activity-two", "more chatter", "user-3"));
			await Bun.sleep(150);
			const rows = await outboundRows(lifecycle, group.sessionId);
			expect(rows).toHaveLength(1);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [secondInbound] = await database
				.select({ triggerClassification: messages.triggerClassification })
				.from(messages)
				.where(eq(messages.platformMessageId, "activity-two"));
			expect(secondInbound?.triggerClassification).toBe("ambient");

			await Bun.sleep(300);
			expect(await outboundRows(lifecycle, group.sessionId)).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});
});

describe("Batch 2 acceptance: narration and locks", () => {
	test("narrates before the tool finishes and strips the repeated prefix from the final answer", async () => {
		let releaseTool!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolStarted = false;
		const probe: DurableExtension = {
			name: "batch-2-server-probe",
			tools: [
				{
					callers: ["model"],
					description: "Block until the test releases it",
					execute: async () => {
						toolStarted = true;
						await gate;
						return { output: [{ text: "probe result", type: "text" }] };
					},
					name: "probe_tool",
					parameters: { properties: {}, type: "object" },
				},
			],
		};
		const requests: unknown[] = [];
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://scripted-tool.invalid/v1",
				fetch: (async (_input: string, init?: RequestInit) => {
					const request = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: readonly { readonly role?: string }[];
					};
					requests.push(request);
					const toolResults = (request.messages ?? []).filter(
						(message) => message.role === "tool",
					).length;
					if (toolResults === 0) return toolCompletion("Let me check.", "call-1");
					return completion("Let me check. Here it is.");
				}) as typeof fetch,
			},
			[{ maxOutputTokens: 4_096, modelId: "scripted-model", supportsTools: true }],
		);
		const { lifecycle, onebot } = await createLifecycle({ model });
		try {
			const host = lifecycle.conversationHost;
			if (host === undefined) throw new Error("host missing");
			host.installExtensions([probe]);
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: {
						narrationEnabled: true,
						narrationMinIntervalMs: 0,
						replyDelayEnabled: false,
						sendIntervalMs: 0,
						stripMarkdown: false,
					},
				},
				scope: "conversation",
			});
			await lifecycle.processEnvelope(
				privateEnvelope("narration-request", "check the tools", "user-1"),
			);
			const narration = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows.find((row) => row.durableEntryId?.startsWith("narration:") === true);
			});
			expect(toolStarted).toBe(true);
			expect(narration.contentText).toBe("Let me check.");
			expect(narration.deliveryStatus).toBe("sent");
			const sentBeforeRelease = onebot.actions.filter(
				(action) => action.action === "send_private_msg",
			);
			expect(sentBeforeRelease).toHaveLength(1);
			releaseTool();
			const final = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows.find(
					(row) => row.durableEntryId !== null && !row.durableEntryId.startsWith("narration:"),
				);
			});
			expect(final.contentText).toBe("Here it is.");
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows).toHaveLength(2);
			expect(requests).toHaveLength(2);
			const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
			expect(sent).toHaveLength(2);
		} finally {
			releaseTool();
			await lifecycle.stop();
		}
	});

	test("rate limits narration and suppresses it after a direct tool send", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: {
						narrationEnabled: true,
						narrationMinIntervalMs: 60_000,
						replyDelayEnabled: false,
						sendIntervalMs: 0,
					},
				},
				scope: "conversation",
			});
			const first = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "tool-preamble",
				narrationId: "narration:test:1",
				text: "First note.",
				toolNames: ["probe_tool"],
			});
			expect(first?.deliveryStatus).toBe("sent");
			const second = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "tool-preamble",
				narrationId: "narration:test:2",
				text: "Second note.",
				toolNames: ["probe_tool"],
			});
			expect(second).toMatchObject({ deliveryStatus: "skipped", reason: "rate_limited" });
			expect(await outboundRows(lifecycle, session.sessionId)).toHaveLength(1);

			await lifecycle.outbound.send("onebot-napcat", {
				parts: [{ text: "Already sent by the tool.", type: "text" }],
				target: { channelId: "onebot", kind: "private", platformConversationId: "user-1" },
			});
			const narrated = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "tool-preamble",
				narrationId: "narration:test:3",
				text: "Third note.",
				toolNames: ["probe_tool"],
			});
			expect(narrated).toMatchObject({ deliveryStatus: "skipped", reason: "direct-send" });
			const answer = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-direct-send",
				conversationId: session.durableConversationId,
				entryId: "entry-direct-send",
				text: "Already sent by the tool.",
			});
			expect(answer).toMatchObject({ deliveryStatus: "suppressed", reason: "already_shown" });
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.map((row) => row.contentText)).toEqual([
				"First note.",
				"Already sent by the tool.",
			]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("cancels in-flight narration and drops only the queued final answer of that turn", async () => {
		const { lifecycle, onebot } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: {
						narrationEnabled: true,
						narrationMinIntervalMs: 0,
						replyDelayEnabled: false,
						sendIntervalMs: 400,
						stripMarkdown: false,
					},
				},
				scope: "conversation",
			});
			const narrationTask = lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "tool-preamble",
				narrationId: "narration:cancel:1",
				text: "first bubble\nsecond bubble",
				toolNames: ["probe_tool"],
			});
			await waitFor(() =>
				onebot.actions.some((action) => action.action === "send_private_msg") ? true : undefined,
			);
			const oldAnswerTask = lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-cancelled-turn",
				conversationId: session.durableConversationId,
				entryId: "entry-cancelled-turn",
				text: "old final answer",
			});
			await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows.some((row) => row.durableEntryId === "entry-cancelled-turn") ? true : undefined;
			});
			expect(lifecycle.replyDispatcher.cancelPendingOutput(session.durableConversationId)).toBe(
				true,
			);
			await Promise.allSettled([narrationTask, oldAnswerTask]);
			const cancelled = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows.find((row) => row.durableEntryId === "entry-cancelled-turn");
			});
			expect(cancelled.deliveryStatus).toBe("failed");

			const next = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-next-turn",
				conversationId: session.durableConversationId,
				entryId: "entry-next-turn",
				text: "new turn answer",
			});
			expect(next?.deliveryStatus).toBe("sent");
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.find((row) => row.durableEntryId === "entry-next-turn")?.deliveryStatus).toBe(
				"sent",
			);
		} finally {
			await lifecycle.stop();
		}
	});

	test("inbound appends do not wait for inter-bubble sleeps and ambient chatter does not cancel", async () => {
		const { lifecycle, onebot } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: {
						replyDelayEnabled: false,
						sendIntervalMs: 500,
						stripMarkdown: false,
					},
				},
				scope: "conversation",
			});
			const delivery = lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-lock",
				conversationId: session.durableConversationId,
				entryId: "entry-lock",
				text: "one\ntwo\nthree",
			});
			await waitFor(() =>
				onebot.actions.some((action) => action.action === "send_group_msg") ? true : undefined,
			);
			const host = lifecycle.conversationHost;
			if (host === undefined) throw new Error("host missing");
			const startedAt = performance.now();
			await host.append({
				classification: "ambient",
				collectOnly: true,
				conversationId: session.durableConversationId,
				envelope: groupEnvelope("lock-append", "ambient while sending", "user-4"),
				submittedAtMs: Date.now(),
			});
			expect(performance.now() - startedAt).toBeLessThan(400);
			await lifecycle.processEnvelope(
				groupEnvelope("ambient-during-burst", "still chatting", "user-5"),
			);
			await delivery;
			const sent = onebot.actions.filter((action) => action.action === "send_group_msg");
			expect(sent).toHaveLength(3);
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.find((row) => row.durableEntryId === "entry-lock")?.deliveryStatus).toBe("sent");
		} finally {
			await lifecycle.stop();
		}
	});
});

describe("Batch 2 acceptance: lurk and truncation", () => {
	test("suppresses a standalone marker, sends prose that mentions it, and audits a cut answer", async () => {
		const { lifecycle, onebot } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: { replyDelayEnabled: false, sendIntervalMs: 0 },
				},
				scope: "conversation",
			});
			await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-lurk",
				conversationId: session.durableConversationId,
				entryId: "entry-lurk",
				text: "TSUKAIMA_LURK",
			});
			expect(await outboundRows(lifecycle, session.sessionId)).toHaveLength(0);

			await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-prose",
				conversationId: session.durableConversationId,
				entryId: "entry-prose",
				text: "The token TSUKAIMA_LURK is internal, sorry!\n<error>Error: synthetic tool failure</error>",
			});
			const prose = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows[0];
			});
			expect(prose.contentText).toBe("The token is internal, sorry!");

			await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-truncated",
				conversationId: session.durableConversationId,
				entryId: "entry-truncated",
				text: "A cut answer that just stops",
				truncated: true,
			});
			const truncated = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows.find((row) => row.durableEntryId === "entry-truncated");
			});
			expect(truncated.deliveryStatus).toBe("sent");
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			expect(
				(
					await database
						.select()
						.from(auditLog)
						.where(eq(auditLog.action, "message.answer-truncated"))
				).length,
			).toBe(1);
			expect(onebot.actions.filter((action) => action.action === "send_private_msg")).toHaveLength(
				2,
			);
		} finally {
			await lifecycle.stop();
		}
	});
});

describe("Batch 2 acceptance: poke notices", () => {
	test("wakes on a self poke and respects poke cooldown and access denial", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					notices: {
						pokeObserve: true,
						pokeWake: true,
						pokeWakeCooldownMs: 60_000,
					},
					pacing: { replyDelayEnabled: false, sendIntervalMs: 0 },
				},
				scope: "conversation",
			});
			await lifecycle.processNotice(pokeNotice("poke-1", { actorId: "user-1" }));
			const first = await waitFor(async () => {
				const rows = await outboundRows(lifecycle, session.sessionId);
				return rows.length > 0 ? rows[0] : undefined;
			});
			expect(first.deliveryStatus).toBe("sent");

			await lifecycle.processNotice(pokeNotice("poke-2", { actorId: "user-1" }));
			await Bun.sleep(100);
			expect(await outboundRows(lifecycle, session.sessionId)).toHaveLength(1);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const pokeAudits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "channel.poke-at-bot"))
				.orderBy(auditLog.occurredAt);
			expect(pokeAudits).toHaveLength(2);
			expect(pokeAudits[1]?.payloadJson).toContain('"wakeReason":"cooldown"');

			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: { trigger: { privateAccess: "disabled" } },
				scope: "conversation",
			});
			await lifecycle.processNotice(pokeNotice("poke-3", { actorId: "user-1" }));
			await Bun.sleep(100);
			expect(await outboundRows(lifecycle, session.sessionId)).toHaveLength(1);
			const denied = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "channel.poke-at-bot"))
				.orderBy(auditLog.occurredAt);
			expect(denied).toHaveLength(3);
			expect(denied[2]?.payloadJson).toContain('"wakeReason":"access disabled"');
		} finally {
			await lifecycle.stop();
		}
	});

	test("respects the reply cooldown and per-minute ceiling before waking", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					notices: { pokeObserve: true, pokeWake: true, pokeWakeCooldownMs: 0 },
					pacing: { maxRepliesPerMinute: 1, replyCooldownMs: 5_000 },
				},
				scope: "conversation",
			});
			lifecycle.conversationPacing.recordReply(session.durableConversationId);
			await lifecycle.processNotice(pokeNotice("poke-cooldown", { actorId: "user-1" }));
			await Bun.sleep(100);
			expect(await outboundRows(lifecycle, session.sessionId)).toHaveLength(0);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [audit] = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "channel.poke-at-bot"));
			expect(audit?.payloadJson).toContain('"wakeReason":"cooldown"');
		} finally {
			await lifecycle.stop();
		}
	});

	test("shows self pokes in the group observation window only while pokeObserve is enabled", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const group = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: group.sessionId,
				policy: { notices: { pokeObserve: true, pokeWake: false } },
				scope: "conversation",
			});
			await lifecycle.processNotice(
				pokeNotice("observation-poke", { actorId: "user-2", group: true }),
			);
			const visible = await lifecycle.contextProvider.renderTurnContext({
				conversationId: group.durableConversationId,
				inputs: [],
				nowMs: Date.now(),
				triggers: [],
			});
			const observation = visible.find((section) => section.key === "observation");
			expect(observation?.text).toContain("[poke]");
			expect(observation?.text).toContain("Member user-2");

			await lifecycle.conversationPolicy.update({
				conversationId: group.sessionId,
				policy: { notices: { pokeObserve: false } },
				scope: "conversation",
			});
			const hidden = await lifecycle.contextProvider.renderTurnContext({
				conversationId: group.durableConversationId,
				inputs: [],
				nowMs: Date.now(),
				triggers: [],
			});
			expect(hidden.find((section) => section.key === "observation")).toBeUndefined();
		} finally {
			await lifecycle.stop();
		}
	});
});

describe("Reply dispatcher turn-state hardening", () => {
	test("length-prefix narration is owed and bypasses direct-send, disabled, and rate-limit skips", async () => {
		const { lifecycle, onebot } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: {
						narrationEnabled: true,
						narrationMinIntervalMs: 60_000,
						replyDelayEnabled: false,
						sendIntervalMs: 0,
					},
				},
				scope: "conversation",
			});
			lifecycle.replyDispatcher.beginTurn(session.durableConversationId);
			const directSend = await lifecycle.outbound.send("onebot-napcat", {
				originConversationId: session.durableConversationId,
				parts: [{ text: "Tool already posted this.", type: "text" }],
				target: {
					channelId: "onebot",
					kind: "private",
					platformConversationId: "user-1",
				},
			});
			expect(directSend.platformMessageId).toBeDefined();
			const afterDirectSend = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "length-prefix",
				narrationId: "narration:length:direct",
				text: "Owed tail after a tool send.",
				toolNames: ["probe_tool"],
			});
			expect(afterDirectSend).toMatchObject({ deliveryStatus: "sent" });

			// A new turn resets direct-send state; only then does a preamble go out normally.
			lifecycle.replyDispatcher.beginTurn(session.durableConversationId);
			const firstPreamble = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "tool-preamble",
				narrationId: "narration:preamble:1",
				text: "A preamble.",
				toolNames: ["probe_tool"],
			});
			expect(firstPreamble).toMatchObject({ deliveryStatus: "sent" });
			const withinInterval = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "length-prefix",
				narrationId: "narration:length:rate",
				text: "Owed tail inside the narration interval.",
				toolNames: ["probe_tool"],
			});
			expect(withinInterval).toMatchObject({ deliveryStatus: "sent" });

			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: { pacing: { narrationEnabled: false } },
				scope: "conversation",
			});
			const disabled = await lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "length-prefix",
				narrationId: "narration:length:disabled",
				text: "Owed tail with narration disabled.",
				toolNames: ["probe_tool"],
			});
			expect(disabled).toMatchObject({ deliveryStatus: "sent" });

			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.map((row) => row.contentText)).toEqual([
				"Tool already posted this.",
				"Owed tail after a tool send.",
				"A preamble.",
				"Owed tail inside the narration interval.",
				"Owed tail with narration disabled.",
			]);
			const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
			expect(sent).toHaveLength(5);
		} finally {
			await lifecycle.stop();
		}
	});

	test("tool-send suppression never leaks into the next turn", async () => {
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
			lifecycle.replyDispatcher.recordTurnToolSend({
				durableConversationId: session.durableConversationId,
				text: "好的",
			});
			const suppressed = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-tool-dup",
				conversationId: session.durableConversationId,
				entryId: "entry-tool-dup",
				text: "好的",
			});
			expect(suppressed).toMatchObject({
				deliveryStatus: "suppressed",
				reason: "already_sent_via_tool",
			});

			lifecycle.replyDispatcher.beginTurn(session.durableConversationId);
			const legitimate = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-next-turn",
				conversationId: session.durableConversationId,
				entryId: "entry-next-turn",
				text: "好的",
			});
			expect(legitimate).toMatchObject({ deliveryStatus: "sent" });
			const rows = await outboundRows(lifecycle, session.sessionId);
			expect(rows.map((row) => row.durableEntryId)).toEqual(["entry-next-turn"]);
			expect(rows[0]?.contentText).toBe("好的");
		} finally {
			await lifecycle.stop();
		}
	});

	test("a cross-chat tool send never marks the target turn as already shown", async () => {
		const { lifecycle } = await createLifecycle();
		try {
			const chatA = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-a",
			});
			const chatB = await createExternalSession(lifecycle, {
				kind: "group",
				platformConversationId: "group-b",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: chatB.sessionId,
				policy: { pacing: { replyDelayEnabled: false, sendIntervalMs: 0 } },
				scope: "conversation",
			});
			lifecycle.replyDispatcher.beginTurn(chatB.durableConversationId);
			await lifecycle.outbound.send("onebot-napcat", {
				originConversationId: chatA.durableConversationId,
				parts: [{ text: "跨群消息", type: "text" }],
				target: { channelId: "onebot", kind: "group", platformConversationId: "group-b" },
			});
			expect(lifecycle.replyDispatcher.hasDirectSendThisTurn(chatB.durableConversationId)).toBe(
				false,
			);
			const answer = await lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-cross-chat-answer",
				conversationId: chatB.durableConversationId,
				entryId: "entry-cross-chat-answer",
				text: "跨群消息",
			});
			expect(answer).toMatchObject({ deliveryStatus: "sent" });
			const rows = await outboundRows(lifecycle, chatB.sessionId);
			expect(rows.map((row) => row.contentText)).toEqual(["跨群消息", "跨群消息"]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("a busy outbound lane delivers narration before the final answer", async () => {
		const { lifecycle, onebot } = await createLifecycle();
		try {
			const session = await createExternalSession(lifecycle, {
				kind: "private",
				platformConversationId: "user-1",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: session.sessionId,
				policy: {
					pacing: {
						narrationEnabled: true,
						narrationMinIntervalMs: 0,
						replyDelayEnabled: false,
						sendIntervalMs: 30,
						stripMarkdown: false,
					},
				},
				scope: "conversation",
			});
			const narration = lifecycle.replyDispatcher.handleNarration({
				conversationId: session.durableConversationId,
				kind: "tool-preamble",
				narrationId: "narration:lane:1",
				text: "first bubble\nsecond bubble",
				toolNames: ["probe_tool"],
			});
			const answer = lifecycle.replyDispatcher.handleAnswer({
				activityId: "activity-lane-order",
				conversationId: session.durableConversationId,
				entryId: "entry-lane-order",
				text: "final answer",
			});
			const [narrationOutcome, answerOutcome] = await Promise.all([narration, answer]);
			expect(narrationOutcome).toMatchObject({ deliveryStatus: "sent" });
			expect(answerOutcome).toMatchObject({ deliveryStatus: "sent" });
			const texts = onebot.actions
				.filter((action) => action.action === "send_private_msg")
				.map((action) => {
					const parts = action.params.message as Array<{ data?: { text?: string } }>;
					return parts[0]?.data?.text;
				});
			expect(texts).toEqual(["first bubble", "second bubble", "final answer"]);
		} finally {
			await lifecycle.stop();
		}
	});
});
