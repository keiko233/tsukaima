import { expect, test, type Page } from "@playwright/test";
import { openAuthenticatedPage } from "./helpers.ts";
import { readStackRuntime } from "./stack.ts";

const PLUGINS = [
	{
		control: "Reconnect now",
		id: "onebot-napcat",
		name: "OneBot / NapCat",
		panel: "Channel status",
	},
	{
		control: "Dry run",
		id: "sticker-meme",
		name: "Sticker and meme packs",
		panel: "Sticker library",
	},
	{
		control: "Run simulation",
		id: "proactive-scheduler",
		name: "Proactive scheduler",
		panel: "Proactive scheduler",
	},
	{
		control: "Run test query",
		id: "search-fetch",
		name: "Search and fetch",
		panel: "Search and fetch",
	},
	{
		control: "Create task",
		extra: "Approval cards",
		id: "self-iteration",
		name: "Self-iteration",
		panel: "Self-iteration runtime",
	},
] as const;

function captureBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		const text = message.text();
		// Vite serves /favicon.ico as a 404 in development; that is not an application error.
		if (text.includes("favicon")) return;
		errors.push(`console: ${text}`);
	});
	return errors;
}

test.describe("built-in plugin panels", () => {
	test("renders every built-in panel with localized controls and no browser errors", async ({
		page,
	}) => {
		await openAuthenticatedPage(page);
		const stack = await readStackRuntime();
		const errors = captureBrowserErrors(page);

		for (const plugin of PLUGINS) {
			await page.goto(new URL(`/plugins/${plugin.id}`, stack.webUrl).toString());
			await expect(page.getByRole("heading", { name: plugin.name, level: 1 })).toBeVisible();
			await expect(page.getByRole("heading", { name: plugin.panel, level: 2 })).toBeVisible();
			await expect(page.getByText(plugin.control, { exact: true }).first()).toBeVisible();
			if ("extra" in plugin) {
				await expect(page.getByRole("heading", { name: plugin.extra, level: 3 })).toBeVisible();
			}
		}

		await page.goto(new URL("/plugins", stack.webUrl).toString());
		for (const plugin of PLUGINS) {
			await expect(page.getByRole("button", { name: new RegExp(plugin.id, "u") })).toBeVisible();
		}
		expect(errors).toEqual([]);
	});
});
