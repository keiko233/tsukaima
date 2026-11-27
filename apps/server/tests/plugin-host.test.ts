import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ChannelRequest, MessageEnvelope } from "@tsukaima/contracts";
import { chatObjects, conversations, requests } from "@tsukaima/db";
import {
	pluginManifestSchema,
	type ChannelAdapter,
	type ChannelDiagnostics,
	type TsukaimaPlugin,
	type SendResult,
} from "@tsukaima/sdk";
import { createApp } from "../src/app.ts";
import { builtinPlugins } from "../src/plugins/builtin.ts";
import { ScheduleService } from "../src/services/schedule-service.ts";
import { createPluginSchedulesApi } from "../src/services/plugin-schedules.ts";

class FakeChannelAdapter implements ChannelAdapter {
	readonly id = "fake";
	readonly kind = "webui";
	#envelopeHandler: ((envelope: MessageEnvelope) => void) | undefined;

	capabilities() {
		return ["send"] as const;
	}

	diagnostics(): ChannelDiagnostics {
		return { configured: true, connected: true, state: "open", eventCount: 0 };
	}

	async start(): Promise<void> {}

	async stop(): Promise<void> {}

	async send(): Promise<SendResult> {
		return { platformMessageId: "fake-1" };
	}

	resolveRequest(): Promise<void> {
		return Promise.resolve();
	}

	onEnvelope(handler: (envelope: MessageEnvelope) => void): void {
		this.#envelopeHandler = handler;
	}

	onRequest(handler: (request: ChannelRequest) => void): void {
		this.#requestHandler = handler;
	}

	#requestHandler: ((request: ChannelRequest) => void) | undefined;

	emitEnvelope(envelope: MessageEnvelope): void {
		this.#envelopeHandler?.(envelope);
	}

	emitRequest(request: ChannelRequest): void {
		this.#requestHandler?.(request);
	}
}

let fakeAdapter: FakeChannelAdapter | undefined;

const fakeChannelPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "fake-channel",
		permissions: ["channel.send"],
		version: "0.1.0",
	}),
	setup(context) {
		fakeAdapter = new FakeChannelAdapter();
		context.channels?.register(fakeAdapter);
	},
};

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "fake",
	channelKind: "webui",
	conversationKey: { kind: "private", peerId: "peer-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Fake User", id: "peer-1", platformId: "peer-1" },
	source: { messageId: id, timestampMs: 1_000 },
});

