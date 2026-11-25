import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { createSlowStreamingModel } from "@tsukaima/core";
import { conversations, messages as messagesTable } from "@tsukaima/db";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createLocalChat, listMessagePage, listMessages } from "../src/services/webui.ts";

const directories: string[] = [];
const lifecycles: ReturnType<typeof createApp>["lifecycle"][] = [];

afterEach(async () => {
	await Promise.all(
		lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
	);
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "test-channel",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

async function start(options: { readonly model?: unknown } = {}) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-timeline-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7441",
		},
		options.model === undefined ? undefined : { model: options.model as never },
	);
	lifecycles.push(lifecycle);
	await lifecycle.start();
	return lifecycle;
}

async function waitFor<T>(
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 10_000,
): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("conversation timeline and run segments", () => {
	test("persists an inbound message before the reply and anchors the completed run after it", async () => {
		const lifecycle = await start();
		try {
			const result = await lifecycle.conversationRouter.ingest(
				envelope("timeline-inbound-1", "synthetic inbound"),
			);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			const [stored] = await database
				.select({ deliveryMode: messagesTable.deliveryMode, seq: messagesTable.seq })
				.from(messagesTable)
				.where(eq(messagesTable.platformMessageId, "timeline-inbound-1"))
				.limit(1);
			expect(stored?.deliveryMode ?? null).toBeNull();
			expect(stored?.seq ?? 0).toBeGreaterThan(0);

			const inbound = await waitFor(async () => {
				const rows = await listMessages(lifecycle, result.sessionId);
				return rows.find((row) => row.platformMessageId === "timeline-inbound-1");
			});
			const answer = await waitFor(async () => {
				const rows = await listMessages(lifecycle, result.sessionId);
				return rows.find((row) => row.senderKind === "assistant");
			});
			expect(answer.seq).toBeGreaterThan(inbound.seq);
			expect(answer.runId).not.toBeNull();
			expect(answer.segmentIndex).toBe(0);

			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(
				result.sessionId,
			);
			expect(segments).toHaveLength(1);
			expect(segments[0]).toMatchObject({
				finalMessageId: answer.id,
				segmentIndex: 0,
				status: "completed",
				triggerKind: "initial",
				triggerMessageId: inbound.id,
			});
			expect(segments[0]?.seq).toBeGreaterThan(inbound.seq);
			expect(segments[0]?.seq).toBeLessThan(answer.seq);

			const page = await listMessagePage(lifecycle, { sessionId: result.sessionId });
			expect(page.messages.map((message) => message.id)).toEqual([inbound.id, answer.id]);
			expect(page.runSegments.map((segment) => segment.id)).toEqual(
				segments[0] === undefined ? [] : [segments[0].id],
			);
		} finally {
			await lifecycle.stop();
		}
	});

	test("allocates strictly monotonic sequence numbers per conversation", async () => {
		const lifecycle = await start();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Sequence",
				title: "Sequence chat",
			});
			const first = await lifecycle.conversationRuns.allocateSeq(chat.sessionId);
			const second = await lifecycle.conversationRuns.allocateSeq(chat.sessionId);
			const third = await lifecycle.conversationRuns.allocateSeq(chat.sessionId);
			expect([first, second, third]).toEqual([1, 2, 3]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("splits a steered run into frozen and continuation segments around the steer message", async () => {
		const model = createSlowStreamingModel(
			["first ", "answer ", "still ", "streaming ", "when ", "steered"],
			{ delayMs: 40 },
		);
		const lifecycle = await start({ model });
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Steer",
				title: "Steer chat",
			});
			const first = await lifecycle.sessionMessaging.sendAgentMessage({
				deliveryMode: "steer",
				sessionId: chat.sessionId,
				text: "initial request",
			});
			await waitFor(async () => {
				const anchor = await lifecycle.conversationRuns.activeAnchor(chat.sessionId);
				return anchor?.segmentIndex === 0 ? true : undefined;
			});
			const steer = await lifecycle.sessionMessaging.sendAgentMessage({
				deliveryMode: "steer",
				sessionId: chat.sessionId,
				text: "steer the run",
			});
			await waitFor(async () => {
				const segments = await lifecycle.conversationRuns.listSegmentsForConversation(
					chat.sessionId,
				);
				const running = await lifecycle.conversationRuns.activeRun(chat.sessionId);
				await Promise.resolve();
				return segments.length >= 2 && segments[1]?.status === "completed" && running === undefined
					? segments
					: undefined;
			});

			const rows = await listMessages(lifecycle, chat.sessionId);
			const initialMessage = rows.find((row) => row.id === first.messageId);
			const steerMessage = rows.find((row) => row.id === steer.messageId);
			expect(steerMessage?.deliveryMode).toBe("steer");
			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(chat.sessionId);
			expect(segments.length).toBeGreaterThanOrEqual(2);
			const [firstSegment, secondSegment] = segments;
			expect(firstSegment).toMatchObject({
				segmentIndex: 0,
				status: "steered",
				triggerKind: "initial",
				triggerMessageId: first.messageId,
			});
			expect(secondSegment).toMatchObject({
				segmentIndex: 1,
				status: "completed",
				triggerKind: "steer",
				triggerMessageId: steer.messageId,
			});
			expect(firstSegment?.seq).toBeGreaterThan(initialMessage?.seq ?? 0);
			expect(steerMessage?.seq).toBeGreaterThan(firstSegment?.seq ?? 0);
			expect(secondSegment?.seq).toBeGreaterThan(steerMessage?.seq ?? 0);
			expect(firstSegment?.rounds.length).toBeGreaterThan(0);
			expect(secondSegment?.rounds.length).toBeGreaterThan(0);
			expect(firstSegment?.finalMessageId).toBeNull();
			expect(secondSegment?.finalMessageId).not.toBeNull();
		} finally {
			await lifecycle.stop();
		}
	}, 30_000);

	test("freezes an interrupted run before the interrupting message starts a fresh run", async () => {
		let call = 0;
		const model = createSlowStreamingModel([], {
			chunksForCall: () => {
				call += 1;
				return call === 1
					? ["slow ", "initial ", "answer ", "that ", "gets ", "interrupted"]
					: ["fresh ", "reply"];
			},
			delayMs: 55,
		});
		const lifecycle = await start({ model });
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Interrupt",
				title: "Interrupt chat",
			});
			const first = await lifecycle.sessionMessaging.sendAgentMessage({
				sessionId: chat.sessionId,
				text: "start a slow run",
			});
			await waitFor(async () => {
				const state = await lifecycle.liveRuns.snapshot(chat.sessionId);
				return state !== undefined && !state.settled && (state.partialText?.length ?? 0) > 0
					? state
					: undefined;
			});
			const interrupt = await lifecycle.sessionMessaging.sendAgentMessage({
				deliveryMode: "interrupt",
				sessionId: chat.sessionId,
				text: "stop and answer this",
			});
			await waitFor(async () => {
				const rows = await listMessages(lifecycle, chat.sessionId);
				const fresh = rows.find(
					(row) => row.senderKind === "assistant" && row.contentText.includes("fresh"),
				);
				const running = await lifecycle.conversationRuns.activeRun(chat.sessionId);
				await Promise.resolve();
				return fresh !== undefined && running === undefined ? fresh : undefined;
			});

			const rows = await listMessages(lifecycle, chat.sessionId);
			const interruptMessage = rows.find((row) => row.id === interrupt.messageId);
			expect(interruptMessage?.deliveryMode).toBe("interrupt");
			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(chat.sessionId);
			const interrupted = segments.find((segment) => segment.status === "interrupted");
			const completed = segments.find(
				(segment) => segment.status === "completed" && segment.seq > (interruptMessage?.seq ?? 0),
			);
			expect(interrupted).toBeDefined();
			expect(completed).toBeDefined();
			expect(interruptMessage?.seq).toBeGreaterThan(interrupted?.seq ?? 0);
			expect(completed?.seq).toBeGreaterThan(interruptMessage?.seq ?? 0);
			expect(interrupted?.rounds.length).toBeGreaterThan(0);
			const [firstRun] = await waitFor(async () => {
				const segmentsNow = await lifecycle.conversationRuns.listSegmentsForConversation(
					chat.sessionId,
				);
				const run = await lifecycle.conversationRuns.getRun(segmentsNow[0]?.runId ?? "");
				return run === undefined ? undefined : ([run] as const);
			});
			expect(firstRun?.status).toBe("interrupted");
			expect(rows.some((row) => row.id === first.messageId)).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	}, 30_000);

	test("stores follow-up delivery mode and starts its run after the follow-up message", async () => {
		let call = 0;
		const model = createSlowStreamingModel([], {
			chunksForCall: () => {
				call += 1;
				return call === 1 ? ["first ", "answer"] : ["follow ", "answer"];
			},
			delayMs: 70,
		});
		const lifecycle = await start({ model });
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Follow-up",
				title: "Follow-up chat",
			});
			await lifecycle.sessionMessaging.sendAgentMessage({
				sessionId: chat.sessionId,
				text: "first request",
			});
			await waitFor(async () => {
				const anchor = await lifecycle.conversationRuns.activeAnchor(chat.sessionId);
				return anchor === undefined ? undefined : true;
			});
			const followUp = await lifecycle.sessionMessaging.sendAgentMessage({
				deliveryMode: "follow-up",
				sessionId: chat.sessionId,
				text: "after this turn",
			});
			const rows = await listMessages(lifecycle, chat.sessionId);
			const followMessage = rows.find((row) => row.id === followUp.messageId);
			expect(followMessage?.deliveryMode).toBe("follow-up");
			expect(followMessage?.seq ?? 0).toBeGreaterThan(0);

			await waitFor(async () => {
				const reply = (await listMessages(lifecycle, chat.sessionId)).find(
					(row) => row.senderKind === "assistant" && row.contentText.includes("follow"),
				);
				const running = await lifecycle.conversationRuns.activeRun(chat.sessionId);
				await Promise.resolve();
				return reply !== undefined && running === undefined ? reply : undefined;
			});
			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(chat.sessionId);
			const followSegment = segments.find(
				(segment) => segment.triggerMessageId === followUp.messageId,
			);
			expect(followSegment).toBeDefined();
			expect(followSegment?.seq).toBeGreaterThan(followMessage?.seq ?? 0);
			expect(followSegment?.status).toBe("completed");
		} finally {
			await lifecycle.stop();
		}
	}, 30_000);

	test("splits a segment for a trigger message and preserves frozen rounds on interrupt", async () => {
		const lifecycle = await start();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Service",
				title: "Service chat",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			const rounds = [
				{
					roundIndex: 0,
					stopReason: "toolUse" as const,
					thinking: "inspect the fixture",
					toolCalls: [
						{
							argumentsText: '{"path":"README.md"}',
							callId: "call-1",
							isError: false,
							output: "fixture",
							toolName: "read",
						},
					],
				},
			];
			const run = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			await lifecycle.conversationRuns.syncSegmentRounds(run.anchor.segmentId, rounds);
			const split = await lifecycle.conversationRuns.splitSegmentForSteer({
				conversationId: chat.sessionId,
				currentRounds: rounds,
				persistTrigger: async ({ seq }) => {
					await database.insert(messagesTable).values({
						contentText: "steer trigger",
						conversationId: chat.sessionId,
						deliveryMode: "steer",
						direction: "inbound",
						id: "steer-trigger-row",
						kind: "webui",
						occurredAt: new Date().toISOString(),
						seq,
					});
					return "steer-trigger-row";
				},
			});
			expect(split).toBeDefined();
			expect(split?.closedSegment.status).toBe("steered");
			expect(JSON.parse(split?.closedSegment.roundsJson ?? "[]")).toEqual(rounds);
			expect(split?.triggerSeq).toBeGreaterThan(run.anchor.seq);
			expect(split?.segment.seq).toBeGreaterThan(split?.triggerSeq ?? 0);
			expect(split?.segment).toMatchObject({
				segmentIndex: 1,
				triggerKind: "steer",
			});
			expect(
				await lifecycle.conversationRuns.getSegmentById(split?.segment.segmentId ?? ""),
			).toMatchObject({ triggerMessageId: "steer-trigger-row" });

			const nextRounds = [
				{
					roundIndex: 0,
					stopReason: "stop" as const,
					thinking: "continue after steering",
					toolCalls: [],
				},
			];
			await lifecycle.conversationRuns.syncSegmentRounds(split!.segment.segmentId, nextRounds);
			const interrupted = await lifecycle.conversationRuns.interruptActiveRun(chat.sessionId);
			expect(interrupted).toMatchObject({
				status: "interrupted",
				triggerMessageId: "steer-trigger-row",
			});
			expect(interrupted?.rounds).toEqual(nextRounds);
			const afterInterrupt = await lifecycle.conversationRuns.allocateSeq(chat.sessionId);
			expect(afterInterrupt).toBeGreaterThan(split?.segment.seq ?? 0);
			const fresh = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			expect(fresh.anchor.runId).not.toBe(split?.segment.runId);
			expect(fresh.anchor.seq).toBeGreaterThan(afterInterrupt);
		} finally {
			await lifecycle.stop();
		}
	});

	test("returns trailing segments on the newest page and only in-range segments on older pages", async () => {
		const lifecycle = await start();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Segments",
				title: "Segment range",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			const insert = async (id: string) => {
				const seq = await lifecycle.conversationRuns.allocateSeq(chat.sessionId);
				await database.insert(messagesTable).values({
					conversationId: chat.sessionId,
					direction: "inbound",
					id,
					kind: "webui",
					occurredAt: new Date(1_000 + seq).toISOString(),
					seq,
				});
				return seq;
			};
			await insert("m-1");
			const segmentA = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			await insert("m-2");
			const segmentB = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			await insert("m-3");
			const segmentC = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			await insert("m-4");
			await insert("m-5");
			await insert("m-6");
			const trailing = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});

			const newest = await listMessagePage(lifecycle, {
				limit: 2,
				sessionId: chat.sessionId,
			});
			expect(newest.messages.map((message) => message.id)).toEqual(["m-5", "m-6"]);
			expect(newest.runSegments.map((segment) => segment.id)).toEqual([trailing.anchor.segmentId]);
			if (newest.nextCursor === null) throw new Error("Expected an older page");
			const older = await listMessagePage(lifecycle, {
				cursor: newest.nextCursor,
				limit: 2,
				sessionId: chat.sessionId,
			});
			expect(older.messages.map((message) => message.id)).toEqual(["m-3", "m-4"]);
			expect(older.runSegments.map((segment) => segment.id)).toEqual([segmentC.anchor.segmentId]);
			expect([segmentA.anchor.seq, segmentB.anchor.seq]).toEqual([2, 4]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("orders sequenced rows before legacy rows and returns segments for the page range", async () => {
		const lifecycle = await start();
		try {
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Paged",
				title: "Paged chat",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			await database.insert(messagesTable).values([
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "legacy-1",
					kind: "webui",
					occurredAt: "2026-12-01T00:00:00.000Z",
					seq: 0,
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "legacy-2",
					kind: "webui",
					occurredAt: "2026-12-01T00:00:01.000Z",
					seq: 0,
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "sequenced-1",
					kind: "webui",
					occurredAt: "2025-01-01T00:00:00.000Z",
					seq: 1,
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "sequenced-2",
					kind: "webui",
					occurredAt: "2025-01-01T00:00:01.000Z",
					seq: 2,
				},
				{
					conversationId: chat.sessionId,
					direction: "inbound",
					id: "sequenced-3",
					kind: "webui",
					occurredAt: "2025-01-01T00:00:02.000Z",
					seq: 3,
				},
			]);
			const [session] = await database
				.select()
				.from(conversations)
				.where(eq(conversations.id, chat.sessionId))
				.limit(1);
			if (session === undefined) throw new Error("Session missing");
			await database
				.update(conversations)
				.set({ nextSeq: 10 })
				.where(eq(conversations.id, chat.sessionId));
			const firstRun = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			await lifecycle.conversationRuns.settleRun({
				conversationId: chat.sessionId,
				status: "completed",
			});
			const secondRun = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});
			await lifecycle.conversationRuns.settleRun({
				conversationId: chat.sessionId,
				status: "suppressed",
			});
			const trailing = await lifecycle.conversationRuns.startRun({
				conversationId: chat.sessionId,
			});

			const firstPage = await listMessagePage(lifecycle, {
				limit: 3,
				sessionId: chat.sessionId,
			});
			expect(firstPage.messages.map((message) => message.id)).toEqual([
				"sequenced-1",
				"sequenced-2",
				"sequenced-3",
			]);
			expect(firstPage.runSegments.map((segment) => segment.id)).toEqual([
				firstRun.anchor.segmentId,
				secondRun.anchor.segmentId,
				trailing.anchor.segmentId,
			]);
			if (firstPage.nextCursor === null) throw new Error("Expected an older page");
			const secondPage = await listMessagePage(lifecycle, {
				cursor: firstPage.nextCursor,
				limit: 3,
				sessionId: chat.sessionId,
			});
			expect(secondPage.messages.map((message) => message.id)).toEqual(["legacy-1", "legacy-2"]);
			expect(secondPage.runSegments).toEqual([]);
			expect(secondPage.nextCursor).toBeNull();
			expect((await listMessages(lifecycle, chat.sessionId)).map((row) => row.id)).toEqual([
				"legacy-1",
				"legacy-2",
				"sequenced-1",
				"sequenced-2",
				"sequenced-3",
			]);
		} finally {
			await lifecycle.stop();
		}
	});
});
