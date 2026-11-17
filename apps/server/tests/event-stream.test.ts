import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveEvent, MessageEnvelope } from "@tsukaima/contracts";
import { createApp } from "../src/app.ts";
import { signIn as signInViaBetterAuth } from "./test-auth.ts";
import { createSlowStreamingModel } from "@tsukaima/core";

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
	return signInViaBetterAuth(app, "tsukaima", "correct-horse");
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

	// Regression: a run used to be invisible until it settled, so a slow model looked like a hung
	// bot. The stream now carries the agent's live state: streamed partial text while it works,
	// then a null run once the answer is durable.
	test("publishes live run state while the agent streams", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory), {
			eventHeartbeatMs: 100,
			model: createSlowStreamingModel(["The ", "answer ", "streams."], { delayMs: 150 }),
		});
		await lifecycle.start();
		const cookie = await signIn(app);
		const stream = await openEventStream(app, "/events/stream", cookie);
		await stream.next("snapshot");

		// Inbound channel traffic aggregates into a burst window (6s by default). The WebUI send
		// path submits immediately, which is what a live run needs to be observable here.
		const { createLocalChat, sendMessage } = await import("../src/services/webui.ts");
		const chat = await createLocalChat(lifecycle, { sessionTitle: "Live", title: "Live" });
		await sendMessage(lifecycle, { sessionId: chat.sessionId, target: "tsukaima", text: "hello" });

		// Collect run.delta frames until the run settles. A delta carries only the fields that
		// moved, so this also proves the stream is incremental rather than a full snapshot per tick.
		const partials: string[] = [];
		const phases = new Set<string>();
		let settled = false;
		for (let frame = 0; frame < 40 && !settled; frame += 1) {
			const next = await stream.next("run.delta");
			const event = next.data as LiveEvent & { type: "run.delta" };
			expect(event.sessionId.length).toBeGreaterThan(0);
			if (event.patch.phase !== undefined) phases.add(event.patch.phase);
			if (event.patch.partialText !== undefined) partials.push(event.patch.partialText);
			if (event.patch.settled === true) settled = true;
		}

		expect(settled).toBe(true);
		// Text must arrive before the run settles, which is the whole point of the feature.
		expect(partials.length).toBeGreaterThan(0);
		expect(phases.size).toBeGreaterThan(0);
		expect("The answer streams.".startsWith(partials[0]!)).toBe(true);

		await stream.close();
		auth.stop();
		await lifecycle.stop();
	});

	// A browser opened after a run started used to see nothing until the next poll. The KV cache
	// now hands the new connection a snapshot of every in-flight run before any delta.
	test("replays an active run snapshot from the KV cache on connect", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory), {
			eventHeartbeatMs: 1_000,
			model: createSlowStreamingModel(["one ", "two ", "three ", "four"], { delayMs: 200 }),
		});
		await lifecycle.start();
		const cookie = await signIn(app);
		const { createLocalChat, sendMessage } = await import("../src/services/webui.ts");
		const chat = await createLocalChat(lifecycle, {
			sessionTitle: "Reconnect",
			title: "Reconnect",
		});
		await sendMessage(lifecycle, { sessionId: chat.sessionId, target: "tsukaima", text: "hello" });

		let active: Awaited<ReturnType<typeof lifecycle.liveRuns.snapshots>>[number] | undefined;
		for (let attempt = 0; attempt < 20 && active === undefined; attempt += 1) {
			await Bun.sleep(50);
			active = (await lifecycle.liveRuns.snapshots()).find(
				(state) => state.sessionId === chat.sessionId,
			);
		}
		expect(active).toBeDefined();

		const stream = await openEventStream(app, "/events/stream", cookie);
		const event = await stream.next("run.state");
		expect(event.data).toMatchObject({
			run: { sessionId: chat.sessionId },
			sessionId: chat.sessionId,
			type: "run.state",
		});

		await stream.close();
		auth.stop();
		await lifecycle.stop();
	});
});

describe("authenticated media bytes", () => {
	// The transcript renders `<img src="/media/:id">`; without this route every image is a broken
	// icon even though the bytes are stored.
	test("serves stored bytes to a signed-in viewer", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();
		try {
			const stored = await lifecycle.media.store({
				bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
				kind: "image",
				mimeType: "image/png",
				source: "channel",
			});

			const anonymous = await app.handle(new Request(`http://localhost/media/${stored.id}`));
			expect(anonymous.status).toBe(401);

			const cookie = await signIn(app);
			const response = await app.handle(
				new Request(`http://localhost/media/${stored.id}`, { headers: { cookie } }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/png");
			expect(response.headers.get("cache-control")).toContain("immutable");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("content-security-policy")).toContain("sandbox");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
			);
		} finally {
			auth.stop();
			await lifecycle.stop();
		}
	});

	test("serves a non-media upload as an inert opaque download", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();
		try {
			const stored = await lifecycle.media.store({
				bytes: new TextEncoder().encode("<script>alert(1)</script>"),
				kind: "file",
				mimeType: "text/html",
				source: "channel",
			});
			const cookie = await signIn(app);
			const response = await app.handle(
				new Request(`http://localhost/media/${stored.id}`, { headers: { cookie } }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/octet-stream");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("content-security-policy")).toContain("sandbox");
		} finally {
			auth.stop();
			await lifecycle.stop();
		}
	});

	test("404s for an unknown media id", async () => {
		const directory = await createDirectory();
		const { app, auth, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();
		try {
			const cookie = await signIn(app);
			const response = await app.handle(
				new Request("http://localhost/media/does-not-exist", { headers: { cookie } }),
			);
			expect(response.status).toBe(404);
		} finally {
			auth.stop();
			await lifecycle.stop();
		}
	});
});
