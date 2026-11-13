import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryRow } from "@tsukaima/contracts";
import { MemoryRows } from "./memory-rows";

const memory: MemoryRow = {
	confidence: 0.9,
	content: "The project is called Aurora.",
	conversationId: "session-1",
	createdAt: "2026-11-13T10:00:00.000Z",
	createdBy: "agent",
	dedupeKey: "dedupe-1",
	embeddingModel: null,
	evidenceJson: null,
	expiresAt: null,
	extractionModel: "deterministic",
	extractionPromptVersion: "memory-extract-v1",
	id: "memory-1",
	importance: 0.8,
	kind: "fact",
	pinned: true,
	projectId: null,
	revokedAt: null,
	scope: "conversation",
	sourceActivityId: null,
	sourceConversationId: "session-1",
	sourceEntryId: null,
	sourceMessageId: "message-1",
	status: "pending",
	subjectUserId: null,
	summary: "Project is called Aurora",
	updatedAt: "2026-11-13T10:00:00.000Z",
	visibility: "private",
};

describe("memories WebUI", () => {
	test("renders scoped memory rows with status and pin metadata", () => {
		const html = renderToStaticMarkup(<MemoryRows memories={[memory]} />);
		expect(html).toContain("Project is called Aurora");
		expect(html).toContain("The project is called Aurora.");
		expect(html).toContain("0.90");
		expect(html).toContain("conversation/fact");
		expect(html).toContain("memory-1");
	});

	test("renders the empty state", () => {
		expect(renderToStaticMarkup(<MemoryRows memories={[]} />)).toContain("No memories match");
	});
});
