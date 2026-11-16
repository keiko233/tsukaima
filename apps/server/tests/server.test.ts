import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, listenOptions } from "../src/app.ts";
import { signIn } from "./test-auth.ts";

const directories: string[] = [];

async function allocatePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (address === null || typeof address === "string") {
				probe.close();
				reject(new Error("Expected numeric ephemeral port"));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

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

	test("streams snapshot and live log entries over an authenticated SSE connection", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-server-sse-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			TSUKAIMA_ADMIN_PASSWORD: "test-admin-password",
			TSUKAIMA_ADMIN_USERNAME: "admin",
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();
		const cookie = await signIn(app, "admin", "test-admin-password");
		const abort = new AbortController();
		const response = await app.handle(
			new Request("http://localhost/events/logs", {
				headers: { cookie },
				signal: abort.signal,
			}),
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

	test("rejects an unauthenticated log stream", async () => {
		const { app, lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: "./.test-data",
			TSUKAIMA_PORT: "7420",
		});
		const response = await app.handle(new Request("http://localhost/events/logs"));
		expect(response.status).toBe(401);
		await lifecycle.stop();
	});

	test("binds exclusively so a duplicate listener rejects with EADDRINUSE", async () => {
		const port = await allocatePort();
		const firstDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-bind-first-"));
		const secondDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-bind-second-"));
		directories.push(firstDir, secondDir);
		const first = createApp({
			TSUKAIMA_DATA_DIR: firstDir,
			TSUKAIMA_HOST: "127.0.0.1",
			TSUKAIMA_PORT: String(port),
		});
		first.app.listen(listenOptions(first.config));
		const second = createApp({
			TSUKAIMA_DATA_DIR: secondDir,
			TSUKAIMA_HOST: "127.0.0.1",
			TSUKAIMA_PORT: String(port),
		});
		try {
			expect(() => second.app.listen(listenOptions(second.config))).toThrow();
		} finally {
			await second.lifecycle.stop();
			await first.app.stop(true);
			await first.lifecycle.stop();
		}
	});
});
