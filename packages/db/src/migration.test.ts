import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

test("backfills legacy conversations into stable chat objects and receiving sessions", async () => {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-migration-"));
	directories.push(directory);
	const database = new Database(join(directory, "domain.sqlite"), { create: true });
	const migrations = join(import.meta.dir, "../drizzle");
	database.exec(await Bun.file(join(migrations, "0000_robust_jack_flag.sql")).text());
	database.exec(await Bun.file(join(migrations, "0001_short_scarlet_spider.sql")).text());
	database
		.query(
			`INSERT INTO conversations (
			id, durable_conversation_id, kind, channel_id, platform_conversation_id, title, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run("legacy-session", "7", "private", "onebot", "user-42", "Legacy chat", "active");
	database
		.query(
			`INSERT INTO messages (
			id, conversation_id, platform_message_id, direction, kind, occurred_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			"legacy-message",
			"legacy-session",
			"platform-1",
			"inbound",
			"onebot-v11",
			"2026-01-01T00:00:00.000Z",
		);

	database.exec(await Bun.file(join(migrations, "0002_redundant_corsair.sql")).text());

	const chat = database
		.query("SELECT id, title, platform_conversation_id FROM chat_objects")
		.get() as { id: string; platform_conversation_id: string; title: string };
	expect(chat).toEqual({
		id: "chat_legacy-session",
		platform_conversation_id: "user-42",
		title: "Legacy chat",
	});
	const session = database
		.query("SELECT chat_object_id, is_receiving FROM conversations WHERE id = ?")
		.get("legacy-session") as { chat_object_id: string; is_receiving: number };
	expect(session).toEqual({ chat_object_id: "chat_legacy-session", is_receiving: 1 });
	const message = database
		.query("SELECT chat_object_id FROM messages WHERE id = ?")
		.get("legacy-message") as { chat_object_id: string };
	expect(message.chat_object_id).toBe("chat_legacy-session");
	database.close();
});
