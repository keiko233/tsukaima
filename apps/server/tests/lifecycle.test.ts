import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { writeRuntimeSettings } from "../src/runtime-settings.ts";
import type { MessageEnvelope } from "@elaina/contracts";
import { conversations } from "@elaina/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransportFactory,
} from "@elaina-plugin/onebot-napcat";

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
		const directory = await mkdtemp(join(tmpdir(), "elaina-server-e2e-"));
		try {
			const { app, lifecycle } = createApp({
				ELAINA_DATA_DIR: directory,
				ELAINA_PORT: "7420",
				ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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
		const directory = await mkdtemp(join(tmpdir(), "elaina-server-onebot-"));
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
					ELAINA_DATA_DIR: directory,
					ELAINA_ONEBOT_WS_URL: "ws://env.example:3001",
					ELAINA_PORT: "7420",
					ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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
		const directory = await mkdtemp(join(tmpdir(), "elaina-server-model-hot-"));
		try {
			const { lifecycle } = createApp({
				ELAINA_DATA_DIR: directory,
				ELAINA_PORT: "7420",
				ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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

	test("ELAINA_LOG_LEVEL overrides persisted runtime setting on startup and writes daily log files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-server-logging-"));
		try {
			const first = createApp({
				ELAINA_DATA_DIR: directory,
				ELAINA_LOG_BUFFER_CAPACITY: "25",
				ELAINA_LOG_FILE_ENABLED: "false",
				ELAINA_PORT: "7420",
				ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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
				ELAINA_DATA_DIR: directory,
				ELAINA_LOG_BUFFER_CAPACITY: "25",
				ELAINA_LOG_LEVEL: "trace",
				ELAINA_PORT: "7420",
				ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await second.lifecycle.start();
			expect(second.lifecycle.logger.level).toBe("trace");
			expect(second.lifecycle.logs.list({ limit: 100 }).length).toBeLessThanOrEqual(25);

			await second.lifecycle.applyRuntimeSettings({ logLevel: "warn" });
			expect(second.lifecycle.logger.level).toBe("warn");
			await second.lifecycle.stop();

			const logFiles = await readdir(join(directory, "logs"));
			expect(logFiles.some((name) => /^elaina-\d{4}-\d{2}-\d{2}\.log$/.test(name))).toBe(true);
			const logContent = await readFile(join(directory, "logs", logFiles[0]!), "utf8");
			expect(logContent).toContain("elaina::server::lifecycle");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
