import { expect, type Page } from "@playwright/test";
import { readStackRuntime } from "./stack.ts";

export async function openAuthenticatedPage(page: Page, path = "/"): Promise<void> {
	const stack = await readStackRuntime();
	await page.goto(new URL(path, stack.webUrl).toString());
	await expect(page.getByText("Tsukaima Admin")).toBeVisible();
}

export async function createLocalChat(page: Page, title: string): Promise<void> {
	const stack = await readStackRuntime();
	await page.goto(new URL("/", stack.webUrl).toString());
	await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible();
	await page.getByRole("button", { name: "New chat" }).first().click();
	await expect(page.getByText("Start a local chat")).toBeVisible();
	await page.getByLabel("Chat name").fill(title);
	await page.getByLabel("First session name").first().fill(`${title} session`);
	await page.getByRole("button", { name: "Create", exact: true }).click();
	await expect(page).toHaveURL(/\/chat\//u);
	await expect(page.getByRole("heading", { name: title })).toBeVisible();
}
