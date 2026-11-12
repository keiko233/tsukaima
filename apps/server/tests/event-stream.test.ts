import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveEvent, MessageEnvelope } from "@tsukaima/contracts";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function createDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-events-"));
	directories.push(directory);
	return directory;
}

const adminEnv = (directory: string): Record<string, string> => ({
	TSUKAIMA_ADMIN_PASSWORD: "correct-horse",
	TSUKAIMA_ADMIN_USERNAME: "tsukaima",
	TSUKAIMA_DATA_DIR: directory,
	TSUKAIMA_PORT: "7420",
});

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

type App = ReturnType<typeof createApp>["app"];

async function signIn(app: App): Promise<string> {
	const response = await app.handle(
		new Request("http://localhost/rpc/auth/login", {
			body: JSON.stringify({
				json: { password: "correct-horse", username: "tsukaima" },
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		}),
	);
	expect(response.status).toBe(200);
	const setCookie = response.headers.get("set-cookie") ?? "";
	expect(setCookie).toContain("tsukaima_admin_session=");
	return setCookie.split(";")[0] ?? "";
}

interface SseFrame {
	readonly data: unknown;
	readonly event: string;
}

async function openEventStream(app: App, path: string, cookie: string) {
	const abort = new AbortController();
	const response = await app.handle(
		new Request(`http://localhost${path}`, {
			headers: { cookie },
			signal: abort.signal,
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error("SSE response has no body");
	const decoder = new TextDecoder();
	let buffer = "";

	const next = async (eventName?: string): Promise<SseFrame> => {
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline) {
			const separator = buffer.indexOf("\n\n");
			if (separator !== -1) {
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				if (frame.trim().length === 0) continue;
				const lines = frame.split("\n");
				const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
				const dataLine = lines.find((line) => line.startsWith("data: "));
				const data: unknown = dataLine === undefined ? null : JSON.parse(dataLine.slice(6));
				if (eventName === undefined || event === eventName) return { data, event };
				continue;
			}
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(
							() => reject(new Error(`Timed out waiting for SSE event ${eventName ?? "*"}`)),
							Math.max(1, deadline - Date.now()),
						);
					}),
				]);
				if (result.done || result.value === undefined) throw new Error("SSE stream closed");
				buffer += decoder.decode(result.value, { stream: true });
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
			}
		}
		throw new Error(`Timed out waiting for SSE event ${eventName ?? "*"}`);
	};

	return {
		close: async () => {
			await reader.cancel();
			abort.abort();
		},
		next,
	};
}

describe("authenticated live event stream", () => {
	test("rejects anonymous stream requests when admin credentials are configured", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();
		await auth.ensureInitialized();

		const stream = await app.handle(new Request("http://localhost/events/stream"));
		expect(stream.status).toBe(401);
		const logs = await app.handle(new Request("http://localhost/events/logs"));
		expect(logs.status).toBe(401);

		auth.stop();
		await lifecycle.stop();
	});

	test("sends snapshot, message.received, and heartbeat after sign-in", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory), { eventHeartbeatMs: 20 });
		await lifecycle.start();
		const cookie = await signIn(app);
		const stream = await openEventStream(app, "/events/stream", cookie);

		const snapshot = await stream.next("snapshot");
		expect(snapshot.data).toMatchObject({
			lifecycle: { state: "ready" },
			processedMessages: 0,
			type: "snapshot",
		});

		await lifecycle.processEnvelope(envelope("event-message-1", "hello"));
		const received = await stream.next("message.received");
		const receivedEvent = received.data as LiveEvent & { type: "message.received" };
		expect(receivedEvent).toMatchObject({
			channelId: "onebot",
			messageId: "event-message-1",
			type: "message.received",
		});
		expect(receivedEvent.sessionId.length).toBeGreaterThan(0);
		expect(receivedEvent.chatObjectId.length).toBeGreaterThan(0);

		const heartbeat = await stream.next("heartbeat");
		expect(heartbeat.data).toMatchObject({ type: "heartbeat" });

		await stream.close();
		auth.stop();
		await lifecycle.stop();
	});

	test("fans one live event out to every subscriber", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory), { eventHeartbeatMs: 100 });
		await lifecycle.start();
		const cookie = await signIn(app);
		const first = await openEventStream(app, "/events/stream", cookie);
		const second = await openEventStream(app, "/events/stream", cookie);

		await Promise.all([first.next("snapshot"), second.next("snapshot")]);
		await lifecycle.processEnvelope(envelope("event-message-fanout", "hello both"));
		const [firstMessage, secondMessage] = await Promise.all([
			first.next("message.received"),
			second.next("message.received"),
		]);
		expect(firstMessage.data).toMatchObject({ messageId: "event-message-fanout" });
		expect(secondMessage.data).toMatchObject({ messageId: "event-message-fanout" });

		await first.close();
		await second.close();
		auth.stop();
		await lifecycle.stop();
	});
});
