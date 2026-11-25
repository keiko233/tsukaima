import { expect, test } from "@playwright/test";
import { createLocalChat, openAuthenticatedPage } from "./helpers.ts";

test.describe("WebUI messaging", () => {
	test("keeps chat transcripts read-only", async ({ page }) => {
		await openAuthenticatedPage(page);
		const title = `E2E chat ${Date.now()}`;
		await createLocalChat(page, title);

		await expect(page.getByPlaceholder("Write a message…")).toHaveCount(0);
		await expect(
			page.getByText(
				"This sends directly to the external chat. It will not ask Tsukaima to reply.",
			),
		).toHaveCount(0);
	});

	test("keeps the workspace composer without an explanatory hint", async ({ page }) => {
		await openAuthenticatedPage(page, "/workspace");
		await page.getByRole("button", { name: "New", exact: true }).first().click();
		await expect(page).toHaveURL(/\/workspace\//u);

		const composer = page.getByPlaceholder("Write a message…");
		await expect(composer).toBeVisible();
		await expect(
			page.getByText("Describe the task, or @ a conversation to include bounded context."),
		).toHaveCount(0);
	});
});
