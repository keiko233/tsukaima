import { expect, test } from "@playwright/test";
import { createLocalChat, openAuthenticatedPage } from "./helpers.ts";

test.describe("WebUI messaging", () => {
	test("creates a local chat and renders the assistant reply in the timeline", async ({ page }) => {
		await openAuthenticatedPage(page);
		const title = `E2E chat ${Date.now()}`;
		await createLocalChat(page, title);

		const prompt = "Hello Tsukaima from the end-to-end suite";
		const composer = page.getByPlaceholder("Write a message…");
		await expect(composer).toBeVisible();
		await composer.fill(prompt);
		await composer.press("Enter");

		const timeline = page.getByRole("log");
		await expect(timeline.getByText(prompt, { exact: true })).toBeVisible();
		await expect(page.getByPlaceholder("Write a message…")).toHaveValue("");
		await expect(timeline.getByText("ok", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(timeline.getByText("Tsukaima", { exact: true }).last()).toBeVisible();

		// Reload proves the conversation and generated reply are durable, not only query cache.
		await page.reload();
		await expect(page.getByRole("log").getByText(prompt, { exact: true })).toBeVisible();
		await expect(page.getByRole("log").getByText("ok", { exact: true })).toBeVisible();
	});
});
