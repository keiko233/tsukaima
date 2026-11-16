import { expect, test } from "@playwright/test";
import { openAuthenticatedPage } from "./helpers.ts";

test.describe("settings sections", () => {
	test("navigates general, policy, maintenance, and upgrade sections", async ({ page }) => {
		await openAuthenticatedPage(page, "/settings");
		const settingsNav = page.getByRole("navigation", { name: "Settings" });
		await expect(settingsNav).toBeVisible();

		for (const section of [
			{ heading: "General", path: "/settings" },
			{ heading: "Conversation defaults", path: "/settings/policies" },
			{ heading: "Maintenance", path: "/settings/maintenance" },
			{ heading: "Upgrades", path: "/settings/upgrades" },
		]) {
			await settingsNav.getByRole("link", { name: new RegExp(section.heading, "u") }).click();
			await expect(page).toHaveURL(new RegExp(`${section.path.replaceAll("/", "\\/")}$`, "u"));
			await expect(page.getByRole("heading", { level: 1, name: section.heading })).toBeVisible();
		}

		await expect(page.getByText("Current version", { exact: true })).toBeVisible();
		await expect(page.getByText("Upstream version", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Check for updates" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Upgrade history" })).toBeVisible();
		await expect(page.getByText("No upgrades have been started yet.").first()).toBeVisible();
		await expect(page.locator("body")).not.toContainText("500");
		await expect(page.locator("body")).not.toContainText("Internal Server Error");

		await page.screenshot({
			fullPage: true,
			path: ".test-data/e2e/settings-upgrades.png",
		});
		expect(new URL(page.url()).pathname).toBe("/settings/upgrades");
	});
});
