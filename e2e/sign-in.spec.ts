import { expect, test } from "@playwright/test";
import { readStackRuntime } from "./stack.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("admin sign-in", () => {
	test("authenticates through /login and keeps the session across reloads", async ({ page }) => {
		const stack = await readStackRuntime();
		await page.goto(new URL("/login", stack.webUrl).toString());
		await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
		await page.locator('input[autocomplete="username"]').fill(stack.username);
		await page.locator('input[autocomplete="current-password"]').fill(stack.password);
		await page.getByRole("button", { name: "Sign in" }).click();

		await expect.poll(() => new URL(page.url()).pathname).toBe("/");
		await expect(page.getByRole("navigation", { name: "Tsukaima" })).toBeVisible();

		await page.reload();
		await expect.poll(() => new URL(page.url()).pathname).toBe("/");
		await expect(page.getByRole("navigation", { name: "Tsukaima" })).toBeVisible();

		// An authenticated visitor on /login is redirected back into the app.
		await page.goto(new URL("/login", stack.webUrl).toString());
		await expect.poll(() => new URL(page.url()).pathname).toBe("/");
	});

	test("rejects a wrong password without creating a session", async ({ page }) => {
		const stack = await readStackRuntime();
		await page.goto(new URL("/login", stack.webUrl).toString());
		await page.locator('input[autocomplete="username"]').fill(stack.username);
		await page.locator('input[autocomplete="current-password"]').fill(`${stack.password}-wrong`);
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page.getByText("Invalid username or password.")).toBeVisible();
		await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
	});
});
