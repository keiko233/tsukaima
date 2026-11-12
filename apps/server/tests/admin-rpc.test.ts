import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import { appRouter } from "../src/rpc/index.ts";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

describe("admin RPC", () => {
	test("exposes diagnostics, conversations, plugins, and model policies", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-admin-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();

		const handler = new RPCHandler(appRouter);
		const request = async (procedure: string, input?: unknown) => {
			const response = await handler.handle(
				new Request(`http://localhost/rpc/${procedure}`, {
					body: JSON.stringify(input === undefined ? {} : { json: input }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
				{ context: { lifecycle }, prefix: "/rpc" },
			);
			if (response.response === undefined) throw new Error(`No response from ${procedure}`);
			const result = (await response.response.json()) as { json: unknown };
			return result.json;
		};

		const diagnostics = await request("admin/diagnostics/status");
		expect((diagnostics as { state: { state: string } }).state.state).toBe("ready");
		expect((diagnostics as { processedMessages: number }).processedMessages).toBe(0);
		expect((diagnostics as { routingPolicies: unknown[] }).routingPolicies.length).toBe(1);

		const conversations = await request("admin/conversations/list");
		expect(Array.isArray(conversations)).toBe(true);

		const plugins = await request("admin/plugins/list");
		expect(Array.isArray(plugins)).toBe(true);

		const updated = await request("admin/modelPolicies/set", {
			capability: "basic-chat",
			primaryModel: "fake-deterministic",
			primaryProvider: "fake",
		});
		expect(updated).toHaveLength(1);
		expect((updated as { primary: { modelId: string } }[])[0].primary.modelId).toBe(
			"fake-deterministic",
		);

		await lifecycle.stop();
		expect(app).toBeDefined();
	});
});
