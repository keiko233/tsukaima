import { expect, test } from "bun:test";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { OneBotChannel } from "./channel.ts";
import { normalizeOneBotEvent } from "./normalize.ts";
import type { OneBotConfig, OneBotTransport, OneBotTransportFactory } from "./types.ts";

const privateEvent = {
	message: [
		{ data: { qq: 10_001 }, type: "at" },
		{ data: { text: "hello " }, type: "text" },
		{ data: { file: "sticker.png" }, type: "face" },
		{ data: { file: "https://example.test/image.png" }, type: "image" },
		{ data: { id: "source-message" }, type: "reply" },
	],
	message_id: 100,
	message_type: "private",
	post_type: "message",
	self_id: 99,
	sender: { card: "Test User", user_id: 10_001 },
	time: 123,
	user_id: 10_001,
} as const;

const groupEvent = {
	group_id: 555,
	message: [{ data: { text: "group hello" }, type: "text" }],
	message_id: "group-message-1",
	message_type: "group",
	post_type: "message",
	self_id: "99",
	sender: { card: "Test User", role: "admin", user_id: 10_001 },
	time: 456,
	user_id: 10_001,
} as const;

const config = (actionTimeoutMs = 100): OneBotConfig => ({
	actionTimeoutMs,
	botAccountId: "99",
	channelId: "onebot-test",
	reconnect: { initialDelayMs: 1, jitterRatio: 0, maxDelayMs: 4 },
	url: "ws://napcat.test",
});

class FakeWebSocket {
	closeCount = 0;
	private listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
		this.closeCount += 1;
		this.emit("close", []);
	}

	emit(name: string, args: unknown[]): void {
		for (const listener of this.listeners.get(name) ?? []) {
			(listener as (...listenerArgs: unknown[]) => void)(...args);
		}
	}

	on(name: string, listener: (...args: unknown[]) => void): void {
		const listeners = this.listeners.get(name) ?? [];
		listeners.push(listener);
		this.listeners.set(name, listeners);
	}

	send(data: string): void {
		this.emit("send", [data]);
	}

	respond(response: unknown): void {
		this.emit("message", [JSON.stringify(response)]);
	}
}

const createChannel = async () => {
	const sockets: FakeWebSocket[] = [];
	const headers: Record<string, string>[] = [];
	const sent: unknown[] = [];
	const envelopes: MessageEnvelope[] = [];
	const transportFactory: OneBotTransportFactory = (url, connectionHeaders) => {
		expect(url).toBe("ws://napcat.test");
		const socket = new FakeWebSocket();
		headers.push(connectionHeaders);
		socket.on("send", (data) => {
			sent.push(JSON.parse(data as string));
		});
		sockets.push(socket);
		const transport: OneBotTransport = {
			close: () => socket.close(),
			on: (name, listener) => socket.on(name, listener as (...args: unknown[]) => void),
			send: (data) => socket.send(data),
		};
		return transport;
	};
	const channel = new OneBotChannel(config(), transportFactory);
	channel.onMessage((envelope) => envelopes.push(envelope));
	await channel.start();
	sockets[0]?.emit("open", []);
	return { channel, envelopes, headers, sent, sockets };
};

test("rejects non-websocket urls", () => {
	const channel = new OneBotChannel({ ...config(), url: "http://napcat.test" }, () => {
		throw new Error("should not connect");
	});
	expect(channel.start()).rejects.toThrow("OneBot url must use ws:// or wss://");
});

test("sends the access token as a bearer header", async () => {
	const sockets: FakeWebSocket[] = [];
	const headers: Record<string, string>[] = [];
	const transportFactory: OneBotTransportFactory = (url, connectionHeaders) => {
		expect(url).toBe("wss://napcat.test");
		const socket = new FakeWebSocket();
		headers.push(connectionHeaders);
		sockets.push(socket);
		return {
			close: () => socket.close(),
			on: (name, listener) => {
				if (name === "open") socket.on("open", () => listener());
			},
			send: () => {},
		};
	};
	const channel = new OneBotChannel(
		{ ...config(), accessToken: "secret", url: "wss://napcat.test" },
		transportFactory,
	);
	await channel.start();
	sockets[0]?.emit("open", []);
	expect(headers[0]).toEqual({ Authorization: "Bearer secret" });
	expect(channel.diagnostics.state).toBe("open");
});

