import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ChannelRequest, MessageEnvelope } from "@elaina/contracts";
import { chatObjects, requests } from "@elaina/db";
import {
	pluginManifestSchema,
	type ChannelAdapter,
	type ChannelDiagnostics,
	type ElainaPlugin,
	type SendResult,
} from "@elaina/sdk";
import { createApp } from "../src/app.ts";
import { builtinPlugins } from "../src/plugins/builtin.ts";

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

const fakeChannelPlugin: ElainaPlugin = {
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
	const directory = await mkdtemp(join(tmpdir(), "elaina-plugin-host-"));
	try {
		const { lifecycle } = createApp(
			{
				ELAINA_DATA_DIR: directory,
				ELAINA_PORT: "7420",
				ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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
	test("loads built-in plugins into the registry", async () =>
		withApp({}, async (lifecycle) => {
			const plugins = await lifecycle.pluginHost.list();
			expect(plugins.map((plugin) => plugin.name)).toEqual([
				"openai-compatible",
				"onebot-napcat",
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
			{ ELAINA_ONEBOT_ACCESS_TOKEN: "env-token", ELAINA_ONEBOT_WS_URL: "ws://env.test:3001" },
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
});
