import { expect, test } from "bun:test";
import type { ChannelRequest, MessageEnvelope } from "@tsukaima/contracts";
import { inboundMediaBytes, OneBotChannel } from "./channel.ts";
import { normalizeOneBotEvent, normalizeOneBotRequest } from "./normalize.ts";
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
	const requests: ChannelRequest[] = [];
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
	channel.onRequest((request) => requests.push(request));
	await channel.start();
	sockets[0]?.emit("open", []);
	return { channel, envelopes, headers, requests, sent, sockets };
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
				if (name === "open") socket.on("open", () => (listener as () => void)());
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
			// The mention stays inline: the transcript and the model must see who was addressed.
			{ text: "@10001hello ", type: "text" },
			// A file name and a URL are not content hashes: they belong in `channelRef` and
			// `sourceUrl`, so downstream code cannot mistake an un-fetched remote image for bytes
			// it already has locally.
			{ channelRef: "onebot:face:unknown", type: "sticker" },
			{ sourceUrl: "https://example.test/image.png", type: "image" },
		],
		raw: privateEvent,
		sender: { displayName: "Test User", id: "10001", platformId: "10001" },
		source: {
			messageId: "100",
			// Local observation time; `timestampMs` stays the platform clock.
			receivedAtMs: expect.any(Number) as number,
			timestampMs: 123_000,
		},
		target: { replyToEnvelopeId: "source-message" },
	});
	expect(
		normalizeOneBotEvent(
			{ ...privateEvent, post_type: "notice" },
			{
				botAccountId: "99",
				channelId: "onebot",
			},
		),
	).toBeUndefined();
	expect(
		normalizeOneBotEvent(
			{
				...privateEvent,
				message: [{ data: { id: "source-message" }, type: "reply" }],
			},
			{ botAccountId: "99", channelId: "onebot" },
		),
	).toBeUndefined();
});

test("normalizes group messages", () => {
	const envelope = normalizeOneBotEvent(groupEvent, { botAccountId: "99", channelId: "onebot" });
	expect(envelope?.conversationKey).toEqual({ groupId: "555", kind: "group", peerId: "10001" });
	expect(envelope?.sender.groupRole).toBe("admin");
});

test("reads inbound image bytes through get_image and decodes inline base64", async () => {
	const { channel, sent, sockets } = await createChannel();
	const bytesPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
	const pending = channel.fetchMedia({ channelRef: "image-1", type: "image" });
	const request = sent[0] as {
		action: string;
		echo: string;
		params: Record<string, unknown>;
	};
	expect(request).toMatchObject({
		action: "get_image",
		params: { file: "image-1" },
	});
	sockets[0]?.respond({
		data: { base64: Buffer.from(bytesPng).toString("base64") },
		echo: request.echo,
		retcode: 0,
	});
	expect(await pending).toEqual(bytesPng);
	expect(inboundMediaBytes({ data: { file: "https://cdn.example/a.png" } })).toBeUndefined();
	expect(inboundMediaBytes({ data: { file: "data:image/png;base64,iVBORw0K" } })).toEqual(
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
	);
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
				{
					data: { file: "face-hash", sub_type: 1, summary: "[动画表情]" },
					type: "image",
				},
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
	const withoutReply = {
		...privateEvent,
		message: privateEvent.message.filter((segment) => segment.type !== "reply"),
	};
	sockets[0]?.emit("message", [JSON.stringify(withoutReply)]);
	sockets[0]?.emit("message", [JSON.stringify(groupEvent)]);
	sockets[0]?.emit("message", [JSON.stringify({ post_type: "meta_event" })]);
	expect(envelopes).toHaveLength(2);
	expect(envelopes[0]?.parts).toContainEqual({
		channelRef: "onebot:face:unknown",
		type: "sticker",
	});
	expect(envelopes[1]?.conversationKey).toEqual({ groupId: "555", kind: "group", peerId: "10001" });
});

test("ignores a malformed frame without throwing", async () => {
	const { envelopes, sockets } = await createChannel();
	expect(() => sockets[0]?.emit("message", ["{not json"])).not.toThrow();
	const withoutReply = {
		...privateEvent,
		message: privateEvent.message.filter((segment) => segment.type !== "reply"),
	};
	sockets[0]?.emit("message", [JSON.stringify(withoutReply)]);
	expect(envelopes).toHaveLength(1);
});

