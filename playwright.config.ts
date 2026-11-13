import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	expect: { timeout: 15_000 },
	fullyParallel: false,
	globalSetup: "./e2e/global-setup.ts",
	globalTeardown: "./e2e/global-teardown.ts",
	outputDir: ".test-data/e2e/artifacts",
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	reporter: process.env.CI === "true" ? [["list"], ["html", { open: "never" }]] : "list",
	retries: process.env.CI === "true" ? 1 : 0,
	testDir: "./e2e",
	testMatch: "**/*.spec.ts",
	timeout: 75_000,
	use: {
		headless: true,
		locale: "en-US",
		screenshot: "only-on-failure",
		storageState: ".test-data/e2e/storage-state.json",
		trace: "retain-on-failure",
		video: "off",
	},
	workers: 1,
});
