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

		const createdChat = (await request("admin/chats/createLocal", {
			sessionTitle: "Main",
			title: "Local chat",
		})) as { chatId: string; sessionId: string };
		const chats = (await request("admin/chats/list", {
			status: "active",
		})) as Array<{ id: string; sessions: Array<{ id: string; isReceiving: boolean }> }>;
		expect(chats).toHaveLength(1);
		expect(chats[0]?.id).toBe(createdChat.chatId);
		expect(chats[0]?.sessions[0]?.isReceiving).toBe(true);
		const session = (await request("admin/sessions/get", {
			sessionId: createdChat.sessionId,
		})) as { id: string; title: string } | null;
		expect(session).toEqual(expect.objectContaining({ id: createdChat.sessionId, title: "Main" }));

		const plugins = await request("admin/plugins/list");
		expect(Array.isArray(plugins)).toBe(true);

		const initialSettings = await request("admin/settings/get");
		expect(initialSettings).toEqual({
			logLevel: "info",
			openAiApiKeySet: false,
			onebotAccessTokenSet: false,
		});
		const updatedSettings = await request("admin/settings/update", {
			logLevel: "debug",
			openAiApiKey: "provider-secret",
			openAiBaseUrl: "https://magpie.example/v1",
			openAiModelId: "magpie-chat",
			onebotAccessToken: "test-token",
			onebotWsUrl: "ws://127.0.0.1:3001",
		});
		expect(updatedSettings).toEqual({
			logLevel: "debug",
			openAiApiKeySet: true,
			openAiBaseUrl: "https://magpie.example/v1",
			openAiModelId: "magpie-chat",
			onebotAccessTokenSet: true,
			onebotWsUrl: "ws://127.0.0.1:3001",
		});
		expect(JSON.stringify(updatedSettings)).not.toContain("test-token");
		expect(JSON.stringify(updatedSettings)).not.toContain("provider-secret");
		expect(lifecycle.logLevel).toBe("debug");
		expect(lifecycle.onebotRestartRequired).toBe(true);
		expect(lifecycle.providerRestartRequired).toBe(true);

		const updated = await request("admin/modelPolicies/set", {
			capability: "basic-chat",
			primaryModel: "fake-deterministic",
			primaryProvider: "fake",
		});
		expect(updated).toHaveLength(1);
		expect((updated as { primary: { modelId: string } }[])[0]?.primary.modelId).toBe(
			"fake-deterministic",
		);

		await lifecycle.stop();
		expect(app).toBeDefined();
	});
});
