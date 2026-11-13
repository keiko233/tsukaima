import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelNotice, MessageEnvelope } from "@elaina/contracts";
import { messages } from "@elaina/db";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { listMessages } from "../src/services/webui.ts";

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

const pokeNotice = (
	id: string,
	noticeType: ChannelNotice["noticeType"] = "poke",
): ChannelNotice => ({
	actorDisplayName: "Keiko",
	actorId: "user-1",
	channelId: "onebot-test",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	details: { source: "test" },
	id,
	isSelfTarget: noticeType === "poke",
	noticeType,
	occurredAtMs: 2_000,
	targetUserId: "bot-account",
});

async function createLifecycle() {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-notice-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		ELAINA_DATA_DIR: directory,
		ELAINA_PORT: "7420",
	});
	await lifecycle.start();
	return lifecycle;
}

describe("ChannelNotice ingestion", () => {
	test("persists poke-at-bot as an attributed system/notice row without a model turn", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.processNotice(pokeNotice("notice-poke-1"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			const rows = await database.select().from(messages);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				contentText: "[poke] Keiko -> bot-account (bot)",
				direction: "system",
				kind: "notice",
				platformMessageId: "notice-poke-1",
				senderDisplayName: "Keiko",
				senderExternalId: "user-1",
			});
			const parts = JSON.parse(rows[0]?.partsJson ?? "[]") as unknown[];
			expect(parts).toEqual([
				expect.objectContaining({
					nativeType: "notice:poke",
					safeFields: { isSelfTarget: true },
					type: "channel-native",
				}),
			]);

			await lifecycle.processNotice(pokeNotice("notice-poke-1"));
			expect(await database.select().from(messages)).toHaveLength(1);

			const auditRows = await database.query.auditLog.findMany({
				where: (table, { eq: equals }) => equals(table.action, "channel.poke-at-bot"),
			});
			expect(auditRows).toHaveLength(1);
			expect(auditRows[0]).toMatchObject({
				actorId: "user-1",
				result: "ok",
				targetKind: "channel-user",
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("skips noisy typing rows but persists configurable ones", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.processNotice(pokeNotice("notice-typing-1", "typing"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			expect(await database.select().from(messages)).toHaveLength(0);

			await lifecycle.processNotice({
				...pokeNotice("notice-typing-2", "typing"),
				details: { persist: true },
			});
			expect(await database.select().from(messages)).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("reads legacy image/sticker rows through the WebUI message parser", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.processEnvelope(envelope("legacy-source", "hello"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			const [row] = await database.select().from(messages).limit(1);
			if (row === undefined) throw new Error("Message was not persisted");
			await database
				.update(messages)
				.set({
					partsJson: JSON.stringify([
						{ sha256: "legacy-image", type: "image" },
						{ sha256: "legacy-sticker", type: "sticker" },
					]),
				})
				.where(eq(messages.id, row.id));
			const list = await listMessages(lifecycle, row.conversationId);
			expect(list[0]?.parts).toEqual([
				{ sha256: "legacy-image", type: "image" },
				{ sha256: "legacy-sticker", type: "sticker" },
			]);
		} finally {
			await lifecycle.stop();
		}
	});
});
