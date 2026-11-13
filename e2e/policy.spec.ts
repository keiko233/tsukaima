import { expect, test } from "@playwright/test";
import { createLocalChat, openAuthenticatedPage } from "./helpers.ts";

test.describe("conversation policy and approval state", () => {
	test("inspects, updates, and reloads an audited conversation policy revision", async ({
		page,
	}) => {
		await openAuthenticatedPage(page);
		await createLocalChat(page, `E2E policy ${Date.now()}`);

		await page.getByRole("button", { name: "Rules" }).click();
		await expect(page.getByRole("heading", { name: "Conversation rules" })).toBeVisible();
		await expect(page.getByLabel("Private access")).toHaveValue("open");
		await expect(page.getByText("No policy revisions yet.")).toBeVisible();

		await page.getByLabel("Private access").selectOption("allowlist");
		await page.getByLabel("Allowlist IDs").fill("e2e-approved-peer");
		await page.getByRole("button", { name: "Save policy" }).click();
		await expect(page.getByText("Policy saved")).toBeVisible();

		// The history list is the WebUI's audit view for policy revisions.
		await expect(page.getByRole("heading", { name: "Policy history" })).toBeVisible();
		const historyRows = page
			.getByRole("list")
			.getByRole("listitem")
			.filter({ hasText: /Version \d+/u });
		await expect(historyRows).toHaveCount(1);
		await expect(historyRows.filter({ hasText: "Active" })).toHaveCount(1);

		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Close", exact: true })
			.last()
			.click();
		await page.getByRole("button", { name: "Rules" }).click();
		await expect(page.getByLabel("Private access")).toHaveValue("allowlist");
		await expect(page.getByLabel("Allowlist IDs")).toHaveValue("e2e-approved-peer");
		// A second save must append a revision and keep exactly one active row.
		await page.getByLabel("Allowlist IDs").fill("e2e-approved-peer-2");
		await page.getByRole("button", { name: "Save policy" }).click();
		await expect(page.getByText("Policy saved")).toBeVisible();
		await expect(historyRows).toHaveCount(2);
		await expect(historyRows.filter({ hasText: "Version 2" })).toHaveCount(1);
		await expect(historyRows.filter({ hasText: "Active" })).toHaveCount(1);
	});
});
