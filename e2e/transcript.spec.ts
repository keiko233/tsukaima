import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createLocalChat, openAuthenticatedPage } from "./helpers.ts";
import { readStackRuntime } from "./stack.ts";

const SEEDED_MESSAGES = 120;

/**
 * The WebUI transcript is cursor-paged. Seed a long history directly so the test exercises the
 * virtualizer and the older-page request, not only the first page the composer created.
 */
function seedTranscript(input: { count: number; databasePath: string; title: string }): void {
	const script = `
		import { Database } from "bun:sqlite";
		const database = new Database(process.env.ELAINA_E2E_DB);
		const chat = database
			.query("SELECT id FROM chat_objects WHERE title = ? LIMIT 1")
			.get(process.env.ELAINA_E2E_TITLE);
		if (chat === null) throw new Error("Seeded chat was not found");
		const session = database
			.query("SELECT id FROM conversations WHERE chat_object_id = ? LIMIT 1")
			.get(chat.id);
		if (session === null) throw new Error("Seeded session was not found");
		const insert = database.prepare(
			"INSERT INTO messages (conversation_id, direction, id, kind, occurred_at, content_text, parts_json) VALUES (?, 'inbound', ?, 'webui', ?, ?, ?)",
		);
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		for (let index = 0; index < Number(process.env.ELAINA_E2E_COUNT); index += 1) {
			const text = "seed message " + index;
			insert.run(
				session.id,
				"seed-" + index,
				new Date(base + index * 1_000).toISOString(),
				text,
				JSON.stringify([{ text, type: "text" }]),
			);
		}
		database.close();
	`;
	execFileSync("bun", ["-e", script], {
		env: {
			...process.env,
			ELAINA_E2E_COUNT: String(input.count),
			ELAINA_E2E_DB: input.databasePath,
			ELAINA_E2E_TITLE: input.title,
		},
	});
}

test("virtualizes a long transcript and loads older cursor pages", async ({ page }) => {
	const title = `Virtual ${Date.now()}`;
	await openAuthenticatedPage(page);
	await createLocalChat(page, title);

	const stack = await readStackRuntime();
	seedTranscript({
		count: SEEDED_MESSAGES,
		databasePath: join(stack.dataDir, "data", "domain.sqlite"),
		title,
	});
	await page.reload();

	const timeline = page.getByRole("log");
	await expect(timeline.getByText("seed message 119", { exact: true })).toBeVisible();
	// Only the rows around the live edge exist in the DOM; rendering the whole history would
	// defeat the point of the virtualizer.
	expect(await timeline.locator('article[data-slot="message"]').count()).toBeLessThan(50);
	expect(await timeline.getByText("seed message 0", { exact: true }).count()).toBe(0);

	const viewport = page.getByRole("region", { name: "Chats" });
	await expect
		.poll(
			async () => {
				await viewport.evaluate((element) => {
					(element as unknown as { scrollTo(options: { top: number }): void }).scrollTo({ top: 0 });
				});
				return timeline.getByText("seed message 0", { exact: true }).count();
			},
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(0);
	await expect(timeline.getByText("seed message 0", { exact: true })).toBeVisible();
});
