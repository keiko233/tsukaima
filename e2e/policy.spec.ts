import { expect, test } from "@playwright/test";
import { createLocalChat, openAuthenticatedPage } from "./helpers.ts";

test.describe("conversation policy and approval state", () => {
	test("inspects, updates, and reloads an audited conversation policy revision", async ({
		page,
	}) => {
		await openAuthenticatedPage(page);
		const title = `E2E policy ${Date.now()}`;
		await createLocalChat(page, title);

		// The conversation policy lives in the session inspector's Triggers tab.
		const inspector = page.getByRole("complementary", { name: "Session inspector" });
		await inspector.getByRole("tab", { name: "Triggers" }).click();
		await expect(inspector.getByLabel("Private access")).toHaveValue("open");
		await inspector.getByLabel("Private access").selectOption("allowlist");
		await inspector.getByLabel("Allowlist IDs").fill("e2e-approved-peer");
		await inspector.getByRole("button", { name: "Save policy" }).click();
		await expect(page.getByText("Policy saved")).toBeVisible();

		// The persona tab carries the WebUI's audit view for policy revisions.
		await inspector.getByRole("tab", { name: "Persona" }).click();
		await expect(inspector.getByRole("heading", { name: "Policy history" })).toBeVisible();
		const historyRows = inspector
			.getByRole("list")
			.getByRole("listitem")
			.filter({ hasText: /Version \d+/u });
		await expect(historyRows).toHaveCount(1);
		await expect(historyRows.filter({ hasText: "Active" })).toHaveCount(1);

		await page.reload();
		await expect(page.getByRole("heading", { name: title })).toBeVisible();
		const reloadedInspector = page.getByRole("complementary", { name: "Session inspector" });
		await reloadedInspector.getByRole("tab", { name: "Triggers" }).click();
		await expect(reloadedInspector.getByLabel("Private access")).toHaveValue("allowlist");
		await expect(reloadedInspector.getByLabel("Allowlist IDs")).toHaveValue("e2e-approved-peer");
		// A second save must append a revision and keep exactly one active row.
		await reloadedInspector.getByLabel("Allowlist IDs").fill("e2e-approved-peer-2");
		await reloadedInspector.getByRole("button", { name: "Save policy" }).click();
		await expect(page.getByText("Policy saved")).toBeVisible();
		await reloadedInspector.getByRole("tab", { name: "Persona" }).click();
		await expect(historyRows).toHaveCount(2);
		await expect(historyRows.filter({ hasText: "Version 2" })).toHaveCount(1);
		await expect(historyRows.filter({ hasText: "Active" })).toHaveCount(1);
	});
});
