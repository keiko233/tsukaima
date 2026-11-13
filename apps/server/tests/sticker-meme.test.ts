import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { auditLog, chatObjects, conversations, messages } from "@elaina/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
} from "@elaina-plugin/onebot-napcat";
import type { MessagePart } from "@elaina/contracts";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

type RecordedAction = { readonly action: string; readonly params: Record<string, unknown> };

const createOneBotTransportSpy = () => {
	const actions: RecordedAction[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	let nextMessageId = 9_000;
	const createTransport: OneBotTransportFactory = (): OneBotTransport => {
		const listeners = new Map<string, (value?: unknown) => void>();
		connections.push({ emitOpen: () => listeners.get("open")?.() });
		return {
			close: () => listeners.get("close")?.(),
			on: (name, listener) => {
				listeners.set(name, listener as (value?: unknown) => void);
			},
			send: (data) => {
				const parsed = JSON.parse(data) as {
					action: string;
					echo: string;
					params: Record<string, unknown>;
				};
				actions.push({ action: parsed.action, params: parsed.params });
				nextMessageId += 1;
				const messageId = nextMessageId;
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify({ data: { message_id: messageId }, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return { actions, connections, createTransport };
};

async function createLifecycle(onebot: ReturnType<typeof createOneBotTransportSpy>) {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-sticker-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			ELAINA_DATA_DIR: directory,
			ELAINA_ONEBOT_WS_URL: "ws://napcat:3001",
			ELAINA_PORT: "7420",
			ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
		},
		{ pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.createTransport]]) },
	);
	await lifecycle.start();
	onebot.connections[0]?.emitOpen();
	return lifecycle;
}

async function createExternalSession(lifecycle: Awaited<ReturnType<typeof createLifecycle>>) {
	const host = lifecycle.conversationHost;
	const database = lifecycle.domainDatabase;
	if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
	const durableConversationId = await host.createConversation();
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: "private",
		platformConversationId: "user-1",
		title: "Tester",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "private",
		platformConversationId: "user-1",
		title: "Main",
		updatedAt: now,
	});
	return { chatId, durableConversationId, sessionId };
}

const decodeToolText = (result: {
	readonly result: { readonly content: readonly { text: string }[] };
}): unknown => JSON.parse(result.result.content[0]?.text ?? "{}");

const segmentsOf = (actions: readonly RecordedAction[]) =>
	actions
		.filter((action) => action.action === "send_private_msg")
		.flatMap(
			(action) => action.params.message as { data: Record<string, unknown>; type: string }[],
		);

describe("sticker-meme host integration", () => {
	test("imports, selects, transforms, and sends a real OneBot image with safe fallback", async () => {
		const onebot = createOneBotTransportSpy();
		const lifecycle = await createLifecycle(onebot);
		try {
			const context = lifecycle.pluginHost.context("sticker-meme");
			expect(context?.database?.prefix).toBe("plugin_sticker_meme_");
			expect(context?.media).toBeDefined();
			const tables = (await lifecycle.domainDatabase?.$client
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_sticker_meme_%'",
				)
				.all()) as { name: string }[];
			expect(tables.map((row) => row.name).toSorted()).toEqual([
				"plugin_sticker_meme_items",
				"plugin_sticker_meme_packs",
				"plugin_sticker_meme_send_tokens",
			]);

			const imageBytes = new TextEncoder().encode("real-sticker-bytes");
			const imageBase64 = Buffer.from(imageBytes).toString("base64");
			const imported = (await lifecycle.pluginHost.invokeRpc("sticker-meme.packs.importBundle", {
				dryRun: false,
				files: [{ dataBase64: imageBase64, path: "stickers/smile.png" }],
				manifest: {
					id: "pack-test",
					items: [
						{
							emotions: ["joy"],
							file: "stickers/smile.png",
							id: "item-smile",
							keywords: ["smile", "happy"],
							mimeType: "image/png",
							name: "Smile",
						},
					],
					name: "Test pack",
					personaIds: ["elaina"],
					tags: ["greeting"],
				},
			})) as { items: number; missingMedia: number };
			expect(imported).toMatchObject({ items: 1, missingMedia: 0 });

			const { durableConversationId } = await createExternalSession(lifecycle);
			const search = (await lifecycle.pluginHost.invokeTool(
				"sticker-meme.search",
				{ emotion: "joy", query: "smile" },
				{ conversationId: durableConversationId },
			)) as { ok: true; result: { content: readonly { text: string }[] } };
			expect(search.ok).toBe(true);
			const searchPayload = decodeToolText(search) as {
				readonly candidates: readonly { readonly itemId: string }[];
			};
			expect(searchPayload.candidates.map((candidate) => candidate.itemId)).toEqual(["item-smile"]);

			const chosen = (await lifecycle.pluginHost.invokeTool(
				"sticker-meme.choose",
				{ itemId: "item-smile" },
				{ conversationId: durableConversationId },
			)) as { ok: true; result: { content: readonly { text: string }[] } };
			const choice = decodeToolText(chosen) as {
				readonly directive: string;
				readonly sendToken: string;
			};
			expect(choice.directive).toBe(`[[sticker:${choice.sendToken}]]`);

			onebot.actions.length = 0;
			await lifecycle.replyDispatcher.handleAnswer({
				activityId: randomUUID(),
				conversationId: durableConversationId,
				entryId: "entry-sticker",
				text: `Look ${choice.directive} now`,
			});
			const segments = segmentsOf(onebot.actions);
			expect(segments.map((segment) => segment.type)).toEqual(["text", "image", "text"]);
			const imageFile = segments[1]?.data.file;
			expect(typeof imageFile).toBe("string");
			expect(String(imageFile).startsWith("base64://")).toBe(true);
			const decoded = Buffer.from(String(imageFile).slice("base64://".length), "base64");
			expect(new Uint8Array(decoded)).toEqual(imageBytes);
			expect(segments[0]?.data.text).toBe("Look");
			expect(segments[2]?.data.text).toBe("now");

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [outbound] = await database
				.select()
				.from(messages)
				.where(
					and(eq(messages.direction, "outbound"), eq(messages.durableEntryId, "entry-sticker")),
				)
				.limit(1);
			const parts = JSON.parse(outbound?.partsJson ?? "[]") as MessagePart[];
			expect(parts.map((part) => part.type)).toEqual(["text", "sticker", "text"]);
			expect(outbound?.contentText).not.toContain("[[sticker:");

			onebot.actions.length = 0;
			await lifecycle.replyDispatcher.handleAnswer({
				activityId: randomUUID(),
				conversationId: durableConversationId,
				entryId: "entry-invalid",
				text: "Bad [[sticker:not-a-token]]",
			});
			const fallbackSegments = segmentsOf(onebot.actions);
			expect(fallbackSegments.some((segment) => segment.type === "image")).toBe(false);
			expect(fallbackSegments.map((segment) => segment.data.text).join(" ")).toContain(
				"[sticker unavailable]",
			);
			const audits = await database.select().from(auditLog);
			expect(
				audits.some(
					(row) => row.action === "sticker.transform.rejected" && row.result === "denied",
				),
			).toBe(true);
			expect(
				audits.some((row) => row.action === "sticker.token.issued" && row.result === "ok"),
			).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	});
});
