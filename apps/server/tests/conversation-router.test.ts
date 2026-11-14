import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "@elaina/contracts";
import { identities, messages, users } from "@elaina/db";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

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

async function createLifecycle() {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-router-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		ELAINA_DATA_DIR: directory,
		ELAINA_PORT: "7420",
	});
	await lifecycle.start();
	return lifecycle;
}

describe("ConversationRouter ingestion boundary", () => {
	test("rejects an invalid envelope without persisting anything", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			const emptyParts: MessageEnvelope = { ...envelope("bad-1", "ignored"), parts: [] };
			await expect(lifecycle.processEnvelope(emptyParts)).rejects.toThrow(
				"Invalid message envelope",
			);

			const emptyName: MessageEnvelope = {
				...envelope("bad-2", "ignored"),
				sender: { displayName: "", id: "user-1", platformId: "user-1" },
			};
			await expect(lifecycle.processEnvelope(emptyName)).rejects.toThrow(
				"Invalid message envelope",
			);

			expect(lifecycle.lastProcessingError).toBeInstanceOf(Error);
			expect(await database.select({ id: messages.id }).from(messages)).toHaveLength(0);
			expect(await database.select({ id: users.id }).from(users)).toHaveLength(0);
			expect(await database.select({ id: identities.id }).from(identities)).toHaveLength(0);
		} finally {
			await lifecycle.stop();
		}
	});

	test("resolves a single canonical user under concurrent ingestion", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			await Promise.all([
				lifecycle.processEnvelope(envelope("concurrent-1", "first")),
				lifecycle.processEnvelope(envelope("concurrent-2", "second")),
			]);

			expect(await database.select({ id: users.id }).from(users)).toHaveLength(1);
			expect(await database.select({ id: identities.id }).from(identities)).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("persists a valid envelope as a single inbound message", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			await lifecycle.processEnvelope(envelope("valid-1", "hello"));

			const rows = await database
				.select({ contentText: messages.contentText, direction: messages.direction })
				.from(messages);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.direction).toBe("inbound");
			expect(rows[0]?.contentText).toBe("hello");
			expect(lifecycle.processedMessageCount).toBe(1);
		} finally {
			await lifecycle.stop();
		}
	});

	// Regression: a OneBot host runs its own clock. NapCat was observed ~36s ahead of the server,
	// so an inbound row stamped from the platform clock sorted *after* the assistant reply it
	// triggered, and the WebUI transcript read out of order. Ordering must use the local clock.
	test("orders an inbound message before the reply even when the platform clock runs ahead", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			const platformAheadMs = Date.now() + 36_000;
			await lifecycle.processEnvelope({
				...envelope("skewed-1", "clock skew"),
				source: {
					messageId: "skewed-1",
					receivedAtMs: Date.now(),
					timestampMs: platformAheadMs,
				},
			});

			const rows = await database
				.select({ occurredAt: messages.occurredAt, direction: messages.direction })
				.from(messages)
				.orderBy(messages.occurredAt);
			expect(rows).toHaveLength(1);
			// The platform timestamp must not leak into the ordering column.
			expect(Date.parse(rows[0]!.occurredAt)).toBeLessThan(platformAheadMs - 30_000);
		} finally {
			await lifecycle.stop();
		}
	});
});
