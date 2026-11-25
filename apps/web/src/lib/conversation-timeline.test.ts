import { describe, expect, test } from "bun:test";
import type {
	LiveRunState,
	MessageSummary,
	RunRound,
	RunSegmentSummary,
} from "@tsukaima/contracts";
import {
	buildConversationTimeline,
	compareTimelineOrder,
	type ConversationTimelineItem,
} from "./conversation-timeline";

function message(id: string, seq: number, overrides: Partial<MessageSummary> = {}): MessageSummary {
	return {
		contentText: id,
		direction: "inbound",
		deliveryMode: null,
		deliveryStatus: "sent",
		durableEntryId: null,
		id,
		kind: "webui",
		occurredAt: `2026-01-01T00:00:0${Math.min(seq, 9)}.000Z`,
		parts: [{ text: id, type: "text" }],
		platformMessageId: null,
		replyToMessageId: null,
		runId: null,
		segmentIndex: null,
		seq,
		senderDisplayName: "Tester",
		senderExternalId: "tester",
		senderKind: "human",
		triggerClassification: "direct",
		...overrides,
	};
}

const round = (roundIndex: number, overrides: Partial<RunRound> = {}): RunRound => ({
	roundIndex,
	stopReason: "stop",
	toolCalls: [],
	...overrides,
});

function segment(
	id: string,
	seq: number,
	overrides: Partial<RunSegmentSummary> = {},
): RunSegmentSummary {
	return {
		durationMs: 1_200,
		endedAt: "2026-01-01T00:00:02.000Z",
		failureDetail: null,
		finalMessageId: null,
		id,
		rounds: [round(0, { thinking: `${id} thought` })],
		runId: "run-1",
		segmentIndex: 0,
		seq,
		startedAt: "2026-01-01T00:00:00.000Z",
		status: "completed",
		triggerKind: "initial",
		triggerMessageId: null,
		...overrides,
	};
}

function live(overrides: Partial<LiveRunState> = {}): LiveRunState {
	return {
		partialText: undefined,
		failure: undefined,
		settled: false,
		startedAtMs: 1_000,
		sessionId: "session-1",
		tools: [],
		turns: 0,
		...overrides,
	};
}

function ids(items: readonly ConversationTimelineItem[]): string[] {
	return items.map((item) => {
		if (item.kind === "message") return item.message.id;
		if (item.kind === "segment") return item.segment.id;
		return `live:${item.run.segmentId ?? item.run.runId ?? item.seq}`;
	});
}

