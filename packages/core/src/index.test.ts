import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableStorage } from "@tsukaima/durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDurableConversationHost } from "./conversation-host.ts";
import { createFakeModel } from "./model.ts";

const envelope = (id: string, text: string) => ({
	channelId: "test",
	channelKind: "webui" as const,
	conversationKey: { kind: "webui" as const },
	id,
	mentions: [],
	parts: [{ text, type: "text" as const }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { timestampMs: 1 },
});

describe("PiDurableConversationHost", () => {
	test("aggregates messages in a window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({ storage });
			const conversationId = await host.createConversation();
			const first = await host.append({
				conversationId,
				envelope: envelope("message-1", "hello"),
				submittedAtMs: 1_000,
			});
			const second = await host.append({
				conversationId,
				envelope: envelope("message-2", "world"),
				submittedAtMs: 2_000,
			});
			expect(first.activityId).toBe("2:activity");
			expect(second.activityId).toBe("2:activity");
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("uses the deterministic fake model", async () => {
		const model = createFakeModel({ responses: ["deterministic reply"] });
		expect(model.providerId).toBe("fake");
		expect(model.models.getModels("fake").length).toBeGreaterThan(0);
	});
});
