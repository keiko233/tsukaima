import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createSlowStreamingModel } from "@tsukaima/core";
import { chatObjects, media, messages } from "@tsukaima/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
	type OneBotTransportEvents,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

class FakeNapCatTransport implements OneBotTransport {
	closeCount = 0;
	readonly actions: Array<{ action: string; echo: string; params: Record<string, unknown> }> = [];
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
		this.closeCount += 1;
		this.#emit("close");
	}

	on<Name extends keyof OneBotTransportEvents>(
		name: Name,
		listener: OneBotTransportEvents[Name],
	): void {
		const listeners = this.#listeners.get(name) ?? [];
		listeners.push(listener as (...args: never[]) => void);
		this.#listeners.set(name, listeners);
	}

	send(data: string): void {
		const parsed = JSON.parse(data) as {
			action: string;
			echo: string;
			params: Record<string, unknown>;
		};
		this.actions.push(parsed);
		queueMicrotask(() => {
			this.respond({ data: { message_id: 7_001 }, echo: parsed.echo, retcode: 0 });
		});
	}

	emitMessage(event: unknown): void {
		this.#emit("message", JSON.stringify(event));
	}

	emitOpen(): void {
		this.#emit("open");
	}

	respond(value: unknown): void {
		this.#emit("message", JSON.stringify(value));
	}

	#emit(name: string, payload?: string): void {
		for (const listener of this.#listeners.get(name) ?? []) {
			(listener as (...args: unknown[]) => void)(payload);
		}
	}
}

