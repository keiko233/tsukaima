import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope, MessagePart } from "@tsukaima/contracts";
import { chatObjects, conversations, messages } from "@tsukaima/db";
import {
	pluginManifestSchema,
	type ChannelAdapter,
	type ChannelDiagnostics,
	type TsukaimaPlugin,
	type SendResult,
} from "@tsukaima/sdk";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

class RecordingAdapter implements ChannelAdapter {
	readonly id = "fake";
	readonly kind = "fake-channel";
	readonly sent: MessagePart[][] = [];
	capabilities() {
		return ["send", "send.image"] as const;
	}
	diagnostics(): ChannelDiagnostics {
		return { configured: true, connected: true, state: "open" };
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async send(_target: unknown, parts: readonly MessagePart[]): Promise<SendResult> {
		this.sent.push([...parts]);
		return { platformMessageId: `sent-${this.sent.length}` };
	}
	onEnvelope(_handler: (envelope: MessageEnvelope) => void): void {}
}

const adapter = new RecordingAdapter();
let unauthorizedCalled = false;

const channelPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "fake-channel",
		permissions: ["channel.send"],
		version: "0.1.0",
	}),
	setup(context) {
		context.channels?.register(adapter);
	},
};

const unauthorizedPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "unauthorized-transform",
		permissions: ["conversation.read"],
		version: "0.1.0",
	}),
	setup(context) {
		context.events.on("reply.transform", () => {
			unauthorizedCalled = true;
			return { text: "not allowed" };
		});
	},
};

const firstPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "first-transform",
		permissions: ["reply.transform"],
		version: "0.1.0",
	}),
	setup(context) {
		context.events.on("reply.transform", (payload) => {
			const input = payload as { readonly text: string };
			return { text: `${input.text} first` };
		});
	},
};

const secondPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "second-transform",
		permissions: ["reply.transform"],
		version: "0.1.0",
	}),
	setup(context) {
		context.events.on("reply.transform", (payload) => {
			const input = payload as {
				readonly parts: readonly MessagePart[];
				readonly text: string;
			};
			return {
				parts: [
					{ text: `${input.text} second`, type: "text" as const },
					{ channelRef: "sticker-1", type: "sticker" as const },
				],
				text: `${input.text} second`,
			};
		});
	},
};

const batchedPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "batched-transform",
		permissions: ["reply.transform"],
		version: "0.1.0",
	}),
	setup(context) {
		context.events.on("reply.transform", () => ({
			parts: [
				{ text: "first line\nsecond line", type: "text" as const },
				{ channelRef: "sticker-1", type: "sticker" as const },
				{ text: "third line", type: "text" as const },
			],
			text: "first line\nsecond line\nthird line",
		}));
	},
};

describe("reply.transform hook", () => {
	test("runs trusted handlers in order, gates permissions, and preserves media parts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-reply-transform-"));
		directories.push(directory);
		unauthorizedCalled = false;
		adapter.sent.length = 0;
		const { lifecycle } = createApp(
			{ TSUKAIMA_DATA_DIR: directory, TSUKAIMA_PORT: "7420" },
			{ plugins: [unauthorizedPlugin, channelPlugin, firstPlugin, secondPlugin] },
		);
		await lifecycle.start();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("domain database missing");
			await database.insert(chatObjects).values({
				channelId: "fake",
				id: "chat-1",
				kind: "private",
				platformConversationId: "peer-1",
				title: "Fake chat",
			});
			await database.insert(conversations).values({
				channelId: "fake",
				chatObjectId: "chat-1",
				durableConversationId: "durable-1",
				id: "session-1",
				isReceiving: 1,
				kind: "private",
				platformConversationId: "peer-1",
				title: "Fake session",
			});

			await lifecycle.replyDispatcher.handleAnswer({
				activityId: randomUUID(),
				conversationId: "durable-1",
				entryId: "entry-1",
				text: "hello",
			});

			const [outbound] = await database
				.select()
				.from(messages)
				.where(eq(messages.direction, "outbound"));
			expect(outbound?.contentText).toBe("hello first second");
			const parts = JSON.parse(outbound?.partsJson ?? "[]") as MessagePart[];
			expect(parts).toEqual([
				{ text: "hello first second", type: "text" },
				{ channelRef: "sticker-1", type: "sticker" },
			]);
			expect(unauthorizedCalled).toBe(false);
			expect(adapter.sent).toEqual([
				[{ text: "hello first second", type: "text" }],
				[{ channelRef: "sticker-1", type: "sticker" }],
			]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("applies a text-only transform to the delivered text", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-reply-text-transform-"));
		directories.push(directory);
		adapter.sent.length = 0;
		const { lifecycle } = createApp(
			{ TSUKAIMA_DATA_DIR: directory, TSUKAIMA_PORT: "7420" },
			{ plugins: [channelPlugin, firstPlugin] },
		);
		await lifecycle.start();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("domain database missing");
			await database.insert(chatObjects).values({
				channelId: "fake",
				id: "chat-text",
				kind: "private",
				platformConversationId: "peer-text",
				title: "Fake chat",
			});
			await database.insert(conversations).values({
				channelId: "fake",
				chatObjectId: "chat-text",
				durableConversationId: "durable-text",
				id: "session-text",
				isReceiving: 1,
				kind: "private",
				platformConversationId: "peer-text",
				title: "Fake session",
			});

			await lifecycle.replyDispatcher.handleAnswer({
				activityId: randomUUID(),
				conversationId: "durable-text",
				entryId: "entry-text",
				text: "hello",
			});

			expect(adapter.sent).toEqual([[{ text: "hello first", type: "text" }]]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("sends interleaved text and media as separate ordered messages", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-reply-batches-"));
		directories.push(directory);
		adapter.sent.length = 0;
		const { lifecycle } = createApp(
			{ TSUKAIMA_DATA_DIR: directory, TSUKAIMA_PORT: "7420" },
			{ plugins: [channelPlugin, batchedPlugin] },
		);
		await lifecycle.start();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("domain database missing");
			await database.insert(chatObjects).values({
				channelId: "fake",
				id: "chat-batch",
				kind: "private",
				platformConversationId: "peer-batch",
				title: "Fake chat",
			});
			await database.insert(conversations).values({
				channelId: "fake",
				chatObjectId: "chat-batch",
				durableConversationId: "durable-batch",
				id: "session-batch",
				isReceiving: 1,
				kind: "private",
				platformConversationId: "peer-batch",
				title: "Fake session",
			});

			await lifecycle.replyDispatcher.handleAnswer({
				activityId: randomUUID(),
				conversationId: "durable-batch",
				entryId: "entry-batch",
				text: "hello",
			});

			expect(adapter.sent).toEqual([
				[{ text: "first line", type: "text" }],
				[{ text: "second line", type: "text" }],
				[{ channelRef: "sticker-1", type: "sticker" }],
				[{ text: "third line", type: "text" }],
			]);
			const [outbound] = await database
				.select()
				.from(messages)
				.where(eq(messages.direction, "outbound"));
			expect(outbound?.contentText).toBe("first line\nsecond line\nthird line");
		} finally {
			await lifecycle.stop();
		}
	});
});