async function withApp(
	env: Record<string, string | undefined>,
	run: (lifecycle: ReturnType<typeof createApp>["lifecycle"]) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-host-"));
	try {
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
				...env,
			},
			{ plugins: [...builtinPlugins, fakeChannelPlugin] },
		);
		await lifecycle.start();
		try {
			await run(lifecycle);
		} finally {
			await lifecycle.stop();
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("plugin host", () => {
	test("scopes host schedules to the owning plugin and readable conversations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-schedules-"));
		try {
			const { lifecycle } = createApp({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			});
			await lifecycle.start();
			const chat = await lifecycle.sessionMessaging.session("missing").catch(() => undefined);
			expect(chat).toBeUndefined();
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const created = await database
				.insert(chatObjects)
				.values({
					createdAt: "2026-11-17T00:00:00.000Z",
					id: "plugin-chat",
					kind: "webui",
					status: "active",
					title: "Plugin chat",
					updatedAt: "2026-11-17T00:00:00.000Z",
				})
				.returning();
			expect(created).toHaveLength(1);
			const session = await database
				.insert(conversations)
				.values({
					chatObjectId: "plugin-chat",
					createdAt: "2026-11-17T00:00:00.000Z",
					durableConversationId: "999",
					id: "plugin-session",
					isReceiving: 1,
					kind: "webui",
					status: "active",
					title: "Plugin session",
					updatedAt: "2026-11-17T00:00:00.000Z",
				})
				.returning();
			expect(session).toHaveLength(1);
			const executor = {
				async execute() {
					return { result: { ok: true } };
				},
			};
			const schedules = new ScheduleService({
				database: () => database,
				executor,
				logger: lifecycle.logger,
			});
			const owner = createPluginSchedulesApi(
				schedules,
				"plugin-a",
				async (conversationId) => conversationId === "plugin-session",
			);
			const other = createPluginSchedulesApi(
				schedules,
				"plugin-b",
				async (conversationId) => conversationId === "plugin-session",
			);
			const futureAt = new Date(Date.now() + 3_600_000).toISOString();
			const schedule = await owner.create({
				actionKind: "notify",
				prompt: "Synthetic plugin notice",
				recurrence: { at: futureAt, kind: "once" },
				targetSessionId: "plugin-session",
				timeZone: "UTC",
				title: "Plugin schedule",
			});
			expect(await owner.list()).toHaveLength(1);
			expect(await other.list()).toHaveLength(0);
			expect(await other.cancel(schedule.id)).toBe(false);
			await expect(
				owner.create({
					actionKind: "notify",
					prompt: "Synthetic plugin notice",
					recurrence: { at: futureAt, kind: "once" },
					targetSessionId: "not-readable",
					timeZone: "UTC",
					title: "Rejected schedule",
				}),
			).rejects.toThrow("cannot read");
			await lifecycle.stop();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("loads built-in plugins into the registry", async () =>
		withApp({}, async (lifecycle) => {
			const plugins = await lifecycle.pluginHost.list();
			expect(plugins.map((plugin) => plugin.name)).toEqual([
				"openai-compatible",
				"onebot-napcat",
				"history",
				"memory",
				"proactive-scheduler",
				"sticker-meme",
				"mcp",
				"skills",
				"fake-channel",
			]);
			expect(plugins[1]).toEqual(
				expect.objectContaining({ apiVersion: "1", enabled: 1, kind: "builtin", runMode: "host" }),
			);
		}));

	test("routes a second channel's messages and requests independently", async () =>
		withApp({}, async (lifecycle) => {
			expect(fakeAdapter).toBeDefined();
			fakeAdapter?.emitEnvelope(envelope("fake-msg-1", "hello from fake"));
			await waitFor(async () =>
				lifecycle.processedMessageCount > 0 ? lifecycle.processedMessageCount : undefined,
			);
			expect(lifecycle.processedMessageCount).toBe(1);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not initialized");
			const chatRows = await database
				.select()
				.from(chatObjects)
				.where(eq(chatObjects.channelId, "fake"));
			expect(chatRows[0]?.channelId).toBe("fake");

			fakeAdapter?.emitRequest({
				accountId: "1",
				channelId: "fake",
				flag: "fake-request-1",
				kind: "friend",
				receivedAtMs: 1_000,
				requesterId: "peer-1",
			});
			const stored = await waitFor(async () => {
				const rows = await lifecycle.domainDatabase
					?.select()
					.from(requests)
					.where(eq(requests.channelId, "fake"));
				return rows !== undefined && rows.length > 0 ? rows : undefined;
			});
			expect(stored[0]?.channelId).toBe("fake");
		}));

	test("resolves plugin config from the environment and hides secrets", async () =>
		withApp(
			{ TSUKAIMA_ONEBOT_ACCESS_TOKEN: "env-token", TSUKAIMA_ONEBOT_WS_URL: "ws://env.test:3001" },
			async (lifecycle) => {
				const initial = await lifecycle.pluginConfigView("onebot-napcat");
				expect(initial.config.wsUrl).toBe("ws://env.test:3001");
				expect(initial.secretsSet).toEqual(["accessToken"]);
				expect(JSON.stringify(initial)).not.toContain("env-token");
				expect(lifecycle.channels.get("onebot")?.diagnostics().configured).toBe(true);

				await lifecycle.updatePluginConfig("onebot-napcat", { wsUrl: "ws://stored.test:3001" });
				expect((await lifecycle.pluginConfigView("onebot-napcat")).config.wsUrl).toBe(
					"ws://stored.test:3001",
				);

				await lifecycle.updatePluginConfig("onebot-napcat", { wsUrl: null });
				expect((await lifecycle.pluginConfigView("onebot-napcat")).config.wsUrl).toBe(
					"ws://env.test:3001",
				);
			},
		));

	test("lets another plugin query the enabled model catalog", async () =>
		withApp({}, async (lifecycle) => {
			await lifecycle.updatePluginConfig("openai-compatible", {
				apiKey: "test-key",
				baseUrl: "https://models.example/v1",
				models: [
					{
						enabled: true,
						id: "vision-reasoner",
						supportsImage: true,
						supportsReasoning: true,
					},
					{ enabled: true, id: "text-chat" },
					{ enabled: false, id: "disabled-chat" },
				],
			});
			const observer = lifecycle.pluginHost.context("fake-channel");
			if (observer === undefined) throw new Error("fake-channel context missing");
			expect((await observer.models.listModels()).map((model) => model.id)).toEqual([
				"vision-reasoner",
				"text-chat",
			]);
			expect(await observer.models.listModels({ capability: "vision", input: "image" })).toEqual([
				expect.objectContaining({
					id: "vision-reasoner",
					pluginId: "openai-compatible",
					providerId: "openai-compatible",
				}),
			]);
			expect((await observer.models.listModels({ capability: "reasoning" }))[0]?.reasoning).toEqual(
				expect.objectContaining({
					default: "medium",
					levels: expect.arrayContaining(["low", "medium", "high"]),
				}),
			);
		}));

	test("publishes status snapshots and stops a disabled plugin", async () =>
		withApp({}, async (lifecycle) => {
			const plugins = await lifecycle.pluginHost.list();
			const oneBot = plugins.find((plugin) => plugin.id === "onebot-napcat");
			expect(oneBot?.status).toEqual(
				expect.objectContaining({ code: "status_unconfigured", level: "unknown" }),
			);
			expect(oneBot?.rpcMethods).toContain("onebot-napcat.reconnect");
			expect(oneBot?.rpcMethods.length).toBeGreaterThan(1);
			expect(oneBot?.permissions).toContain("ui.panel");

			await lifecycle.setPluginEnabled("onebot-napcat", false);
			const disabled = (await lifecycle.pluginHost.list()).find(
				(plugin) => plugin.id === "onebot-napcat",
			);
			expect(disabled?.enabled).toBe(0);
			expect(disabled?.status).toBeNull();
			expect(disabled?.rpcMethods).toEqual([]);
			expect(lifecycle.channels.get("onebot")).toBeUndefined();
			expect(lifecycle.pluginStatuses.get("onebot-napcat")).toBeUndefined();

			await lifecycle.setPluginEnabled("onebot-napcat", true);
			const enabled = (await lifecycle.pluginHost.list()).find(
				(plugin) => plugin.id === "onebot-napcat",
			);
			expect(enabled?.enabled).toBe(1);
			expect(enabled?.rpcMethods).toContain("onebot-napcat.reconnect");
			expect(enabled?.status).not.toBeNull();
		}));

	test("rejects an RPC call outside the requested plugin namespace", async () =>
		withApp({}, async (lifecycle) => {
			await expect(
				lifecycle.pluginHost.invokeRpc("onebot-napcat.reconnect", undefined, "openai-compatible"),
			).rejects.toThrow("does not belong to");
		}));

	test("gives each plugin a scoped logger supporting trace and child targets", async () =>
		withApp({ TSUKAIMA_LOG_LEVEL: "trace" }, async (lifecycle) => {
			const context = lifecycle.pluginHost.context("fake-channel");
			if (context === undefined) throw new Error("fake-channel context missing");
			context.logger.trace("plugin trace probe", { apiKey: "secret-should-redact", step: 1 });
			const child = context.logger.child?.("transport", { channel: "fake" });
			child?.debug("child debug probe", { ok: true });

			const entries = lifecycle.logs.list({ limit: 200 });
			expect(entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						level: "trace",
						message: "plugin trace probe",
						target: "tsukaima::plugin::fake-channel",
					}),
					expect.objectContaining({
						level: "debug",
						message: "child debug probe",
						target: "tsukaima::plugin::fake-channel::transport",
					}),
				]),
			);
			const traceEntry = entries.find((entry) => entry.message === "plugin trace probe");
			expect(traceEntry?.fields.apiKey).toBe("[REDACTED]");
		}));

	test("normalizes model tool names with clean namespaces and resolves aliases", async () =>
		withApp({}, async (lifecycle) => {
			const memoryTools = lifecycle.pluginHost.modelToolNames("memory");
			expect(memoryTools).toEqual([
				"memory_recall",
				"memory_save",
				"memory_update",
				"memory_forget",
			]);

			const stickerTools = lifecycle.pluginHost.modelToolNames("sticker-meme");
			expect(stickerTools).toContain("sticker-meme_search");
			expect(stickerTools).toContain("sticker-meme_send");
			expect(stickerTools).toContain("sticker-meme_choose");

			const napcatTools = lifecycle.pluginHost.modelToolNames("onebot-napcat");
			expect(napcatTools).toContain("onebot-napcat_send");
			expect(napcatTools).toContain("onebot-napcat_poke");
			expect(napcatTools).toContain("onebot-napcat_react");
			expect(napcatTools).toContain("onebot-napcat_listTargets");

			const skillTools = lifecycle.pluginHost.modelToolNames("skills");
			expect(skillTools).toEqual([
				"load_skill",
				"read_skill_resource",
				"skill_install",
				"skill_remove",
				"skill_rescan",
			]);
			expect(lifecycle.pluginHost.resolveModelToolName("load_skill")).toBe("skills.load");
			expect(lifecycle.pluginHost.resolveModelToolName("read_skill_resource")).toBe(
				"skills.read_resource",
			);

			// Backward-compatible resolution
			expect(lifecycle.pluginHost.resolveModelToolName("memory_save")).toBe("memory.save");
			expect(lifecycle.pluginHost.resolveModelToolName("memory.save")).toBe("memory.save");
			expect(lifecycle.pluginHost.resolveModelToolName("save")).toBe("memory.save");
			expect(lifecycle.pluginHost.resolveModelToolName("onebot-napcat_send")).toBe(
				"onebot-napcat.send",
			);
			expect(lifecycle.pluginHost.resolveModelToolName("sticker-meme_send")).toBe(
				"sticker-meme.send",
			);
			// Ambiguous short name "send" does not resolve to either
			expect(lifecycle.pluginHost.resolveModelToolName("send")).toBeUndefined();
		}));

	test("merges nested secret maps without leaking values and aggregates multiple model providers", async () =>
		withApp({}, async (lifecycle) => {
			await lifecycle.updatePluginConfig("openai-compatible", {
				profileApiKeys: {
					default: "secret-primary",
					secondary: "secret-secondary",
				},
				profiles: [
					{
						baseUrl: "https://primary.example/v1",
						enabled: true,
						id: "default",
						models: [{ enabled: true, id: "primary-chat" }],
					},
					{
						baseUrl: "https://secondary.example/v1",
						enabled: true,
						id: "secondary",
						models: [{ enabled: true, id: "secondary-chat" }],
					},
				],
			});
			const view = await lifecycle.pluginConfigView("openai-compatible");
			expect(JSON.stringify(view)).not.toContain("secret-primary");
			expect(JSON.stringify(view)).not.toContain("secret-secondary");
			expect(view.secretsSet).toEqual(
				expect.arrayContaining([
					"profileApiKeys",
					"profileApiKeys.default",
					"profileApiKeys.secondary",
				]),
			);

			// Updating one subkey preserves the sibling subkey.
			await lifecycle.updatePluginConfig("openai-compatible", {
				profileApiKeys: {
					secondary: null,
				},
			});
			const afterDelete = await lifecycle.pluginConfigView("openai-compatible");
			expect(afterDelete.secretsSet).toContain("profileApiKeys.default");
			expect(afterDelete.secretsSet).not.toContain("profileApiKeys.secondary");
		}));
});