const privateEvent = (id: string, text: string) => ({
	message: [
		{ data: { text }, type: "text" },
		{ data: { file_id: "image-1", url: "https://cdn.test/a.png" }, type: "image" },
	],
	message_id: id,
	message_type: "private",
	post_type: "message",
	self_id: 99,
	sender: { card: "Test User", user_id: 10_001 },
	time: Math.floor(Date.now() / 1_000),
	user_id: 10_001,
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("fake NapCat integration", () => {
	test("runs message, notice, action, and crash-reconnect flows through the lifecycle", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-napcat-integration-"));
		directories.push(directory);
		const transports: FakeNapCatTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeNapCatTransport();
			transports.push(transport);
			return transport;
		};
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS: "127.0.0.1",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, factory]]),
				reply: { pendingGraceMs: 0 },
			},
		);
		await lifecycle.start();
		try {
			transports[0]?.emitOpen();
			expect(lifecycle.channels.get("onebot")?.diagnostics().connected).toBe(true);

			transports[0]?.emitMessage(privateEvent("integration-message-1", "hello media"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const inbound = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(eq(messages.direction, "inbound"));
				return rows.find((row) => row.platformMessageId === "integration-message-1");
			});
			expect(JSON.parse(inbound.partsJson ?? "[]")).toEqual([
				{ text: "hello media", type: "text" },
				expect.objectContaining({ channelRef: "image-1", type: "image" }),
			]);

			transports[0]?.emitMessage({
				group_id: 555,
				notice_type: "notify",
				post_type: "notice",
				self_id: 99,
				sub_type: "poke",
				time: Math.floor(Date.now() / 1_000),
				target_id: 99,
				user_id: 10_001,
			});
			const notice = await waitFor(async () => {
				const rows = await database.select().from(messages).where(eq(messages.kind, "notice"));
				return rows[0];
			});
			expect(notice.direction).toBe("system");
			expect(notice.contentText).toContain("[poke]");

			const sent = await lifecycle.pluginHost.invokeRpc("onebot-napcat.send", {
				parts: [{ text: "integration reply", type: "text" }],
				target: { channelId: "onebot", kind: "private", platformConversationId: "10001" },
			});
			expect(sent).toEqual({ ok: true, result: { platformMessageId: "7001" } });
			expect(transports[0]?.actions.at(-1)?.action).toBe("send_private_msg");

			transports[0]?.close();
			const reconnected = await waitFor(async () =>
				transports.length >= 2 ? transports[1] : undefined,
			);
			reconnected.emitOpen();
			expect(lifecycle.channels.get("onebot")?.diagnostics()).toMatchObject({
				connected: true,
				state: "open",
			});
			reconnected.emitMessage(privateEvent("integration-message-2", "after crash"));
			const afterCrash = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(eq(messages.platformMessageId, "integration-message-2"));
				return rows[0];
			});
			expect(afterCrash.contentText).toContain("after crash");
		} finally {
			await lifecycle.stop();
		}
	});

	// Regression: real NapCat sends `card: ""` for friends without a remark. That produced an
	// empty `displayName`, which failed envelope validation and silently dropped the message, so
	// the chat never appeared in the WebUI chat list.
	test("accepts a private message whose sender card is empty", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-napcat-empty-card-"));
		directories.push(directory);
		const transports: FakeNapCatTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeNapCatTransport();
			transports.push(transport);
			return transport;
		};
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS: "127.0.0.1",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, factory]]),
				reply: { pendingGraceMs: 0 },
			},
		);
		await lifecycle.start();
		try {
			transports[0]?.emitOpen();
			transports[0]?.emitMessage({
				message: [{ data: { text: "test" }, type: "text" }],
				message_id: 700_001,
				message_type: "private",
				post_type: "message",
				self_id: 99,
				sender: { card: "", nickname: "Test Nickname", user_id: 10_002 },
				time: Math.floor(Date.now() / 1_000),
				user_id: 10_002,
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const inbound = await waitFor(async () => {
				const rows = await database.select().from(messages);
				return rows.find((row) => row.platformMessageId === "700001");
			});
			expect(inbound.contentText).toBe("test");
			expect(inbound.senderDisplayName).toBe("Test Nickname");
			expect(inbound.triggerClassification).toBe("direct");
			// The chat object is what the WebUI chat list renders; without it the message is invisible.
			const chats = await database.select().from(chatObjects);
			expect(chats.map((chat) => chat.platformConversationId)).toContain("10002");
			expect(lifecycle.lastProcessingError).toBeUndefined();
		} finally {
			await lifecycle.stop();
		}
	});

	// Channels hand over a remote URL for an inbound image and nothing else fetches it. Until the
	// bytes land in the media store the transcript has nothing to render and the model only sees
	// `[image]`; this covers the download half of that path.
	test("downloads an inbound image into the media store", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-napcat-image-"));
		directories.push(directory);
		const transports: FakeNapCatTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeNapCatTransport();
			transports.push(transport);
			return transport;
		};
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS: "127.0.0.1",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, factory]]),
				reply: { pendingGraceMs: 0 },
			},
		);
		await lifecycle.start();
		// Serve the image the channel points at.
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const server = Bun.serve({
			fetch: () => new Response(png, { headers: { "content-type": "image/png" } }),
			port: 0,
		});
		try {
			transports[0]?.emitOpen();
			transports[0]?.emitMessage({
				message: [
					{ data: { text: "see this" }, type: "text" },
					{
						data: { file: "a.png", url: `http://127.0.0.1:${server.port}/a.png` },
						type: "image",
					},
				],
				message_id: 700_002,
				message_type: "private",
				post_type: "message",
				self_id: 99,
				sender: { card: "", nickname: "Test Nickname", user_id: 10_002 },
				time: Math.floor(Date.now() / 1_000),
				user_id: 10_002,
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const stored = await waitFor(async () => {
				const rows = await database.select().from(media);
				return rows[0];
			});
			// The bytes are content-addressed, so the WebUI and the model can both resolve them.
			expect(stored.mimeType).toBe("image/png");
			expect(stored.sizeBytes).toBe(png.byteLength);
			expect(await lifecycle.media.readBytes(stored.sha256)).toEqual(png);

			const inbound = await waitFor(async () => {
				const rows = await database.select().from(messages);
				return rows.find((row) => row.platformMessageId === "700002");
			});
			const parts = JSON.parse(inbound.partsJson ?? "[]") as { mediaId?: string; type: string }[];
			const image = parts.find((part) => part.type === "image");
			// The stored part references the media row, which is what the transcript renders.
			expect(image?.mediaId).toBe(stored.id);
		} finally {
			server.stop(true);
			await lifecycle.stop();
		}
	});

	// Regression: media bytes must be hydrated before appending to the durable activity window so
	// vision models receive the image content block (and plugins on `message.received` see the
	// local `mediaId`/`sha256`) rather than only an `[image]` placeholder.
	test("passes hydrated OneBot image blocks to a vision model and message.received hook", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-napcat-vision-"));
		directories.push(directory);
		const transports: FakeNapCatTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeNapCatTransport();
			transports.push(transport);
			return transport;
		};
		let observedContext:
			| {
					messages?: readonly {
						role?: string;
						content?: unknown;
					}[];
			  }
			| undefined;
		// The reply turn is the first model call; `after.reply` memory extraction reuses the same
		// model afterwards, so keep the first context instead of racing with the later call.
		let modelCalls = 0;
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS: "127.0.0.1",
			},
			{
				model: createSlowStreamingModel(["nice pic"], {
					delayMs: 5,
					onContext: (context) => {
						modelCalls += 1;
						if (modelCalls > 1) return;
						observedContext = context as typeof observedContext;
					},
					supportsImage: true,
				}),
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, factory]]),
				reply: { pendingGraceMs: 0 },
			},
		);
		const receivedParts: unknown[] = [];
		lifecycle.hooks.on("message.received", (payload) => {
			const envelope = (payload as { envelope?: { parts?: unknown[] } }).envelope;
			if (envelope?.parts !== undefined) receivedParts.push(...envelope.parts);
		});
		await lifecycle.start();
		await lifecycle.conversationPolicy.update({
			policy: { pacing: { burstMaxWaitMs: 60, burstSettleMs: 20 } },
			scope: "global",
		});
		// JPEG header bytes served as generic octet-stream so MIME sniffing is also exercised.
		const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		const server = Bun.serve({
			fetch: () => new Response(jpeg, { headers: { "content-type": "application/octet-stream" } }),
			port: 0,
		});
		try {
			transports[0]?.emitOpen();
			transports[0]?.emitMessage({
				message: [
					{ data: { text: "look" }, type: "text" },
					{
						data: {
							file: "photo.jpg",
							file_size: String(jpeg.byteLength),
							url: `http://127.0.0.1:${server.port}/photo`,
						},
						type: "image",
					},
				],
				message_id: 700_003,
				message_type: "private",
				post_type: "message",
				self_id: 99,
				sender: { card: "", nickname: "Test Nickname", user_id: 10_002 },
				time: Math.floor(Date.now() / 1_000),
				user_id: 10_002,
			});

			const userContent = await waitFor(async () => {
				return observedContext?.messages?.find((message) => message.role === "user")?.content;
			});
			expect(userContent).toEqual([
				{ text: expect.any(String), type: "text" },
				{ text: "look", type: "text" },
				{
					data: Buffer.from(jpeg).toString("base64"),
					mimeType: "image/jpeg",
					type: "image",
				},
			]);
			expect(receivedParts).toContainEqual(
				expect.objectContaining({
					mimeType: "image/jpeg",
					sizeBytes: jpeg.byteLength,
					type: "image",
				}),
			);
		} finally {
			server.stop(true);
			await lifecycle.stop();
		}
	});

	// Regression: a plugin-initiated send (the `onebot-napcat.send` tool or its admin RPC) reached
	// NapCat but wrote no domain row, so a DM the agent started from another conversation never
	// appeared in the WebUI. Sends and pokes must land in the target transcript.
	test("records plugin-initiated sends and pokes in the target transcript", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-napcat-outbound-"));
		directories.push(directory);
		const transports: FakeNapCatTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeNapCatTransport();
			transports.push(transport);
			return transport;
		};
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS: "127.0.0.1",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, factory]]),
				reply: { pendingGraceMs: 0 },
			},
		);
		await lifecycle.start();
		try {
			transports[0]?.emitOpen();
			const sent = await lifecycle.pluginHost.invokeRpc("onebot-napcat.send", {
				parts: [{ text: "Synthetic outbound message", type: "text" }],
				target: { channelId: "onebot", kind: "private", platformConversationId: "10003" },
			});
			expect(sent).toEqual({ ok: true, result: { platformMessageId: "7001" } });

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			// The target had never messaged the bot, so the chat object and session are created here.
			const chats = await database.select().from(chatObjects);
			const chat = chats.find((row) => row.platformConversationId === "10003");
			expect(chat?.kind).toBe("private");
			if (chat === undefined) throw new Error("outbound chat object missing");

			const outbound = await waitFor(async () => {
				const rows = await database.select().from(messages);
				return rows.find((row) => row.contentText === "Synthetic outbound message");
			});
			expect(outbound.chatObjectId).toBe(chat.id);
			expect(outbound.direction).toBe("outbound");
			expect(outbound.deliveryStatus).toBe("sent");
			expect(outbound.kind).toBe("onebot-v11");
			expect(outbound.platformMessageId).toBe("7001");

			const poked = (await lifecycle.pluginHost.invokeRpc("onebot-napcat.poke", {
				target: { channelId: "onebot", kind: "private", platformConversationId: "10003" },
				userId: "10003",
			})) as { ok: boolean };
			expect(poked.ok).toBe(true);
			const notices = await waitFor(async () => {
				const rows = await database.select().from(messages);
				const found = rows.filter((row) => row.kind === "notice");
				return found.length >= 1 ? found : undefined;
			});
			expect(notices[0]?.contentText).toContain("[poke]");
			expect(notices[0]?.conversationId).toBe(outbound.conversationId);
			expect(lifecycle.lastProcessingError).toBeUndefined();
		} finally {
			await lifecycle.stop();
		}
	});
});
