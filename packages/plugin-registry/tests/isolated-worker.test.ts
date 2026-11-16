import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BunPluginWorker } from "../src/isolated-worker.ts";
import { pluginManifestSchema } from "@tsukaima/sdk";

describe("Bun plugin worker isolation", () => {
	test("loads a plugin module and invokes its tool in a real worker", async () => {
		const manifest = pluginManifestSchema.parse({
			apiVersion: "1",
			kind: "third-party",
			name: "isolated",
			permissions: [],
			version: "1.0.0",
		});
		const worker = new BunPluginWorker({
			manifest,
			modulePath: join(import.meta.dir, "fixtures/isolated-plugin.ts"),
			pluginId: "isolated",
			requestTimeoutMs: 5_000,
		});
		await worker.start();
		expect(worker.listTools()).toEqual([{ name: "isolated.echo" }]);
		const result = await worker.invokeTool("isolated.echo", { text: "hello worker" });
		expect(result).toEqual({
			ok: true,
			result: {
				content: [{ text: "hello worker", type: "text" }],
			},
		});
		await worker.stop();
		expect(worker.listTools()).toEqual([]);
	});
});
