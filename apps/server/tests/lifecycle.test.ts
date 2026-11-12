import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import type { MessageEnvelope } from "@tsukaima/contracts";

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: 1_000 },
});

describe("server lifecycle with fake model", () => {
	test("starts, processes a fake-model message, and stops cleanly", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-e2e-"));
		try {
			const { app, lifecycle } = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});

			expect(lifecycle.state.state).toBe("starting");
			const healthResponse = await app.handle(new Request("http://localhost/healthz"));
			expect(healthResponse.status).toBe(200);
			const healthBody = (await healthResponse.json()) as { state: string };
			expect(healthBody.state).toBe("starting");

			const readyzBefore = await app.handle(new Request("http://localhost/readyz"));
			expect(readyzBefore.status).toBe(503);

			await lifecycle.start();
			expect(lifecycle.state.state).toBe("ready");
			expect(lifecycle.conversationHost).toBeDefined();
			expect(lifecycle.modelRouter).toBeDefined();
			expect(lifecycle.processedMessageCount).toBe(0);
			expect(lifecycle.routingPolicies.length).toBeGreaterThan(0);

			const postStartHealth = await app.handle(new Request("http://localhost/healthz"));
			expect(postStartHealth.status).toBe(200);
			const postStartBody = (await postStartHealth.json()) as { state: string };
			expect(postStartBody.state).toBe("ready");

			const host = lifecycle.conversationHost;
			if (host === undefined) {
				throw new Error("Conversation host not initialized");
			}
			const conversationId = await host.createConversation();
			const result = await host.append({
				conversationId,
				envelope: envelope("msg-1", "hello world"),
				submittedAtMs: Date.now(),
			});
			expect(result.messageId).toBe("msg-1");
			lifecycle.processedMessageCount += 1;
			expect(lifecycle.processedMessageCount).toBe(1);

			const readyzAfter = await app.handle(new Request("http://localhost/readyz"));
			expect(readyzAfter.status).toBe(204);

			await lifecycle.stop();
			const stopResponse = await app.handle(new Request("http://localhost/healthz"));
			expect(stopResponse.status).toBe(503);
			const stopBody = (await stopResponse.json()) as { state: string };
			expect(stopBody.state).toBe("maintenance");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
