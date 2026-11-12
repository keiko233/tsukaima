import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";

describe("server skeleton", () => {
	test("reports lifecycle state over RPC", async () => {
		const { app, lifecycle } = createApp({
			ELAINA_DATA_DIR: "./.test-data",
			ELAINA_PORT: "7420",
			ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		expect(lifecycle.state.state).toBe("starting");
		const response = await app.handle(new Request("http://localhost/healthz"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { state: string };
		expect(body.state).toBe("starting");
		await lifecycle.stop();
	});

	test("streams snapshot and live log entries over SSE", async () => {
		const { app, lifecycle } = createApp({
			ELAINA_DATA_DIR: "./.test-data",
			ELAINA_PORT: "7420",
			ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		const abort = new AbortController();
		const response = await app.handle(
			new Request("http://localhost/events/logs", { signal: abort.signal }),
		);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("SSE response has no body");
		const decoder = new TextDecoder();
		const readChunk = async () => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE data")), 1_000);
					}),
				]);
				if (result.done || result.value === undefined) throw new Error("SSE stream closed");
				return decoder.decode(result.value);
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
			}
		};

		expect(await readChunk()).toContain("event: snapshot");
		lifecycle.logger.info("stream probe", { requestId: "req-1" });
		const liveChunk = await readChunk();
		expect(liveChunk).toContain("event: log");
		expect(liveChunk).toContain('"message":"stream probe"');

		await reader.cancel();
		abort.abort();
		await lifecycle.stop();
	});
});
