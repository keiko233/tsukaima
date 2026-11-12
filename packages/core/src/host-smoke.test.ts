import { describe, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@elaina/durable";
import { PiDurableConversationHost } from "./conversation-host.ts";

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

describe("host", () => {
	test("works", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({ storage });
			const conversationId = await host.createConversation();
			const first = await host.append({
				conversationId,
				envelope: envelope("m1", "hello"),
				submittedAtMs: 1,
			});
			console.log("first", first);
			const second = await host.append({
				conversationId,
				envelope: envelope("m2", "world"),
				submittedAtMs: 2,
			});
			console.log("second", second);
			const third = await host.append({
				conversationId,
				envelope: envelope("m3", "steer"),
				submittedAtMs: 3,
				whenBusy: "steer",
			});
			console.log("third", third);
			const fourth = await host.append({
				conversationId,
				envelope: envelope("m4", "follow-up"),
				submittedAtMs: 4,
				whenBusy: "follow-up",
			});
			console.log("fourth", fourth);
			await storage.close(BACKGROUND_CONTEXT);
			await host.close();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
