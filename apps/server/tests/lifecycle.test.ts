import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { writeRuntimeSettings } from "../src/runtime-settings.ts";
import { createSlowStreamingModel } from "@tsukaima/core";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { conversations } from "@tsukaima/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransportFactory,
} from "@tsukaima-plugin/onebot-napcat";

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: 1_000 },
});

describe("server lifecycle with fake model", () => {
	test("starts, processes a fake-model message, and stops cleanly", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-e2e-"));
		try {
			const { app, lifecycle } = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});

			expect(lifecycle.state.state).toBe("starting");
			const healthResponse = await app.handle(new Request("http://localhost/healthz"));
			expect(healthResponse.status).toBe(200);
			const healthBody = (await healthResponse.json()) as { state: string };
			expect(healthBody.state).toBe("starting");

			const readyzBefore = await app.handle(new Request("http://localhost/readyz"));
			expect(readyzBefore.status).toBe(503);

			await lifecycle.start();
			expect(lifecycle.state.state).toBe("ready");
			expect(lifecycle.conversationHost).toBeDefined();
			expect(lifecycle.modelRouter).toBeDefined();
			expect(lifecycle.processedMessageCount).toBe(0);
			expect(lifecycle.routingPolicies.length).toBeGreaterThan(0);

			const postStartHealth = await app.handle(new Request("http://localhost/healthz"));
			expect(postStartHealth.status).toBe(200);
			const postStartBody = (await postStartHealth.json()) as { state: string };
			expect(postStartBody.state).toBe("ready");

			const host = lifecycle.conversationHost;
			if (host === undefined) {
				throw new Error("Conversation host not initialized");
			}
			const conversationId = await host.createConversation();
			const result = await host.append({
				conversationId,
				envelope: envelope("msg-1", "hello world"),
				submittedAtMs: Date.now(),
			});
			expect(result.messageId).toBe("msg-1");
			lifecycle.processedMessageCount += 1;
			expect(lifecycle.processedMessageCount).toBe(1);

			await lifecycle.processEnvelope(envelope("onebot-1", "first"));
			await lifecycle.processEnvelope(envelope("onebot-2", "second"));
			expect(lifecycle.processedMessageCount).toBe(3);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not initialized");
			const conversationRows = await database
				.select()
				.from(conversations)
				.where(eq(conversations.channelId, "onebot-test"));
			expect(conversationRows).toHaveLength(1);

			const readyzAfter = await app.handle(new Request("http://localhost/readyz"));
			expect(readyzAfter.status).toBe(204);

			const dataEntries = await readdir(directory);
			expect(dataEntries).toEqual(expect.arrayContaining(["blobs", "skills", "mcp"]));
			expect(await readdir(join(directory, "mcp"))).toContain("bin");

			await lifecycle.stop();
			const stopResponse = await app.handle(new Request("http://localhost/healthz"));
			expect(stopResponse.status).toBe(503);
			const stopBody = (await stopResponse.json()) as { state: string };
			expect(stopBody.state).toBe("maintenance");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("connects with the environment OneBot url and reconnects after a settings change", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-onebot-"));
		const urls: string[] = [];
		const connections: Array<{ closeCount: number; emitOpen: () => void }> = [];
		const transportFactory: OneBotTransportFactory = (url) => {
			urls.push(url);
			const listeners = new Map<string, () => void>();
			const connection = {
				closeCount: 0,
				emitOpen: () => listeners.get("open")?.(),
			};
			connections.push(connection);
			return {
				close: () => {
					connection.closeCount += 1;
					listeners.get("close")?.();
				},
				on: (name, listener) => {
					listeners.set(name, listener as () => void);
				},
				send: () => {},
			};
		};
		try {
			const { lifecycle } = createApp(
				{
					TSUKAIMA_DATA_DIR: directory,
					TSUKAIMA_ONEBOT_WS_URL: "ws://env.example:3001",
					TSUKAIMA_PORT: "7420",
					TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
				},
				{
					pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, transportFactory]]),
				},
			);
			await lifecycle.start();
			expect(urls).toEqual(["ws://env.example:3001"]);
			expect(lifecycle.channels.get("onebot")?.diagnostics().configured).toBe(true);
			connections[0]?.emitOpen();
			expect(lifecycle.channels.get("onebot")?.diagnostics().connected).toBe(true);

			await lifecycle.updatePluginConfig("onebot-napcat", { wsUrl: "ws://override.example:3001" });
			expect(urls).toEqual(["ws://env.example:3001", "ws://override.example:3001"]);
			expect(connections[0]?.closeCount).toBe(1);
			expect(lifecycle.channels.get("onebot")?.diagnostics().restartRequired).toBe(false);
			expect(lifecycle.channels.get("onebot")?.diagnostics().state).toBe("connecting");

			connections[1]?.emitOpen();
			await lifecycle.updatePluginConfig("onebot-napcat", { wsUrl: "ws://override.example:3001" });
			expect(urls).toHaveLength(2);
			expect(lifecycle.channels.get("onebot")?.diagnostics().connected).toBe(true);

			await lifecycle.stop();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("hot-refreshes active model provider when openai-compatible is configured or toggled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-model-hot-"));
		try {
			const { lifecycle } = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await lifecycle.start();
			expect(lifecycle.routingPolicies[0]?.primary).toEqual({
				modelId: "fake-deterministic",
				providerId: "fake",
			});
			expect(
				lifecycle.modelRouter?.select({
					capability: "basic-chat",
					policies: lifecycle.routingPolicies,
				})?.model.id,
			).toBe("fake-deterministic");

			await lifecycle.updatePluginConfig("openai-compatible", {
				apiKey: "test-synthetic-key",
				baseUrl: "http://127.0.0.1:1/v1",
				models: [{ enabled: true, id: "real-chat-model" }],
			});
			expect(lifecycle.routingPolicies[0]?.primary).toEqual({
				modelId: "real-chat-model",
				providerId: "openai-compatible",
			});
			expect(
				lifecycle.modelRouter?.select({
					capability: "basic-chat",
					policies: lifecycle.routingPolicies,
				})?.model.id,
			).toBe("real-chat-model");
			expect(lifecycle.providerRestartRequired).toBe(false);

			await lifecycle.setPluginEnabled("openai-compatible", false);
			expect(lifecycle.routingPolicies[0]?.primary).toEqual({
				modelId: "fake-deterministic",
				providerId: "fake",
			});

			await lifecycle.stop();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("TSUKAIMA_LOG_LEVEL seeds a fresh install", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-log-seed-"));
		try {
			const app = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_LOG_FILE_ENABLED: "false",
				TSUKAIMA_LOG_LEVEL: "trace",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await app.lifecycle.start();
			expect(app.lifecycle.logger.level).toBe("trace");
			await app.lifecycle.stop();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("a persisted log level wins over the environment default and survives restarts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-logging-"));
		try {
			const first = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_LOG_BUFFER_CAPACITY: "25",
				TSUKAIMA_LOG_FILE_ENABLED: "false",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await first.lifecycle.start();
			if (first.lifecycle.domainDatabase === undefined) {
				throw new Error("Domain database not initialized");
			}
			await writeRuntimeSettings(first.lifecycle.domainDatabase, { logLevel: "error" });
			await first.lifecycle.stop();

			const entriesWhenDisabled = await readdir(directory);
			expect(entriesWhenDisabled).not.toContain("logs");

			const second = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_LOG_BUFFER_CAPACITY: "25",
				TSUKAIMA_LOG_LEVEL: "trace",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await second.lifecycle.start();
			expect(second.lifecycle.logger.level).toBe("error");
			expect(second.lifecycle.logs.list({ limit: 100 }).length).toBeLessThanOrEqual(25);

			await second.lifecycle.applyRuntimeSettings({ logLevel: "warn" });
			expect(second.lifecycle.logger.level).toBe("warn");
			await second.lifecycle.stop();

			// applyRuntimeSettings is a live change, not a write; the persisted value is still
			// "error", so a restart must come back to it rather than to the env default.
			const third = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_LOG_BUFFER_CAPACITY: "25",
				TSUKAIMA_LOG_LEVEL: "trace",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await third.lifecycle.start();
			expect(third.lifecycle.logger.level).toBe("error");
			await third.lifecycle.stop();

			const logFiles = await readdir(join(directory, "logs"));
			expect(logFiles.some((name) => /^tsukaima-\d{4}-\d{2}-\d{2}\.log$/.test(name))).toBe(true);
			const logContent = await readFile(join(directory, "logs", logFiles[0]!), "utf8");
			expect(logContent).toContain("tsukaima::server::lifecycle");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("resolves inbound sticker parts into vision model context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-server-sticker-"));
		let observedContext: { messages?: Array<{ role: string; content: unknown }> } | undefined;
		try {
			const model = createSlowStreamingModel(["seen"], {
				delayMs: 1,
				onContext: (context) => {
					observedContext = context as typeof observedContext;
				},
				supportsImage: true,
			});
			const { lifecycle } = createApp(
				{
					TSUKAIMA_DATA_DIR: directory,
					TSUKAIMA_PORT: "7420",
					TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
				},
				{ model },
			);
			await lifecycle.start();
			const host = lifecycle.conversationHost;
			if (host === undefined) throw new Error("Conversation host not initialized");
			const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
			const stored = await lifecycle.media.storeFetchedBytes(pngBytes, {
				kind: "sticker",
				mimeType: "image/png",
				source: "channel",
			});
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: {
					...envelope("sticker-msg-1", "look at this"),
					parts: [
						{ text: "look at this", type: "text" },
						{
							mediaId: stored.id,
							mimeType: stored.mimeType,
							previewText: "[动画表情]",
							sha256: stored.sha256,
							type: "sticker",
						},
					],
				},
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			for (let attempt = 0; attempt < 40; attempt += 1) {
				if (observedContext !== undefined) break;
				await Bun.sleep(25);
			}
			const userMessage = observedContext?.messages?.find((m) => m.role === "user");
			expect(Array.isArray(userMessage?.content)).toBe(true);
			expect(userMessage?.content).toEqual([
				{ text: expect.stringMatching(/^\[\d{2}:\d{2}\] Tester: look at this$/), type: "text" },
				{
					data: Buffer.from(pngBytes).toString("base64"),
					mimeType: "image/png",
					type: "image",
				},
			]);
			await lifecycle.stop();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