test("normalizes private messages and rejects invalid events", () => {
	const envelope = normalizeOneBotEvent(privateEvent, { botAccountId: "99", channelId: "onebot" });
	expect(envelope).toEqual({
		channelId: "onebot",
		channelKind: "onebot-v11",
		conversationKey: { kind: "private", peerId: "10001" },
		id: "100",
		mentions: [{ id: "10001" }],
		parts: [
			{ text: "hello ", type: "text" },
			{ sha256: "sticker.png", type: "sticker" },
			{ sha256: "https://example.test/image.png", type: "image" },
		],
		raw: privateEvent,
		sender: { displayName: "Test User", id: "10001", platformId: "10001" },
		source: { messageId: "100", timestampMs: 123_000 },
		target: { replyToEnvelopeId: "source-message" },
	});
	expect(normalizeOneBotEvent({ ...privateEvent, post_type: "notice" }, {
		botAccountId: "99",
		channelId: "onebot",
	})).toBeUndefined();
	expect(normalizeOneBotEvent({
		...privateEvent,
		message: [{ data: { id: "source-message" }, type: "reply" }],
	}, { botAccountId: "99", channelId: "onebot" })).toBeUndefined();
});

test("normalizes group messages", () => {
	const envelope = normalizeOneBotEvent(groupEvent, { botAccountId: "99", channelId: "onebot" });
	expect(envelope?.conversationKey).toEqual({ groupId: "555", kind: "group", peerId: "10001" });
	expect(envelope?.sender.groupRole).toBe("admin");
});

test("passes private and group send payloads through the transport", async () => {
	const { channel, sent, sockets } = await createChannel();
	const first = channel.sendPrivate("10001", [{ text: "hello", type: "text" }]);
	const second = channel.sendGroup("555", [
		{ sha256: "image-hash", type: "image" },
		{ sha256: "face-hash", type: "sticker" },
	]);
	expect(sent[0]).toEqual({
		action: "send_private_msg",
		echo: "echo-0",
		params: { message: [{ data: { text: "hello" }, type: "text" }], user_id: "10001" },
	});
	expect(sent[1]).toEqual({
		action: "send_group_msg",
		echo: "echo-1",
		params: {
			group_id: "555",
			message: [
				{ data: { file: "image-hash" }, type: "image" },
				{ data: { file: "face-hash" }, type: "face" },
			],
		},
	});
	sockets[0]?.respond({ data: { message_id: 1 }, echo: "echo-0", retcode: 0 });
	expect(await first).toEqual({ message_id: 1 });
	sockets[0]?.respond({ echo: "echo-1", retcode: 1200 });
	expect(second).rejects.toThrow("OneBot action failed: 1200");
	expect(channel.inFlightActions).toBe(0);
});

test("times out actions without responses", async () => {
	const { channel, sent, sockets } = await createChannel();
	const pending = channel.sendPrivate("10001", [{ text: "hello", type: "text" }]);
	expect(sent).toHaveLength(1);
	expect(channel.inFlightActions).toBe(1);
	expect(pending).rejects.toThrow("OneBot action timeout: send_private_msg");
	await Bun.sleep(120);
	expect(channel.inFlightActions).toBe(0);
	expect(channel.diagnostics.lastErrorClass).toBe("action-timeout");
	sockets[0]?.respond({ data: { message_id: 2 }, echo: "echo-0", retcode: 0 });
});

test("reconnects with capped exponential backoff", async () => {
	const { channel, sockets } = await createChannel();
	expect(sockets).toHaveLength(1);
	sockets[0]?.close();
	await Bun.sleep(5);
	expect(channel.diagnostics.reconnectAttempts).toBe(1);
	sockets[1]?.emit("open", []);
	expect(sockets).toHaveLength(2);
	expect(channel.diagnostics.state).toBe("open");
	sockets[1]?.close();
	await Bun.sleep(10);
	expect(channel.diagnostics.reconnectAttempts).toBe(1);
	expect(channel.diagnostics.state).toBe("connecting");
	sockets[2]?.emit("open", []);
	expect(sockets).toHaveLength(3);
	expect(channel.diagnostics.state).toBe("open");
	channel.stop();
	expect(sockets[2]?.closeCount).toBe(1);
});

test("accepts inbound events through the channel", async () => {
	const { envelopes, sockets } = await createChannel();
	sockets[0]?.emit("message", [JSON.stringify(privateEvent)]);
	sockets[0]?.emit("message", [JSON.stringify(groupEvent)]);
	sockets[0]?.emit("message", [JSON.stringify({ post_type: "meta_event" })]);
	expect(envelopes).toHaveLength(2);
	expect(envelopes[0]?.parts).toContainEqual({ sha256: "sticker.png", type: "sticker" });
	expect(envelopes[1]?.conversationKey).toEqual({ groupId: "555", kind: "group", peerId: "10001" });
});
