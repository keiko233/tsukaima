import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope, MessagePart } from "@elaina/contracts";
import { chatObjects, conversations, messages } from "@elaina/db";
import {
	pluginManifestSchema,
	type ChannelAdapter,
	type ChannelDiagnostics,
	type ElainaPlugin,
	type SendResult,
} from "@elaina/sdk";
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

const channelPlugin: ElainaPlugin = {
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

const unauthorizedPlugin: ElainaPlugin = {
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

const firstPlugin: ElainaPlugin = {
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

const secondPlugin: ElainaPlugin = {
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

describe("reply.transform hook", () => {
	test("runs trusted handlers in order, gates permissions, and preserves media parts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-reply-transform-"));
		directories.push(directory);
		unauthorizedCalled = false;
		adapter.sent.length = 0;
		const { lifecycle } = createApp(
			{ ELAINA_DATA_DIR: directory, ELAINA_PORT: "7420" },
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
			expect(adapter.sent.flat()).toEqual([
				{ text: "hello first second", type: "text" },
				{ channelRef: "sticker-1", type: "sticker" },
			]);
		} finally {
			await lifecycle.stop();
		}
	});
});
