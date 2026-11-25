import { expect, test } from "@playwright/test";
import { openAuthenticatedPage } from "./helpers.ts";

test.describe("app shell", () => {
	test("stays fixed when a short pane cannot fit the navigation rail", async ({ page }) => {
		const height = 320;
		await page.setViewportSize({ width: 1280, height });
		await openAuthenticatedPage(page, "/plugins/sticker-meme");

		const shell = page.locator("body > #root > div").first();
		await expect(shell).toHaveCSS("height", `${height}px`);

		// Focusing a utility destination used to scroll the clip container, moving the whole
		// shell off-screen along with the rail instead of scrolling the rail alone.
		await page.getByRole("button", { name: /More system pages/u }).focus();
		await expect(page.getByRole("heading", { name: "Plugins", exact: true })).toBeInViewport();

		await expect(shell).toHaveJSProperty("clientHeight", height);
		await expect(shell).toHaveJSProperty("scrollHeight", height);
		await expect(shell).toHaveJSProperty("scrollTop", 0);
	});
});
