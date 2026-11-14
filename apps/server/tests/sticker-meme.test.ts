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
			const tables =
				(await context?.database?.query<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_sticker_meme_%'",
				)) ?? [];
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
	test("imports a Telegram sticker set through the plugin RPC bridge", async () => {
		const onebot = createOneBotTransportSpy();
		const lifecycle = await createLifecycle(onebot);
		const server = Bun.serve({
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/getStickerSet")) {
					return Response.json({
						ok: true,
						result: {
							name: "myadestes_3_hanazono_serena",
							sticker_type: "regular",
							stickers: [
								{
									emoji: "😭",
									file_id: "file-sad",
									file_unique_id: "unique-sad",
									height: 512,
									is_animated: false,
									is_video: false,
									type: "regular",
									width: 512,
								},
							],
							title: "Serena",
						},
					});
				}
				if (url.pathname.endsWith("/getFile")) {
					return Response.json({
						ok: true,
						result: { file_id: "file-sad", file_path: "stickers/sad.webp" },
					});
				}
				if (url.pathname.startsWith("/file/bot")) {
					return new Response(new TextEncoder().encode("telegram-webp-bytes"), {
						headers: { "content-type": "image/webp" },
					});
				}
				return new Response("not found", { status: 404 });
			},
			port: 0,
		});
		try {
			await lifecycle.updatePluginConfig("sticker-meme", {
				telegramApiBaseUrl: server.url.origin,
				telegramBotToken: "123:test-token",
			});
			const configView = await lifecycle.pluginConfigView("sticker-meme");
			expect(configView.config).not.toHaveProperty("telegramBotToken");
			expect(configView.secretsSet).toContain("telegramBotToken");
			const initialProgress = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.progress",
				{},
			)) as {
				active: unknown;
			};
			expect(initialProgress.active).toBeNull();

			const report = (await lifecycle.pluginHost.invokeRpc("sticker-meme.telegram.import", {
				dryRun: false,
				semanticMode: "heuristic",
				url: "https://t.me/addstickers/myadestes_3_hanazono_serena",
			})) as {
				classified: number;
				items: number;
				setName: string;
				title: string;
			};
			expect(report).toMatchObject({
				classified: 1,
				items: 1,
				setName: "myadestes_3_hanazono_serena",
				title: "Serena",
			});

			const importProgress = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.progress",
				{},
			)) as {
				active: {
					classified: number;
					current: number;
					kind: string;
					packTitle?: string;
					skipped: number;
					stage: string;
					status: string;
					total: number | null;
				} | null;
			};
			expect(importProgress.active).toMatchObject({
				classified: 1,
				current: 1,
				kind: "telegram.import",
				packTitle: "Serena",
				skipped: 0,
				stage: "done",
				status: "completed",
				total: 1,
			});
			const items = (await lifecycle.pluginHost.invokeRpc("sticker-meme.items.list", {})) as {
				items: readonly {
					emotions: readonly string[];
					mimeType: string;
					mediaId: string;
					reviewStatus: string;
					semantic: { labels: readonly string[]; source: string };
				}[];
			};
			expect(items.items[0]).toMatchObject({
				emotions: expect.arrayContaining(["cry", "sad"]),
				mimeType: "image/webp",
				reviewStatus: "approved",
				semantic: { labels: expect.arrayContaining(["cry", "sad"]), source: "heuristic" },
			});
			expect(items.items[0]?.mediaId.length).toBeGreaterThan(0);
			const auditRows = await lifecycle.domainDatabase
				?.select()
				.from(auditLog)
				.where(eq(auditLog.action, "sticker.telegram.imported"))
				.all();
			expect(auditRows?.length).toBe(1);
		} finally {
			server.stop(true);
			await lifecycle.stop();
		}
	});

	test("lists configured provider models and classifies stickers with a selected model", async () => {
		const onebot = createOneBotTransportSpy();
		const lifecycle = await createLifecycle(onebot);
		const chatRequests: Array<{
			readonly model: string;
			readonly imageUrls: readonly string[];
		}> = [];
		const server = Bun.serve({
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/getStickerSet")) {
					return Response.json({
						ok: true,
						result: {
							name: "myadestes_3_hanazono_serena",
							sticker_type: "regular",
							stickers: [
								{
									emoji: "😭",
									file_id: "file-sad",
									file_unique_id: "unique-sad",
									height: 512,
									is_animated: false,
									is_video: false,
									type: "regular",
									width: 512,
								},
							],
							title: "Serena",
						},
					});
				}
				if (url.pathname.endsWith("/getFile")) {
					return Response.json({
						ok: true,
						result: { file_id: "file-sad", file_path: "stickers/sad.webp" },
					});
				}
				if (url.pathname.startsWith("/file/bot")) {
					return new Response(new TextEncoder().encode("telegram-webp-bytes"), {
						headers: { "content-type": "image/webp" },
					});
				}
				if (url.pathname === "/v1/chat/completions") {
					expect(request.headers.get("authorization")).toBe("Bearer provider-test-key");
					const body = (await request.json()) as {
						model: string;
						messages: Array<{
							role: string;
							content:
								| string
								| Array<{
										type: string;
										image_url?: { url?: string };
								  }>;
						}>;
					};
					const imageUrls = body.messages.flatMap((message) =>
						Array.isArray(message.content)
							? message.content
									.filter((part) => part.type === "image_url")
									.map((part) => part.image_url?.url ?? "")
							: [],
					);
					chatRequests.push({ imageUrls, model: body.model });
					return Response.json({
						id: "chatcmpl-test",
						object: "chat.completion",
						created: Math.floor(Date.now() / 1_000),
						model: body.model,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({
										confidence: 0.94,
										description: `Vision analysis via ${body.model}`,
										emotions: ["sad", "cry"],
										keywords: ["tears", "serena"],
										labels: ["sad", "cry", "cute"],
									}),
								},
								finish_reason: "stop",
							},
						],
						usage: {
							completion_tokens: 42,
							prompt_tokens: 118,
							total_tokens: 160,
						},
					});
				}
				return new Response("not found", { status: 404 });
			},
			port: 0,
		});
		try {
			await lifecycle.updatePluginConfig("openai-compatible", {
				apiKey: "provider-test-key",
				baseUrl: `${server.url.origin}/v1`,
				models: [
					{ enabled: true, id: "text-chat", name: "Text Chat", supportsImage: false },
					{ enabled: true, id: "vision-alpha", name: "Vision Alpha", supportsImage: true },
					{ enabled: true, id: "vision-beta", name: "Vision Beta", supportsImage: true },
				],
			});

			const catalog = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.semantic.models",
				{},
			)) as {
				configuredCustom: boolean;
				models: readonly {
					id: string;
					providerId: string;
					supportsImage: boolean;
				}[];
			};
			expect(catalog.configuredCustom).toBe(false);
			expect(
				catalog.models.map((model) => ({
					id: model.id,
					providerId: model.providerId,
					supportsImage: model.supportsImage,
				})),
			).toEqual([
				{ id: "vision-alpha", providerId: "openai-compatible", supportsImage: true },
				{ id: "vision-beta", providerId: "openai-compatible", supportsImage: true },
				{ id: "text-chat", providerId: "openai-compatible", supportsImage: false },
			]);

			await lifecycle.updatePluginConfig("sticker-meme", {
				semanticMode: "vision",
				semanticModel: "vision-beta",
				semanticProviderId: "openai-compatible",
				telegramApiBaseUrl: server.url.origin,
				telegramBotToken: "123:test-token",
			});

			const importReport = (await lifecycle.pluginHost.invokeRpc("sticker-meme.telegram.import", {
				dryRun: false,
				url: "https://t.me/addstickers/myadestes_3_hanazono_serena",
			})) as { classified: number; items: number };
			expect(importReport).toMatchObject({ classified: 1, items: 1 });
			expect(chatRequests).toHaveLength(1);
			expect(chatRequests[0]?.model).toBe("vision-beta");
			expect(chatRequests[0]?.imageUrls[0]?.startsWith("data:image/webp;base64,")).toBe(true);

			const importedItems = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.items.list",
				{},
			)) as {
				items: readonly {
					description: string;
					semantic: { labels: readonly string[]; model?: string; source: string };
				}[];
			};
			expect(importedItems.items[0]).toMatchObject({
				description: "Vision analysis via vision-beta",
				semantic: {
					labels: expect.arrayContaining(["sad", "cry", "cute"]),
					model: "vision-beta",
					source: "merged",
				},
			});

			const reclassifyReport = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.semantic.reclassify",
				{
					semanticMode: "vision",
					semanticModel: "vision-alpha",
					semanticProviderId: "openai-compatible",
				},
			)) as { classifier: string; skipped: number; updated: number };
			expect(reclassifyReport).toEqual({
				classifier: "vision:openai-compatible/vision-alpha",
				skipped: 0,
				updated: 1,
			});
			const reclassifyProgress = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.progress",
				{},
			)) as {
				active: {
					classified: number;
					current: number;
					kind: string;
					skipped: number;
					stage: string;
					status: string;
					total: number | null;
				} | null;
			};
			expect(reclassifyProgress.active).toMatchObject({
				classified: 1,
				current: 1,
				kind: "semantic.reclassify",
				skipped: 0,
				stage: "done",
				status: "completed",
				total: 1,
			});
			expect(chatRequests).toHaveLength(2);
			expect(chatRequests[1]?.model).toBe("vision-alpha");

			const reclassifiedItems = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.items.list",
				{},
			)) as {
				items: readonly {
					description: string;
					semantic: { model?: string; source: string };
				}[];
			};
			expect(reclassifiedItems.items[0]).toMatchObject({
				description: "Vision analysis via vision-alpha",
				semantic: { model: "vision-alpha", source: "merged" },
			});

			const pluginUsage = lifecycle.modelUsageLedger.records.filter(
				(record) => record.capability === "plugin:sticker-meme",
			);
			expect(pluginUsage).toEqual([
				{
					capability: "plugin:sticker-meme",
					inputTokens: 118,
					modelId: "vision-beta",
					outputTokens: 42,
					providerId: "openai-compatible",
				},
				{
					capability: "plugin:sticker-meme",
					inputTokens: 118,
					modelId: "vision-alpha",
					outputTokens: 42,
					providerId: "openai-compatible",
				},
			]);
		} finally {
			server.stop(true);
			await lifecycle.stop();
		}
	});
	test("finishes Telegram media import first and tracks deferred semantic work as its own job", async () => {
		const onebot = createOneBotTransportSpy();
		const lifecycle = await createLifecycle(onebot);
		const chatRequests: string[] = [];
		const server = Bun.serve({
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/getStickerSet")) {
					return Response.json({
						ok: true,
						result: {
							name: "myadestes_3_hanazono_serena",
							sticker_type: "regular",
							stickers: [
								{
									emoji: "😭",
									file_id: "file-sad",
									file_unique_id: "unique-sad",
									height: 512,
									is_animated: false,
									is_video: false,
									type: "regular",
									width: 512,
								},
							],
							title: "Serena",
						},
					});
				}
				if (url.pathname.endsWith("/getFile")) {
					return Response.json({
						ok: true,
						result: { file_id: "file-sad", file_path: "stickers/sad.webp" },
					});
				}
				if (url.pathname.startsWith("/file/bot")) {
					return new Response(new TextEncoder().encode("telegram-webp-bytes"), {
						headers: { "content-type": "image/webp" },
					});
				}
				if (url.pathname === "/v1/chat/completions") {
					const body = (await request.json()) as { model: string };
					chatRequests.push(body.model);
					return Response.json({
						id: "chatcmpl-deferred",
						object: "chat.completion",
						created: Math.floor(Date.now() / 1_000),
						model: body.model,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: JSON.stringify({
										confidence: 0.91,
										description: `Deferred vision via ${body.model}`,
										emotions: ["sad"],
										keywords: ["deferred"],
										labels: ["sad", "cry"],
									}),
								},
								finish_reason: "stop",
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			},
			port: 0,
		});
		try {
			await lifecycle.updatePluginConfig("openai-compatible", {
				apiKey: "provider-test-key",
				baseUrl: `${server.url.origin}/v1`,
				models: [{ enabled: true, id: "vision-beta", name: "Vision Beta", supportsImage: true }],
			});
			await lifecycle.updatePluginConfig("sticker-meme", {
				semanticMode: "vision",
				semanticModel: "vision-beta",
				semanticProviderId: "openai-compatible",
				telegramApiBaseUrl: server.url.origin,
				telegramBotToken: "123:test-token",
			});
			const importReport = (await lifecycle.pluginHost.invokeRpc("sticker-meme.telegram.import", {
				deferSemantic: true,
				dryRun: false,
				url: "https://t.me/addstickers/myadestes_3_hanazono_serena",
			})) as { classified: number; items: number; semanticDeferred?: boolean };
			expect(importReport).toMatchObject({
				classified: 0,
				items: 1,
				semanticDeferred: true,
			});

			const progress = (await lifecycle.pluginHost.invokeRpc("sticker-meme.progress", {})) as {
				active: { kind: string; status: string } | null;
				jobs: readonly { kind: string; status: string }[];
			};
			const kinds = progress.jobs.map((job) => job.kind);
			expect(kinds).toContain("telegram.import");
			expect(kinds).toContain("semantic.reclassify");
			expect(progress.active).not.toBeNull();

			let description = "";
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const items = (await lifecycle.pluginHost.invokeRpc("sticker-meme.items.list", {})) as {
					items: readonly { description: string }[];
				};
				description = items.items[0]?.description ?? "";
				if (description.length > 0 && description.startsWith("Deferred vision")) break;
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});
			}
			expect(description).toBe("Deferred vision via vision-beta");
			expect(chatRequests).toEqual(["vision-beta"]);

			const settledProgress = (await lifecycle.pluginHost.invokeRpc(
				"sticker-meme.progress",
				{},
			)) as {
				jobs: readonly {
					classified: number;
					current: number;
					kind: string;
					stage: string;
					status: string;
					total: number | null;
				}[];
			};
			const semanticJob = settledProgress.jobs.find((job) => job.kind === "semantic.reclassify");
			expect(semanticJob).toMatchObject({
				classified: 1,
				current: 1,
				stage: "done",
				status: "completed",
				total: 1,
			});
			const importJob = settledProgress.jobs.find((job) => job.kind === "telegram.import");
			expect(importJob).toMatchObject({ stage: "done", status: "completed" });
		} finally {
			server.stop(true);
			await lifecycle.stop();
		}
	});
});
