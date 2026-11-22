import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationAnswer } from "@tsukaima/core";
import { chatObjects, conversations } from "@tsukaima/db";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

interface Harness {
	readonly lifecycle: ReturnType<typeof createApp>["lifecycle"];
}

async function createHarness(): Promise<Harness> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-turn-isolation-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		TSUKAIMA_DATA_DIR: directory,
		TSUKAIMA_PORT: "7420",
		TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
	});
	await lifecycle.start();
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("Domain database is not ready");
	await database.insert(chatObjects).values({
		channelId: null,
		id: "chat-1",
		kind: "webui",
		platformConversationId: null,
		title: "Synthetic WebUI chat",
	});
	await database.insert(conversations).values({
		channelId: null,
		chatObjectId: "chat-1",
		durableConversationId: "durable-1",
		id: "session-1",
		isReceiving: 1,
		kind: "webui",
		platformConversationId: null,
		title: "Synthetic WebUI session",
	});
	return { lifecycle };
}

const answer = (input: {
	readonly entryId: string;
	readonly recovered?: boolean;
	readonly text: string;
}): ConversationAnswer => ({
	conversationId: "durable-1",
	entryId: input.entryId,
	...(input.recovered === true ? { recovered: true } : {}),
	text: input.text,
});

const narration = (narrationId: string, text: string) => ({
	conversationId: "durable-1",
	kind: "tool-preamble" as const,
	narrationId,
	text,
	toolNames: ["synthetic.tool"],
});

