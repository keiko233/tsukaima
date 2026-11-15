import { describe, expect, test } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import type { MessagePage, MessageSummary } from "@elaina/contracts";
import { mergeMessagePages, type MessagePageParam } from "./message-pages";

function message(
	id: string,
	occurredAt: string,
	overrides: Partial<MessageSummary> = {},
): MessageSummary {
	return {
		contentText: id,
		direction: "inbound",
		deliveryStatus: "sent",
		durableEntryId: null,
		id,
		kind: "webui",
		occurredAt,
		parts: [{ text: id, type: "text" }],
		platformMessageId: null,
		replyToMessageId: null,
		senderDisplayName: "Tester",
		senderExternalId: "tester",
		senderKind: "human",
		triggerClassification: "direct",
		...overrides,
	};
}

function cache(pages: MessagePage[]): InfiniteData<MessagePage, MessagePageParam> {
	return { pageParams: pages.map(() => null), pages };
}

describe("transcript page cache", () => {
	test("replaces a loaded row in place when its delivery status changes", () => {
		const data = cache([
			{ messages: [message("a", "2026-01-01T00:00:00.000Z")], nextCursor: null },
		]);
		const merged = mergeMessagePages(data, [
			message("a", "2026-01-01T00:00:00.000Z", { deliveryStatus: "failed" }),
		]);
		expect(merged.pages[0]?.messages).toHaveLength(1);
		expect(merged.pages[0]?.messages[0]?.deliveryStatus).toBe("failed");
		// The input cache is not mutated: React Query relies on a new reference to notify.
		expect(data.pages[0]?.messages[0]?.deliveryStatus).toBe("sent");
		expect(merged).not.toBe(data);
	});

	test("appends a new message to the newest page in transcript order", () => {
		const data = cache([
			{ messages: [message("b", "2026-01-01T00:00:02.000Z")], nextCursor: null },
			{ messages: [message("a", "2026-01-01T00:00:01.000Z")], nextCursor: null },
		]);
		const merged = mergeMessagePages(data, [
			message("c", "2026-01-01T00:00:03.000Z"),
			message("b2", "2026-01-01T00:00:02.000Z"),
		]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["b", "b2", "c"]);
		expect(merged.pages[1]?.messages.map((row) => row.id)).toEqual(["a"]);
	});

	test("updates a row on an older page without duplicating it on the newest page", () => {
		const data = cache([
			{ messages: [message("c", "2026-01-01T00:00:03.000Z")], nextCursor: "cursor-1" },
			{ messages: [message("a", "2026-01-01T00:00:01.000Z")], nextCursor: null },
		]);
		const merged = mergeMessagePages(data, [
			message("a", "2026-01-01T00:00:01.000Z", { deliveryStatus: "failed" }),
		]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["c"]);
		expect(merged.pages[1]?.messages[0]?.deliveryStatus).toBe("failed");
	});

	test("does not insert an unseen row older than the newest page", () => {
		const data = cache([
			{ messages: [message("c", "2026-01-01T00:00:03.000Z")], nextCursor: "cursor-1" },
			{ messages: [message("b", "2026-01-01T00:00:02.000Z")], nextCursor: null },
		]);
		const merged = mergeMessagePages(data, [message("a", "2026-01-01T00:00:01.000Z")]);
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["c"]);
	});

	test("orders equal timestamps by id and keeps older ties for the cursor page", () => {
		const data = cache([
			{ messages: [message("b", "2026-01-01T00:00:00.000Z")], nextCursor: "cursor-1" },
		]);
		const merged = mergeMessagePages(data, [
			message("a", "2026-01-01T00:00:00.000Z"),
			message("c", "2026-01-01T00:00:00.000Z"),
		]);
		// `a` sorts before the oldest loaded row, so it belongs to the next cursor page; `c`
		// follows the loaded row and can be appended without creating an overlap.
		expect(merged.pages[0]?.messages.map((row) => row.id)).toEqual(["b", "c"]);
	});
});
