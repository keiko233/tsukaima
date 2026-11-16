import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { StaticWebServer } from "../src/static-web.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function fixture(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-static-web-"));
	directories.push(directory);
	await fs.mkdir(join(directory, "assets"), { recursive: true });
	await fs.writeFile(join(directory, "index.html"), "<!doctype html><div id=root></div>");
	await fs.writeFile(join(directory, "assets", "app-abc123.js"), "export const value = 1;");
	return directory;
}

describe("static WebUI server", () => {
	test("serves the index, immutable assets, and SPA navigation fallback", async () => {
		const directory = await fixture();
		const server = new StaticWebServer({ distDir: directory });

		const index = await server.response("/");
		expect(index?.status).toBe(200);
		expect(index?.headers.get("cache-control")).toBe("no-cache");
		expect(await index?.text()).toContain("id=root");

		const asset = await server.response("/assets/app-abc123.js");
		expect(asset?.status).toBe(200);
		expect(asset?.headers.get("cache-control")).toContain("immutable");

		const route = await server.response("/settings/plugins");
		expect(route?.status).toBe(200);
		expect(await route?.text()).toContain("id=root");
	});

	test("does not expose files outside the dist root or turn missing assets into HTML", async () => {
		const directory = await fixture();
		const server = new StaticWebServer({ distDir: directory });

		expect(await server.response("/../package.json")).toBeUndefined();
		expect(await server.response("/%2e%2e/package.json")).toBeUndefined();
		expect(await server.response("/assets/missing.js")).toBeUndefined();
		expect(await server.response("/favicon.ico")).toBeUndefined();
	});

	test("serves the built WebUI through the server wildcard route", async () => {
		const directory = await fixture();
		const { app, lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: join(directory, "data"),
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_DIST: directory,
		});
		try {
			const response = await app.handle(new Request("http://localhost/conversations/abc"));
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("id=root");
			const missing = await app.handle(new Request("http://localhost/assets/missing.js"));
			expect(missing.status).toBe(404);
		} finally {
			await lifecycle.stop();
		}
	});
});