describe("conversation timeline", () => {
	test("interleaves a steered run strictly by seq", () => {
		const timeline = buildConversationTimeline({
			messages: [
				message("user-1", 1),
				message("steer-1", 3, { deliveryMode: "steer" }),
				message("answer-1", 5, {
					direction: "outbound",
					runId: "run-1",
					segmentIndex: 1,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
			],
			runSegments: [
				segment("segment-0", 2, { status: "steered" }),
				segment("segment-1", 4, {
					finalMessageId: "answer-1",
					segmentIndex: 1,
					status: "completed",
					triggerKind: "steer",
				}),
			],
		});
		expect(ids(timeline)).toEqual(["user-1", "segment-0", "steer-1", "answer-1"]);
		const answer = timeline.find(
			(item) => item.kind === "message" && item.message.id === "answer-1",
		);
		expect(answer?.kind === "message" ? answer.segment?.id : undefined).toBe("segment-1");
		// The segment with the final answer is attached, never rendered twice.
		expect(
			timeline.some((item) => item.kind === "segment" && item.segment.id === "segment-1"),
		).toBe(false);
	});

	test("keeps an interrupted segment at its seq before the interrupting message and new run", () => {
		const timeline = buildConversationTimeline({
			messages: [
				message("user-1", 1),
				message("interrupt-1", 3, { deliveryMode: "interrupt" }),
				message("answer-2", 5, {
					direction: "outbound",
					runId: "run-2",
					segmentIndex: 0,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
			],
			runSegments: [
				segment("interrupted-1", 2, {
					status: "interrupted",
					rounds: [round(0, { stopReason: "aborted", thinking: "stopped here" })],
				}),
				segment("fresh-2", 4, {
					finalMessageId: "answer-2",
					runId: "run-2",
					status: "completed",
				}),
			],
		});
		expect(ids(timeline)).toEqual(["user-1", "interrupted-1", "interrupt-1", "answer-2"]);
		const interrupted = timeline.find(
			(item) => item.kind === "segment" && item.segment.id === "interrupted-1",
		);
		expect(interrupted?.kind === "segment" ? interrupted.segment.rounds : []).toHaveLength(1);
		expect(interrupted?.kind === "segment" ? interrupted.segment.status : undefined).toBe(
			"interrupted",
		);
	});

	test("overlays a live run onto its persisted segment instead of appending a bubble", () => {
		const running = segment("segment-1", 2, {
			durationMs: null,
			endedAt: null,
			rounds: [round(0, { thinking: "done thinking" })],
			status: "running",
		});
		const run = live({
			partialText: "streaming",
			rounds: [round(0, { thinking: "done thinking" })],
			runId: "run-1",
			segmentId: "segment-1",
			seq: 2,
			status: "running",
		});
		const timeline = buildConversationTimeline({
			liveRun: run,
			messages: [message("user-1", 1)],
			runSegments: [running],
		});
		expect(ids(timeline)).toEqual(["user-1", "segment-1"]);
		const item = timeline[1];
		expect(item?.kind).toBe("segment");
		expect(item?.kind === "segment" ? item.liveRun : undefined).toEqual(run);
		expect(timeline.filter((entry) => entry.kind === "live-run")).toHaveLength(0);
	});

	test("anchors a live run without a persisted segment at its own seq", () => {
		const timeline = buildConversationTimeline({
			liveRun: live({ runId: "run-1", segmentId: "segment-live", seq: 4 }),
			messages: [message("user-1", 1), message("later", 5)],
			runSegments: [],
		});
		expect(ids(timeline)).toEqual(["user-1", "live:segment-live", "later"]);
	});

	test("falls back to the end only when a live run has no seq", () => {
		const timeline = buildConversationTimeline({
			liveRun: live({ runId: "run-1", segmentId: "segment-live" }),
			messages: [message("user-1", 1), message("later", 5)],
			runSegments: [],
		});
		expect(ids(timeline)).toEqual(["user-1", "later", "live:segment-live"]);
	});

	test("a live segment takes its seq position even when its final message already exists", () => {
		const timeline = buildConversationTimeline({
			liveRun: live({
				partialText: "same answer",
				runId: "run-1",
				segmentId: "segment-1",
				seq: 2,
				status: "running",
			}),
			messages: [
				message("user-1", 1),
				message("answer-1", 3, {
					direction: "outbound",
					runId: "run-1",
					segmentIndex: 0,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
			],
			runSegments: [
				segment("segment-1", 2, {
					finalMessageId: "answer-1",
					status: "running",
				}),
			],
		});
		expect(ids(timeline)).toEqual(["user-1", "segment-1", "answer-1"]);
		const answer = timeline.find(
			(item) => item.kind === "message" && item.message.id === "answer-1",
		);
		expect(answer?.kind === "message" ? answer.segment : "missing").toBeUndefined();
	});

	test("does not put a copy of the final answer's rounds on narration rows", () => {
		const timeline = buildConversationTimeline({
			messages: [
				message("user-1", 1),
				message("narration-1", 3, {
					direction: "outbound",
					durableEntryId: "narration-1",
					runId: "run-1",
					segmentIndex: 0,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
				message("answer-1", 5, {
					direction: "outbound",
					runId: "run-1",
					segmentIndex: 0,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
			],
			runSegments: [segment("segment-1", 4, { finalMessageId: "answer-1" })],
		});
		const narration = timeline.find(
			(item) => item.kind === "message" && item.message.id === "narration-1",
		);
		const answer = timeline.find(
			(item) => item.kind === "message" && item.message.id === "answer-1",
		);
		expect(narration?.kind === "message" ? narration.segment : "missing").toBeUndefined();
		expect(answer?.kind === "message" ? answer.segment?.id : undefined).toBe("segment-1");
	});

	test("uses a run segment on a narration row only when no final row will own it", () => {
		const timeline = buildConversationTimeline({
			messages: [
				message("narration-1", 3, {
					direction: "outbound",
					runId: "run-1",
					segmentIndex: 0,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
			],
			runSegments: [
				segment("segment-1", 2, {
					finalMessageId: "answer-not-loaded",
					rounds: [round(0, { thinking: "visible work" })],
				}),
			],
		});
		const narration = timeline.find((item) => item.kind === "message");
		expect(narration?.kind === "message" ? narration.segment?.id : undefined).toBe("segment-1");
	});

	test("never resolves an empty segment onto a narration row", () => {
		const timeline = buildConversationTimeline({
			messages: [
				message("narration-1", 3, {
					direction: "outbound",
					runId: "run-1",
					segmentIndex: 0,
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
			],
			runSegments: [
				segment("segment-1", 2, {
					finalMessageId: "answer-not-loaded",
					rounds: [],
					status: "completed",
				}),
			],
		});
		const narration = timeline.find((item) => item.kind === "message");
		expect(narration?.kind === "message" ? narration.segment : "missing").toBeUndefined();
	});

	test("orders legacy rows before every sequenced item by timestamp then id", () => {
		const timeline = buildConversationTimeline({
			messages: [
				message("new-1", 1, { occurredAt: "2025-01-01T00:00:00.000Z" }),
				message("legacy-b", 0, { occurredAt: "2026-01-01T00:00:01.000Z" }),
				message("legacy-a", 0, { occurredAt: "2026-01-01T00:00:00.000Z" }),
			],
			runSegments: [],
		});
		expect(ids(timeline)).toEqual(["legacy-a", "legacy-b", "new-1"]);
	});

	test("breaks an equal seq by user, then segment, then assistant answer", () => {
		const items = buildConversationTimeline({
			messages: [
				message("answer", 2, {
					direction: "outbound",
					senderExternalId: "tsukaima",
					senderKind: "assistant",
				}),
				message("user", 2),
			],
			runSegments: [segment("segment", 2)],
		});
		expect(ids(items)).toEqual(["user", "segment", "answer"]);
		expect(items.toSorted(compareTimelineOrder)).toEqual(items);
	});

	test("deduplicates the same segment id before rendering", () => {
		const stale = segment("segment-1", 2, { endedAt: null, status: "running" });
		const fresh = segment("segment-1", 2, {
			endedAt: "2026-01-01T00:00:03.000Z",
			status: "steered",
		});
		const timeline = buildConversationTimeline({
			messages: [],
			runSegments: [fresh, stale],
		});
		expect(timeline).toHaveLength(1);
		expect(timeline[0]?.kind === "segment" ? timeline[0].segment.status : undefined).toBe(
			"steered",
		);
	});
});
