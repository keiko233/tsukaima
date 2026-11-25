import { describe, expect, test } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import type { MessagePage, MessageSummary, RunSegmentSummary } from "@tsukaima/contracts";
import {
	compareMessageOrder,
	mergeMessagePageRunSegments,
	mergeMessagePages,
	mergeRunSegments,
	type MessagePageParam,
} from "./message-pages";

function message(
	id: string,
	occurredAt: string,
	overrides: Partial<MessageSummary> = {},
): MessageSummary {
	return {
		contentText: id,
		direction: "inbound",
		deliveryMode: null,
		deliveryStatus: "sent",
		durableEntryId: null,
		id,
		kind: "webui",
		occurredAt,
		parts: [{ text: id, type: "text" }],
		platformMessageId: null,
		replyToMessageId: null,
		runId: null,
		segmentIndex: null,
		seq: 0,
		senderDisplayName: "Tester",
		senderExternalId: "tester",
		senderKind: "human",
		triggerClassification: "direct",
		...overrides,
	};
}

function segment(
	id: string,
	seq: number,
	overrides: Partial<RunSegmentSummary> = {},
): RunSegmentSummary {
	return {
		durationMs: null,
		endedAt: null,
		failureDetail: null,
		finalMessageId: null,
		id,
		rounds: [],
		runId: "run-1",
		segmentIndex: 0,
		seq,
		startedAt: "2026-01-01T00:00:00.000Z",
		status: "running",
		triggerKind: "initial",
		triggerMessageId: null,
		...overrides,
	};
}

function page(messages: MessageSummary[], runSegments: RunSegmentSummary[] = []): MessagePage {
	return { messages, nextCursor: null, runSegments };
}

function cache(pages: MessagePage[]): InfiniteData<MessagePage, MessagePageParam> {
	return { pageParams: pages.map(() => null), pages };
}

describe("message ordering", () => {
	test("orders by seq before the wall clock", () => {
		const rows = [
			message("later", "2026-01-01T00:00:03.000Z", { seq: 3 }),
			message("earlier", "2026-01-01T00:00:01.000Z", { seq: 1 }),
			message("middle", "2026-01-01T00:00:02.000Z", { seq: 2 }),
		];
		expect(rows.toSorted(compareMessageOrder).map((row) => row.id)).toEqual([
			"earlier",
			"middle",
			"later",
		]);
	});

	test("keeps legacy seq=0 rows before sequenced rows in timestamp order", () => {
		const rows = [
			message("sequenced", "2025-01-01T00:00:00.000Z", { seq: 1 }),
			message("legacy-b", "2026-01-01T00:00:01.000Z"),
			message("legacy-a", "2026-01-01T00:00:00.000Z"),
		];
		expect(rows.toSorted(compareMessageOrder).map((row) => row.id)).toEqual([
			"legacy-a",
			"legacy-b",
			"sequenced",
		]);
	});
});

describe("transcript page cache", () => {
	test("replaces a loaded row in place when its delivery status changes", () => {
		const data = cache([page([message("a", "2026-01-01T00:00:00.000Z")])]);
		const merged = mergeMessagePages(data, [
			message("a", "2026-01-01T00:00:00.000Z", { deliveryStatus: "failed" }),
		]);
		expect(merged.pages[0]?.messages).toHaveLength(1);
		expect(merged.pages[0]?.messages[0]?.deliveryStatus).toBe("failed");
		// The input cache is not mutated: React Query relies on a new reference to notify.
		expect(data.pages[0]?.messages[0]?.deliveryStatus).toBe("sent");
		expect(merged).not.toBe(data);
	});

	test("appends a new sequenced message to the newest page in transcript order", () => {
		const data = cache([
			page([message("b", "2026-01-01T00:00:02.000Z", { seq: 2 })]),
			page([message("a", "2026-01-01T00:00:01.000Z", { seq: 1 })]),
		]);
		const merged = mergeMessagePages(data, [
			message("c", "2026-01-01T00:00:03.000Z", { seq: 3 }),
			message("b2", "2026-01-01T00:00:02.000Z", { seq: 2 }),
		]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["b", "b2", "c"]);
		expect(merged.pages[1]?.messages.map((row) => row.id)).toEqual(["a"]);
	});

	test("preserves runSegments already attached to a page", () => {
		const runSegment = segment("segment-1", 2);
		const data = cache([
			page([message("a", "2026-01-01T00:00:01.000Z", { seq: 1 })], [runSegment]),
		]);
		const merged = mergeMessagePages(data, [message("b", "2026-01-01T00:00:03.000Z", { seq: 3 })]);
		expect(merged.pages[0]?.runSegments).toEqual([runSegment]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["a", "b"]);
	});

	test("updates a row on an older page without duplicating it on the newest page", () => {
		const data = cache([
			page([message("c", "2026-01-01T00:00:03.000Z", { seq: 3 })]),
			page([message("a", "2026-01-01T00:00:01.000Z", { seq: 1 })]),
		]);
		const merged = mergeMessagePages(data, [
			message("a", "2026-01-01T00:00:01.000Z", { deliveryStatus: "failed", seq: 1 }),
		]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["c"]);
		expect(merged.pages[1]?.messages[0]?.deliveryStatus).toBe("failed");
	});

	test("does not insert an unseen row older than the newest page", () => {
		const data = cache([
			page([message("c", "2026-01-01T00:00:03.000Z", { seq: 3 })]),
			page([message("b", "2026-01-01T00:00:02.000Z", { seq: 2 })]),
		]);
		const merged = mergeMessagePages(data, [message("a", "2026-01-01T00:00:01.000Z", { seq: 1 })]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["c"]);
	});

	test("orders equal timestamps by id and keeps older ties for the cursor page", () => {
		const data = cache([page([message("b", "2026-01-01T00:00:00.000Z", { seq: 2 })])]);
		const merged = mergeMessagePages(data, [
			message("a", "2026-01-01T00:00:00.000Z", { seq: 1 }),
			message("c", "2026-01-01T00:00:00.000Z", { seq: 3 }),
		]);
		// `a` sorts before the oldest loaded row, so it belongs to the next cursor page; `c`
		// follows the loaded row and can be appended without creating an overlap.
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["b", "c"]);
	});
});

describe("run segment page merge", () => {
	test("deduplicates segments across newest-first pages and prefers ended state", () => {
		const stale = segment("s-1", 2, {
			durationMs: null,
			endedAt: null,
			status: "running",
		});
		const fresh = segment("s-1", 2, {
			durationMs: 1_200,
			endedAt: "2026-01-01T00:00:02.000Z",
			rounds: [
				{
					roundIndex: 0,
					stopReason: "toolUse",
					thinking: "check",
					toolCalls: [],
				},
			],
			status: "steered",
		});
		const continuation = segment("s-2", 4, {
			endedAt: "2026-01-01T00:00:04.000Z",
			segmentIndex: 1,
			status: "completed",
			triggerKind: "steer",
		});
		const merged = mergeMessagePageRunSegments([
			page([], [fresh, continuation]),
			page([], [stale]),
		]);
		expect(merged.map((row) => row.id)).toEqual(["s-1", "s-2"]);
		expect(merged[0]).toEqual(fresh);
		expect(merged[1]).toEqual(continuation);
	});

	test("keeps two distinct segments that share a seq ordered by segmentIndex", () => {
		const merged = mergeRunSegments([
			segment("s-2", 5, { segmentIndex: 1 }),
			segment("s-1", 5, { segmentIndex: 0 }),
		]);
		expect(merged.map((row) => row.id)).toEqual(["s-1", "s-2"]);
	});
});
