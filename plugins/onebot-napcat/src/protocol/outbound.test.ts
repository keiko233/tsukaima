import { describe, expect, test } from "bun:test";
import type { MessagePart } from "@tsukaima/contracts";
import type { OutboundTarget } from "@tsukaima/sdk";
import { OneBotChannel, outboundActionTimeoutMs, toSegments } from "./channel.ts";
import type { OneBotConfig, OneBotTransport, OneBotTransportFactory } from "./types.ts";

const config: OneBotConfig = {
	actionTimeoutMs: 500,
	botAccountId: "99",
	channelId: "onebot-outbound",
	reconnect: { initialDelayMs: 1, jitterRatio: 0, maxDelayMs: 4 },
	url: "ws://napcat.test",
};

class FakeTransport implements OneBotTransport {
	readonly sent: Array<{ action: string; echo: string; params: Record<string, unknown> }> = [];
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {}

	on(name: string, listener: (...args: never[]) => void): void {
		const listeners = this.#listeners.get(name) ?? [];
		listeners.push(listener);
		this.#listeners.set(name, listeners);
	}

	send(data: string): void {
		const parsed = JSON.parse(data) as {
			action: string;
			echo: string;
			params: Record<string, unknown>;
		};
		this.sent.push(parsed);
		queueMicrotask(() => {
			const response =
				parsed.action === "get_friend_msg_history"
					? {
							messages: [
								{
									message: [{ data: { text: "history" }, type: "text" }],
									message_id: "m-1",
									sender: { user_id: "1" },
									time: 10,
								},
							],
						}
					: { message_id: 10 };
			this.#emit("message", JSON.stringify({ data: response, echo: parsed.echo, retcode: 0 }));
		});
	}

	#emit(name: string, payload: string): void {
		for (const listener of this.#listeners.get(name) ?? []) {
			(listener as (...args: unknown[]) => void)(payload);
		}
	}
}

async function createChannel() {
	const transport = new FakeTransport();
	const factory: OneBotTransportFactory = () => transport;
	const channel = new OneBotChannel(config, factory);
	await channel.start();
	return { channel, transport };
}

const privateTarget: OutboundTarget = {
	channelId: "onebot-outbound",
	kind: "private",
	platformConversationId: "10001",
};

const groupTarget: OutboundTarget = {
	channelId: "onebot-outbound",
	kind: "group",
	platformConversationId: "555",
};

const parts: MessagePart[] = [
	{ text: "hello", type: "text" },
	{ channelRef: "image-file", type: "image" },
	{ channelRef: "face:14", type: "sticker" },
	{ channelRef: "voice-file", durationMs: 1_000, type: "audio" },
	{ channelRef: "video-file", durationMs: 2_000, type: "video" },
	{ channelRef: "doc-file", fileName: "a.txt", type: "file" },
	{ nativeType: "json-card", summary: "safe card", type: "channel-native" },
];

describe("OneBot outbound serialization", () => {
	test("serializes all part types and safely degrades channel-native parts", () => {
		expect(toSegments(parts)).toEqual([
			{ data: { text: "hello" }, type: "text" },
			{ data: { file: "image-file" }, type: "image" },
			{ data: { id: "14" }, type: "face" },
			{ data: { duration: 1_000, file: "voice-file" }, type: "record" },
			{ data: { duration: 2_000, file: "video-file" }, type: "video" },
			{ data: { file: "doc-file", name: "a.txt" }, type: "file" },
			{ data: { text: "safe card" }, type: "text" },
		]);
	});

	test("sends media stickers as native animated stickers by default", () => {
		expect(toSegments([{ channelRef: "sticker-file", type: "sticker" }])).toEqual([
			{
				data: { file: "sticker-file", sub_type: 1, summary: "[动画表情]" },
				type: "image",
			},
		]);
	});

	test("falls back to a plain image when native stickers are disabled", () => {
		expect(
			toSegments([{ channelRef: "sticker-file", type: "sticker" }], { nativeSticker: false }),
		).toEqual([{ data: { file: "sticker-file" }, type: "image" }]);
	});

	test("gives media sends a longer default action timeout", () => {
		const defaultTimeoutConfig = { ...config };
		delete defaultTimeoutConfig.actionTimeoutMs;
		expect(outboundActionTimeoutMs(defaultTimeoutConfig, [{ text: "hello", type: "text" }])).toBe(
			5_000,
		);
		expect(
			outboundActionTimeoutMs(defaultTimeoutConfig, [
				{ channelRef: "sticker-file", type: "sticker" },
			]),
		).toBe(30_000);
		expect(outboundActionTimeoutMs(config, [{ channelRef: "sticker-file", type: "sticker" }])).toBe(
			500,
		);
	});

	test("prepends reply references and sends mixed media", async () => {
		const { channel, transport } = await createChannel();
		await channel.sendPrivate(
			"10001",
			[
				{ text: "quote me", type: "text" },
				{ channelRef: "image-file", type: "image" },
			],
			{ replyToPlatformMessageId: "source-message" },
		);
		expect(transport.sent.at(-1)).toMatchObject({
			action: "send_private_msg",
			params: {
				message: [
					{ data: { id: "source-message" }, type: "reply" },
					{ data: { text: "quote me" }, type: "text" },
					{ data: { file: "image-file" }, type: "image" },
				],
				user_id: "10001",
			},
		});
	});

	test("sends forward bundles with the platform action names", async () => {
		const { channel, transport } = await createChannel();
		await channel.sendForward(groupTarget, [{ text: "node", type: "text" }]);
		expect(transport.sent.at(-1)).toEqual({
			action: "send_group_forward_msg",
			echo: expect.any(String),
			params: {
				group_id: "555",
				messages: [
					{
						data: { content: [{ data: { text: "node" }, type: "text" }] },
						type: "node",
					},
				],
			},
		});
	});

	test("reads bounded history for reconciliation", async () => {
		const { channel, transport } = await createChannel();
		const history = await channel.readHistory(privateTarget, { limit: 5, sinceMs: 0 });
		expect(transport.sent.at(-1)?.action).toBe("get_friend_msg_history");
		expect(history).toEqual([
			{ platformMessageId: "m-1", senderId: "1", text: "history", timestampMs: 10_000 },
		]);
	});

	test("resolves content-addressed media bytes and downgrades unresolved local parts", async () => {
		const transport = new FakeTransport();
		const factory: OneBotTransportFactory = () => transport;
		const channel = new OneBotChannel(
			{
				...config,
				resolveMedia: async (part) =>
					"mediaId" in part && part.mediaId === "media-real" ? "base64://cmVhbA==" : undefined,
			},
			factory,
		);
		await channel.start();
		await channel.sendPrivate("10001", [
			{ mediaId: "media-real", sha256: "hash", type: "sticker" },
			{ mediaId: "media-missing", sha256: "other", type: "image" },
		]);
		expect(transport.sent.at(-1)).toMatchObject({
			action: "send_private_msg",
			params: {
				message: [
					{
						data: { file: "base64://cmVhbA==", sub_type: 1, summary: "[动画表情]" },
						type: "image",
					},
					{ data: { text: "[image unavailable]" }, type: "text" },
				],
				user_id: "10001",
			},
		});
	});
});