describe("reply dispatcher turn isolation", () => {
	test("a mid-run follow-up admission does not reset the working turn's shown and tool-sent text", async () => {
		const { lifecycle } = await createHarness();
		try {
			const dispatcher = lifecycle.replyDispatcher;
			const beginCalls: string[] = [];
			const originalBegin = dispatcher.beginTurn.bind(dispatcher);
			dispatcher.beginTurn = (conversationId) => {
				beginCalls.push(conversationId);
				originalBegin(conversationId);
			};
			const conversationHost = lifecycle.conversationHost;
			if (conversationHost === undefined) throw new Error("conversation host missing");
			const options = (
				conversationHost as unknown as {
					options: {
						onTurnAdmitted: (turn: {
							readonly activityId: string;
							readonly conversationId: string;
							readonly midRun?: boolean;
							readonly senderExternalId?: string;
							readonly submissionRequestId: string;
							readonly whenBusy?: "steer" | "follow-up";
						}) => Promise<void>;
					};
				}
			).options;

			await options.onTurnAdmitted({
				activityId: "2:activity",
				conversationId: "durable-1",
				senderExternalId: "10001",
				submissionRequestId: "submission-turn-1",
				whenBusy: "follow-up",
			});
			expect(beginCalls).toEqual(["durable-1"]);
			await dispatcher.handleNarration(narration("narration-turn-1", "turn one preamble"));
			dispatcher.recordTurnToolSend({
				durableConversationId: "durable-1",
				text: "turn one tool text",
			});

			// The follow-up joins the still-working run instead of starting a new turn.
			await options.onTurnAdmitted({
				activityId: "2:activity",
				conversationId: "durable-1",
				midRun: true,
				senderExternalId: "10001",
				submissionRequestId: "submission-turn-2",
				whenBusy: "follow-up",
			});
			expect(beginCalls).toEqual(["durable-1"]);

			const suppressed = await dispatcher.handleAnswer(
				answer({ entryId: "answer-turn-1", text: "turn one preamble" }),
			);
			expect(suppressed).toMatchObject({
				deliveryStatus: "suppressed",
				reason: "already_shown",
			});

			// A tool send recorded before the mid-run admission still suppresses the final text.
			dispatcher.beginTurn("durable-1");
			dispatcher.recordTurnToolSend({
				durableConversationId: "durable-1",
				text: "turn three tool text",
			});
			await options.onTurnAdmitted({
				activityId: "2:activity",
				conversationId: "durable-1",
				midRun: true,
				senderExternalId: "10001",
				submissionRequestId: "submission-turn-3",
				whenBusy: "steer",
			});
			const toolSuppressed = await dispatcher.handleAnswer(
				answer({ entryId: "answer-turn-3", text: "turn three tool text" }),
			);
			expect(toolSuppressed).toMatchObject({
				deliveryStatus: "suppressed",
				reason: "already_sent_via_tool",
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a settled answer's async database reads never clear the next turn's narration", async () => {
		const { lifecycle } = await createHarness();
		try {
			const dispatcher = lifecycle.replyDispatcher;
			dispatcher.beginTurn("durable-1");
			// Turn 1 starts its answer handling; the synchronous capture happens before its first
			// await, so every statement below runs while it is suspended on the database.
			const turnOne = dispatcher.handleAnswer(
				answer({ entryId: "answer-turn-1", text: "turn one final" }),
			);
			dispatcher.beginTurn("durable-1");
			const turnTwoNarration = dispatcher.handleNarration(
				narration("narration-turn-2", "turn two preamble"),
			);
			const turnOneOutcome = await turnOne;
			expect(turnOneOutcome?.deliveryStatus).not.toBe("suppressed");
			await turnTwoNarration;
			const turnTwoOutcome = await dispatcher.handleAnswer(
				answer({ entryId: "answer-turn-2", text: "turn two preamble" }),
			);
			expect(turnTwoOutcome).toMatchObject({
				deliveryStatus: "suppressed",
				reason: "already_shown",
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a recovered answer does not read or clear the active live turn's state", async () => {
		const { lifecycle } = await createHarness();
		try {
			const dispatcher = lifecycle.replyDispatcher;
			dispatcher.beginTurn("durable-1");
			await dispatcher.handleNarration(narration("narration-live", "live preamble"));
			dispatcher.noteDirectSend("durable-1", "live tool send");
			expect(dispatcher.hasDirectSendThisTurn("durable-1")).toBe(true);

			const recovered = await dispatcher.handleAnswer(
				answer({ entryId: "recovered-answer", recovered: true, text: "recovered answer body" }),
			);
			expect(recovered?.deliveryStatus).toBe("sent");
			// The live turn is untouched: its direct-send flag, narration, and tool-send state
			// still suppress the live answer that follows.
			expect(dispatcher.hasDirectSendThisTurn("durable-1")).toBe(true);
			const live = await dispatcher.handleAnswer(
				answer({ entryId: "live-answer", text: "live preamble" }),
			);
			expect(live).toMatchObject({
				deliveryStatus: "suppressed",
				reason: "already_shown",
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a sticker send mid-turn neither blocks narration nor suppresses the final text", async () => {
		const { lifecycle } = await createHarness();
		try {
			const dispatcher = lifecycle.replyDispatcher;
			const events: { readonly entryId?: unknown }[] = [];
			const dispose = lifecycle.hooks.on("after.reply", (payload) => {
				if (typeof payload === "object" && payload !== null) events.push(payload);
			});
			try {
				dispatcher.beginTurn("durable-1");
				dispatcher.noteDirectSendParts("durable-1", [
					{ sha256: "synthetic-sticker-hash", type: "sticker" },
				]);
				expect(dispatcher.hasDirectSendThisTurn("durable-1")).toBe(false);
				const preamble = await dispatcher.handleNarration(
					narration("narration-sticker", "The sticker is on its way."),
				);
				// The narrative bubble is live for the WebUI as soon as it is persisted.
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(preamble).toMatchObject({ deliveryStatus: "sent" });
				expect(events.some((event) => event.entryId === "narration-sticker")).toBe(true);
				const final = await dispatcher.handleAnswer(
					answer({ entryId: "answer-after-sticker", text: "All set." }),
				);
				expect(final).toMatchObject({ deliveryStatus: "sent" });
				// An empty final answer after the sticker is a satisfied turn, not a missing reply.
				dispatcher.beginTurn("durable-1");
				dispatcher.noteDirectSendParts("durable-1", [
					{ sha256: "synthetic-sticker-hash-2", type: "sticker" },
				]);
				const empty = await dispatcher.handleAnswer(
					answer({ entryId: "answer-empty-after-sticker", text: "" }),
				);
				expect(empty).toMatchObject({ deliveryStatus: "suppressed", reason: "already_shown" });
			} finally {
				dispose();
			}
		} finally {
			await lifecycle.stop();
		}
	});

	test("a streamed line flush is delivered once and removed from the final answer", async () => {
		const { lifecycle } = await createHarness();
		try {
			const dispatcher = lifecycle.replyDispatcher;
			dispatcher.beginTurn("durable-1");
			const streamed = await dispatcher.handleNarration({
				conversationId: "durable-1",
				kind: "stream-line",
				narrationId: "stream:run-1:0",
				text: "Hello",
				toolNames: [],
			});
			expect(streamed).toMatchObject({ deliveryStatus: "sent" });
			const duplicate = await dispatcher.handleNarration({
				conversationId: "durable-1",
				kind: "stream-line",
				narrationId: "stream:run-1:0",
				text: "Hello",
				toolNames: [],
			});
			expect(duplicate).toMatchObject({ deliveryStatus: "skipped", reason: "duplicate" });
			const final = await dispatcher.handleAnswer(
				answer({ entryId: "answer-after-stream", text: "Hello\nWorld" }),
			);
			expect(final).toMatchObject({ deliveryStatus: "sent", text: "World" });
		} finally {
			await lifecycle.stop();
		}
	});

	test("streamed lines separated by blank lines are stripped cleanly from the final answer", async () => {
		const { lifecycle } = await createHarness();
		try {
			const dispatcher = lifecycle.replyDispatcher;
			dispatcher.beginTurn("durable-1");
			await dispatcher.handleNarration({
				conversationId: "durable-1",
				kind: "stream-line",
				narrationId: "stream:run-2:g0:0",
				text: "First paragraph.",
				toolNames: [],
			});
			await dispatcher.handleNarration({
				conversationId: "durable-1",
				kind: "stream-line",
				narrationId: "stream:run-2:g0:2",
				text: "Second paragraph.",
				toolNames: [],
			});
			const final = await dispatcher.handleAnswer(
				answer({
					entryId: "answer-blank-lines",
					text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
				}),
			);
			expect(final).toMatchObject({ deliveryStatus: "sent", text: "Third paragraph." });

			dispatcher.beginTurn("durable-1");
			await dispatcher.handleNarration({
				conversationId: "durable-1",
				kind: "stream-line",
				narrationId: "stream:run-3:g0:0",
				text: "Only line.",
				toolNames: [],
			});
			await dispatcher.handleNarration({
				conversationId: "durable-1",
				kind: "stream-line",
				narrationId: "stream:run-3:g0:2",
				text: "Closing line.",
				toolNames: [],
			});
			const suppressed = await dispatcher.handleAnswer(
				answer({
					entryId: "answer-all-blank-lines",
					text: "Only line.\n\nClosing line.",
				}),
			);
			expect(suppressed).toMatchObject({ deliveryStatus: "suppressed", reason: "already_shown" });
		} finally {
			await lifecycle.stop();
		}
	});
});