test("hydrates a quoted reply from get_msg", async () => {
	const { channel, envelopes, sent, sockets } = await createChannel();
	sockets[0]?.emit("message", [JSON.stringify(privateEvent)]);
	for (let attempt = 0; attempt < 50 && sent.length === 0; attempt += 1) await Bun.sleep(2);
	const action = sent.find((entry) => (entry as { action?: string }).action === "get_msg") as
		| { echo: string; params: Record<string, unknown> }
		| undefined;
	expect(action?.params).toEqual({ message_id: "source-message" });
	if (action !== undefined) {
		sockets[0]?.respond({
			data: {
				message: [{ data: { text: "the quoted text" }, type: "text" }],
				message_id: "source-message",
				sender: { card: "Quoted User", nickname: "Nickname", user_id: 10_002 },
			},
			echo: action.echo,
			retcode: 0,
		});
	}
	for (let attempt = 0; attempt < 50 && envelopes.length === 0; attempt += 1) await Bun.sleep(2);
	expect(envelopes[0]?.target).toEqual({
		replyToEnvelopeId: "source-message",
		quote: {
			excerpt: "the quoted text",
			senderDisplayName: "Quoted User",
			senderPlatformId: "10002",
		},
	});
	channel.stop();
});

test("keeps the reply id when get_msg fails", async () => {
	const { channel, envelopes, sent, sockets } = await createChannel();
	sockets[0]?.emit("message", [JSON.stringify(privateEvent)]);
	for (let attempt = 0; attempt < 50 && sent.length === 0; attempt += 1) await Bun.sleep(2);
	const action = sent.find((entry) => (entry as { action?: string }).action === "get_msg") as
		| { echo: string }
		| undefined;
	if (action !== undefined) {
		sockets[0]?.respond({ echo: action.echo, retcode: 1 });
	}
	for (let attempt = 0; attempt < 50 && envelopes.length === 0; attempt += 1) await Bun.sleep(2);
	expect(envelopes[0]?.target).toEqual({ replyToEnvelopeId: "source-message" });
	channel.stop();
});

test("normalizes and dispatches OneBot requests", async () => {
	const requestEvent = {
		comment: "please add me",
		flag: "friend-request-1",
		post_type: "request",
		request_type: "friend",
		self_id: 99,
		time: 789,
		user_id: 10_001,
	} as const;
	expect(
		normalizeOneBotRequest(requestEvent, { botAccountId: "99", channelId: "onebot-test" }),
	).toEqual({
		accountId: "99",
		channelId: "onebot-test",
		comment: "please add me",
		flag: "friend-request-1",
		kind: "friend",
		raw: requestEvent,
		receivedAtMs: 789_000,
		requesterId: "10001",
	});

	const { requests, sockets } = await createChannel();
	sockets[0]?.emit("message", [JSON.stringify(requestEvent)]);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.flag).toBe("friend-request-1");
});

test("passes request decisions through the transport", async () => {
	const { channel, sent, sockets } = await createChannel();
	const friend = channel.setFriendAddRequest("flag-1", true, "welcome");
	const group = channel.setGroupAddRequest("flag-2", "add", false, "declined");
	expect(sent[0]).toEqual({
		action: "set_friend_add_request",
		echo: "echo-0",
		params: { approve: true, flag: "flag-1", remark: "welcome" },
	});
	expect(sent[1]).toEqual({
		action: "set_group_add_request",
		echo: "echo-1",
		params: { approve: false, flag: "flag-2", reason: "declined", sub_type: "add" },
	});
	sockets[0]?.respond({ echo: "echo-0", retcode: 0 });
	sockets[0]?.respond({ echo: "echo-1", retcode: 0 });
	await Promise.all([friend, group]);
});

test("listGroups and listFriends accept numeric platform ids", async () => {
	const { channel, sent, sockets } = await createChannel();
	const groups = channel.listGroups();
	const groupRequest = sent[0] as { action: string; echo: string };
	expect(groupRequest.action).toBe("get_group_list");
	sockets[0]?.respond({
		data: [{ group_id: 555, group_name: "Numeric group" }],
		echo: groupRequest.echo,
		retcode: 0,
	});
	expect(await groups).toEqual([{ groupId: "555", title: "Numeric group" }]);

	const friends = channel.listFriends();
	const friendRequest = sent[1] as { action: string; echo: string };
	expect(friendRequest.action).toBe("get_friend_list");
	sockets[0]?.respond({
		data: [{ nickname: "Numeric friend", user_id: 10_001 }],
		echo: friendRequest.echo,
		retcode: 0,
	});
	expect(await friends).toEqual([{ title: "Numeric friend", userId: "10001" }]);
});
