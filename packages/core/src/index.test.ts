import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openDurableStorage } from "@elaina/durable";
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
		const directory = await mkdtemp(join(tmpdir(), "elaina-core-"));
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
		const messages: unknown[] = [];
		const model = createFakeModel({
			onMessage: (message) => messages.push(message),
			responses: ["deterministic reply"],
		});
		expect(model.providerId).toBe("fake");
		expect(model.models.getModels("fake").length).toBeGreaterThan(0);
		const selected = model.models.getModel("fake", "fake-deterministic");
		if (selected === undefined) throw new Error("Fake model was not registered");
		const response = await model.models.completeSimple(
			selected,
			normalizeContext({
				messages: [{ content: "hello", role: "user", timestamp: 1 }],
			}),
		);
		expect(response.content).toEqual([{ text: "deterministic reply", type: "text" }]);
		expect(messages).toHaveLength(1);
	});

	test("flushes a collecting activity after the inactivity window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				policy: { maxMessages: 20, windowMs: 30 },
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: {
					...envelope("message-flush", "hello after idle"),
					source: { messageId: "message-flush", timestampMs: now },
				},
				submittedAtMs: now,
			});
			await Bun.sleep(150);
			const entries = await host.listEntries(conversationId);
			expect(entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
