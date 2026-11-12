import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";

describe("server skeleton", () => {
	test("reports lifecycle state over RPC", async () => {
		const { app, lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: "./.test-data",
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		expect(lifecycle.state.state).toBe("starting");
		const response = await app.handle(new Request("http://localhost/healthz"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { state: string };
		expect(body.state).toBe("starting");
		await lifecycle.stop();
	});
});
