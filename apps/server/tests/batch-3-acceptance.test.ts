import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import { chatObjects, conversations, messages } from "@tsukaima/db";
import { providerSafeToolName } from "@tsukaima/sdk";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
import type { TsukaimaLifecycle } from "../src/lifecycle.ts";

const directories: string[] = [];
const lifecycles: TsukaimaLifecycle[] = [];

afterEach(async () => {
	await Promise.all(
		lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
	);
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

type RecordedAction = { readonly action: string; readonly params: Record<string, unknown> };
type CapturedRequest = {
	readonly messages?: readonly unknown[];
	readonly tools?: readonly {
		readonly function?: { readonly name?: string };
		readonly name?: string;
	}[];
};

const createOneBotTransportSpy = () => {
	const actions: RecordedAction[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	let nextMessageId = 9_100;
	let respond: ((action: string, params: Record<string, unknown>) => unknown) | undefined;
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
				const responseData =
					respond?.(parsed.action, parsed.params) ??
					(parsed.action === "get_group_list" || parsed.action === "get_friend_list"
						? []
						: parsed.action === "get_group_msg_history" ||
							  parsed.action === "get_friend_msg_history"
							? { messages: [] }
							: { message_id: nextMessageId++ });
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify({ data: responseData, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return {
		actions,
		connections,
		createTransport,
		setRespond: (handler: typeof respond) => {
			respond = handler;
		},
	};
};

async function createHarness() {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-3-"));
	directories.push(directory);
	const onebot = createOneBotTransportSpy();
	const captured: CapturedRequest[] = [];
	const model = createOpenAICompatibleModelPort(
		{
			apiKey: "test-key",
			baseUrl: "http://capture.invalid/v1",
			fetch: (async (_input, init) => {
				const request = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest;
				captured.push(request);
				return Response.json({
					choices: [{ finish_reason: "stop", message: { content: "ok" } }],
					id: "resp-ok",
					model: "capture-model",
					usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
				});
			}) as typeof fetch,
		},
		[{ capabilities: ["basic-chat", "tool-use"], modelId: "capture-model" }],
	);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		},
		{
			model,
			pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.createTransport]]),
		},
	);
	await lifecycle.start();
	lifecycles.push(lifecycle);
	onebot.connections[0]?.emitOpen();
	return { captured, lifecycle, onebot };
}

async function createExternalSession(
	lifecycle: TsukaimaLifecycle,
	input: {
		readonly kind: "group" | "private";
		readonly platformConversationId: string;
		readonly title: string;
	},
): Promise<{
	readonly chatId: string;
	readonly durableConversationId: string;
	readonly sessionId: string;
}> {
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
		kind: input.kind,
		platformConversationId: input.platformConversationId,
		title: input.title,
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: input.kind,
		platformConversationId: input.platformConversationId,
		title: input.title,
		updatedAt: now,
	});
	const policy = await lifecycle.conversationPolicy.effectivePolicy(sessionId);
	const apply = (
		lifecycle as unknown as {
			applySessionToolPolicy(
				id: string,
				policy: { readonly capabilities: readonly string[] },
			): Promise<void>;
		}
	).applySessionToolPolicy.bind(lifecycle);
	await apply(durableConversationId, { capabilities: policy.capabilities });
	return { chatId, durableConversationId, sessionId };
}

const groupEnvelope = (
	id: string,
	text: string,
	platformConversationId: string,
): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { groupId: platformConversationId, kind: "group", peerId: "10005" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "10005", platformId: "10005" },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

const toolNames = (request: CapturedRequest): string[] =>
	(request.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? "");

const segmentsOf = (
	action: RecordedAction | undefined,
): { data: Record<string, unknown>; type: string }[] =>
	(action?.params.message as { data: Record<string, unknown>; type: string }[] | undefined) ?? [];

const decodeToolResult = (result: unknown): unknown => {
	const content =
		(result as { readonly content?: readonly { readonly text?: string }[] }).content ?? [];
	return JSON.parse(content[0]?.text ?? "{}");
};

const invokeTool = async (
	lifecycle: TsukaimaLifecycle,
	name: string,
	input: Record<string, unknown>,
	durableConversationId: string,
) =>
	await lifecycle.pluginHost.invokeTool(name, input, {
		conversationId: durableConversationId,
	});

describe("Batch 3 acceptance", () => {
	test("first group model request exposes clean eager chat tools and keeps admin tools deferred", async () => {
		const harness = await createHarness();
		const session = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20001",
			title: "Synthetic group",
		});
		const host = harness.lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		await host.append({
			conversationId: session.durableConversationId,
			envelope: groupEnvelope("eager-first-message", "hello", "20001"),
			forceSubmit: true,
			submittedAtMs: Date.now(),
		});
		const request = await waitFor(() => harness.captured[0]);
		const offered = toolNames(request);
		expect(offered).toEqual(
			expect.arrayContaining([
				"onebot-napcat_send",
				"onebot-napcat_readHistory",
				"onebot-napcat_viewImage",
				"onebot-napcat_poke",
				"onebot-napcat_react",
				"onebot-napcat_listTargets",
				"sticker-meme_send",
				"memory_recall",
				"memory_save",
				"schedule_create",
				"schedule_list",
				"schedule_cancel",
			]),
		);
		expect(offered).not.toContain("schedule");
		for (const deferred of [
			"groupBan",
			"groupKick",
			"rawAction",
			"deleteMessage",
			"setProfile",
			"lookupMessage",
			"analyze",
		]) {
			expect(offered).not.toContain(deferred);
		}
		expect(offered.some((name) => /_[0-9a-f]{8}$/u.test(name))).toBe(false);
	});

	test("current-chat addressing covers send/history/poke/react/forward/listTargets/viewImage and denies cross-chat sends", async () => {
		const harness = await createHarness();
		const current = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20001",
			title: "Current group",
		});
		const disabled = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20002",
			title: "Disabled group",
		});
		await harness.lifecycle.conversationPolicy.update({
			conversationId: disabled.sessionId,
			policy: { enabled: false, trigger: { groupAccess: "disabled" } },
			scope: "conversation",
		});
		harness.onebot.setRespond((action) => {
			if (action === "get_group_list") {
				return [
					{ group_id: "20001", group_name: "Current group" },
					{ group_id: "20002", group_name: "Disabled group" },
					{ group_id: "20003", group_name: "Discovered group" },
				];
			}
			if (action === "get_friend_list") {
				return [{ nickname: "Discovered friend", user_id: "10002" }];
			}
			if (action === "get_group_msg_history") return { messages: [] };
			return { message_id: 9_500 };
		});
		const durable = current.durableConversationId;

		const send = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.send",
			{
				parts: [
					{ text: "Synthetic current-chat send", type: "text" },
					{ type: "image", url: "https://example.invalid/current.png" },
				],
			},
			durable,
		);
		expect(send.ok).toBe(true);
		const sendAction = harness.onebot.actions.find(
			(action) => action.action === "send_group_msg" && action.params.group_id === "20001",
		);
		expect(segmentsOf(sendAction).map((segment) => segment.type)).toEqual(["text", "image"]);
		expect(segmentsOf(sendAction)[1]?.data.file).toBe("https://example.invalid/current.png");

		const history = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.readHistory",
			{ count: 5 },
			durable,
		);
		expect(history.ok).toBe(true);
		expect(
			harness.onebot.actions.some(
				(action) => action.action === "get_group_msg_history" && action.params.group_id === "20001",
			),
		).toBe(true);

		const poke = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.poke",
			{ userId: "10005" },
			durable,
		);
		expect(poke.ok).toBe(true);
		expect(
			harness.onebot.actions.some(
				(action) =>
					action.action === "group_poke" &&
					action.params.group_id === "20001" &&
					action.params.user_id === "10005",
			),
		).toBe(true);

		const react = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.react",
			{ emojiId: "128077", messageId: "[msg:777]" },
			durable,
		);
		expect(react.ok).toBe(true);
		expect(
			harness.onebot.actions.some(
				(action) => action.action === "set_msg_emoji_like" && action.params.message_id === "777",
			),
		).toBe(true);

		const forward = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.forwardMessage",
			{ messageId: "[msg:777]" },
			durable,
		);
		expect(forward.ok).toBe(true);
		expect(
			harness.onebot.actions.some(
				(action) =>
					action.action === "forward_group_single_msg" &&
					action.params.group_id === "20001" &&
					action.params.message_id === "777",
			),
		).toBe(true);

		const targets = await invokeTool(harness.lifecycle, "onebot-napcat.listTargets", {}, durable);
		expect(targets.ok).toBe(true);
		expect(targets.ok && decodeToolResult(targets.result)).toMatchObject({
			currentChat: { kind: "group", platformConversationId: "20001" },
		});
		if (!targets.ok) throw new Error("targets unavailable");
		const listed = decodeToolResult(targets.result) as {
			readonly targets: readonly { readonly platformConversationId: string }[];
		};
		expect(listed.targets.map((target) => target.platformConversationId)).not.toContain("20002");
		expect(listed.targets.map((target) => target.platformConversationId)).toContain("20001");

		const bytes = new TextEncoder().encode("synthetic-image-bytes");
		const stored = await harness.lifecycle.media.store({
			bytes,
			kind: "image",
			mimeType: "image/png",
			source: "channel",
		});
		await harness.lifecycle.domainDatabase?.insert(messages).values({
			contentText: "[image]",
			conversationId: current.sessionId,
			direction: "inbound",
			id: randomUUID(),
			kind: "onebot-v11",
			occurredAt: new Date().toISOString(),
			partsJson: JSON.stringify([
				{
					mediaId: stored.id,
					mimeType: stored.mimeType,
					sha256: stored.sha256,
					type: "image",
				},
			]),
			platformMessageId: "image-message",
			senderDisplayName: "Tester",
			senderExternalId: "10005",
		});
		const viewed = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.viewImage",
			{ messageId: "[msg:image-message]" },
			durable,
		);
		expect(viewed.ok).toBe(true);
		if (!viewed.ok) throw new Error("viewImage unavailable");
		expect(viewed.result.images?.[0]).toMatchObject({ mimeType: "image/png" });
		expect(Buffer.from(viewed.result.images?.[0]?.data ?? "", "base64")).toEqual(
			Buffer.from(bytes),
		);

		await expect(
			invokeTool(
				harness.lifecycle,
				"onebot-napcat.send",
				{
					parts: [{ text: "cross-chat", type: "text" }],
					target: { kind: "group", platformConversationId: "20002" },
				},
				durable,
			),
		).rejects.toThrow("cross-chat-target-disabled");
	});

	test("inline sticker markers resolve without a tool call, hints are bounded, and sticker-meme.send is single-step", async () => {
		const harness = await createHarness();
		const session = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20001",
			title: "Synthetic group",
		});
		const bytes = Buffer.from("sticker-bytes").toString("base64");
		await harness.lifecycle.pluginHost.invokeRpc("sticker-meme.packs.importBundle", {
			dryRun: false,
			files: [{ dataBase64: bytes, path: "stickers/happy.png" }],
			manifest: {
				id: "pack-batch-3",
				items: [
					{
						emotions: ["joy", "happy"],
						file: "stickers/happy.png",
						id: "item-happy",
						keywords: ["happy", "smile"],
						mimeType: "image/png",
						name: "开心",
					},
				],
				name: "Batch 3 pack",
			},
		});
		const hints = (await harness.lifecycle.pluginHost.invokeRpc("sticker-meme.hints", {})) as {
			readonly captions: readonly string[];
		};
		expect(hints.captions).toContain("开心");

		const sections = await harness.lifecycle.contextProvider.renderTurnContext({
			conversationId: session.durableConversationId,
			inputs: [],
			nowMs: Date.now(),
			triggers: [],
		});
		const stickerSection = sections.find((section) => section.key === "stickers");
		expect(stickerSection?.text).toContain("- 开心");
		expect(
			stickerSection?.text.split("\n").filter((line) => line.startsWith("- ")).length,
		).toBeLessThanOrEqual(3);

		harness.onebot.actions.length = 0;
		await harness.lifecycle.replyDispatcher.handleAnswer({
			activityId: randomUUID(),
			conversationId: session.durableConversationId,
			entryId: "inline-sticker-entry",
			text: "[表情:开心]",
		});
		const inlineSend = harness.onebot.actions.find(
			(action) => action.action === "send_group_msg" && action.params.group_id === "20001",
		);
		expect(segmentsOf(inlineSend)).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ sub_type: 1 }),
				type: "image",
			}),
		]);

		harness.onebot.actions.length = 0;
		const send = await invokeTool(
			harness.lifecycle,
			"sticker-meme.send",
			{ query: "开心" },
			session.durableConversationId,
		);
		expect(send.ok).toBe(true);
		if (!send.ok) throw new Error("sticker send unavailable");
		const payload = decodeToolResult(send.result) as {
			readonly itemId: string;
			readonly matchedBy: string;
			readonly name: string;
			readonly packId: string;
			readonly packName: string;
			readonly sent: boolean;
		};
		expect(payload).toMatchObject({
			itemId: "item-happy",
			matchedBy: "query",
			name: "开心",
			packId: "pack-batch-3",
			packName: "Batch 3 pack",
			sent: true,
		});
		const immediateSend = harness.onebot.actions.find(
			(action) => action.action === "send_group_msg" && action.params.group_id === "20001",
		);
		expect(segmentsOf(immediateSend)).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ sub_type: 1 }),
				type: "image",
			}),
		]);

		harness.onebot.actions.length = 0;
		await harness.lifecycle.replyDispatcher.handleAnswer({
			activityId: randomUUID(),
			conversationId: session.durableConversationId,
			entryId: "directive-sticker-entry",
			text: "Legacy [[sticker:st_legacy]]",
		});
		const directiveSegments = harness.onebot.actions
			.filter((action) => action.action === "send_group_msg" && action.params.group_id === "20001")
			.flatMap((action) => segmentsOf(action));
		expect(directiveSegments.every((segment) => segment.type === "text")).toBe(true);
		expect(JSON.stringify(directiveSegments)).toContain("[sticker unavailable]");
	});

	test("suppresses duplicate final text after a channel tool send while preserving stickers and new text", async () => {
		const harness = await createHarness();
		const session = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20001",
			title: "Synthetic group",
		});
		const bytes = Buffer.from("duplicate-sticker-bytes").toString("base64");
		await harness.lifecycle.pluginHost.invokeRpc("sticker-meme.packs.importBundle", {
			dryRun: false,
			files: [{ dataBase64: bytes, path: "stickers/happy.png" }],
			manifest: {
				id: "pack-duplicate",
				items: [
					{
						emotions: ["joy"],
						file: "stickers/happy.png",
						id: "item-duplicate",
						keywords: ["happy"],
						mimeType: "image/png",
						name: "开心",
					},
				],
				name: "Duplicate pack",
			},
		});
		const durable = session.durableConversationId;

		harness.onebot.actions.length = 0;
		await invokeTool(
			harness.lifecycle,
			"onebot-napcat.send",
			{ parts: [{ text: "SENT VIA TOOL", type: "text" }] },
			durable,
		);
		await harness.lifecycle.replyDispatcher.handleAnswer({
			activityId: randomUUID(),
			conversationId: durable,
			entryId: "duplicate-text-entry",
			text: "SENT VIA TOOL",
		});
		expect(
			harness.onebot.actions.filter((action) => action.action === "send_group_msg"),
		).toHaveLength(1);

		await invokeTool(
			harness.lifecycle,
			"onebot-napcat.send",
			{ parts: [{ text: "Look", type: "text" }] },
			durable,
		);
		await harness.lifecycle.replyDispatcher.handleAnswer({
			activityId: randomUUID(),
			conversationId: durable,
			entryId: "duplicate-with-sticker-entry",
			text: "Look\n[表情:开心]",
		});
		const stickerAction = harness.onebot.actions.at(-1);
		expect(segmentsOf(stickerAction)).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ sub_type: 1 }),
				type: "image",
			}),
		]);

		await invokeTool(
			harness.lifecycle,
			"onebot-napcat.send",
			{ parts: [{ text: "Hello there", type: "text" }] },
			durable,
		);
		await harness.lifecycle.replyDispatcher.handleAnswer({
			activityId: randomUUID(),
			conversationId: durable,
			entryId: "partially-new-entry",
			text: "Hello there\nFresh detail",
		});
		const newTextAction = harness.onebot.actions.at(-1);
		expect(segmentsOf(newTextAction)).toEqual([{ data: { text: "Fresh detail" }, type: "text" }]);
	});

	test("a transient domain DB read failure keeps non-coding chat tools instead of wiping the allowlist", async () => {
		const harness = await createHarness();
		const session = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20001",
			title: "Synthetic group",
		});
		const host = harness.lifecycle.conversationHost;
		const database = harness.lifecycle.domainDatabase;
		if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
		await host.setModelToolAllowlist(session.durableConversationId, [
			providerSafeToolName("onebot-napcat.send"),
			providerSafeToolName("memory.recall"),
			"workspace_spawn",
		]);
		const originalSelect = database.select;
		const apply = (
			harness.lifecycle as unknown as {
				applySessionToolPolicy(
					id: string,
					policy: { readonly capabilities: readonly string[] },
				): Promise<void>;
			}
		).applySessionToolPolicy.bind(harness.lifecycle);
		try {
			database.select = (() => {
				throw new Error("synthetic transient read failure");
			}) as typeof database.select;
			await apply(session.durableConversationId, { capabilities: [] });
		} finally {
			database.select = originalSelect;
		}
		const inspection = await host.inspectConversationContext(session.durableConversationId);
		const names = inspection?.tools.map((tool) => tool.name) ?? [];
		expect(names).toContain(providerSafeToolName("onebot-napcat.send"));
		// `memory_recall` in the persisted allowlist resolves to the namespaced model tool name.
		expect(names).toContain("memory_recall");
		expect(names).not.toContain("workspace_spawn");
		expect(names.length).toBeGreaterThan(0);
	});

	test("a private chat keeps the same current-chat target defaults and bounded image error guidance", async () => {
		const harness = await createHarness();
		const session = await createExternalSession(harness.lifecycle, {
			kind: "private",
			platformConversationId: "10002",
			title: "Synthetic private chat",
		});
		const durable = session.durableConversationId;
		const read = await invokeTool(harness.lifecycle, "onebot-napcat.readHistory", {}, durable);
		expect(read.ok).toBe(true);
		expect(
			harness.onebot.actions.some(
				(action) => action.action === "get_friend_msg_history" && action.params.user_id === "10002",
			),
		).toBe(true);
		await expect(
			invokeTool(harness.lifecycle, "onebot-napcat.viewImage", {}, durable),
		).rejects.toThrow("recent [msg:<id>], mediaId, or sha256");
	});
});

describe("Batch 3 acceptance: viewImage conversation scoping", () => {
	test("only resolves media referenced by a message in the scoped conversation and caps bytes", async () => {
		const harness = await createHarness();
		const current = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20001",
			title: "Current group",
		});
		const other = await createExternalSession(harness.lifecycle, {
			kind: "group",
			platformConversationId: "20002",
			title: "Other group",
		});
		const database = harness.lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const bytes = new TextEncoder().encode("synthetic-scoped-image");
		const stored = await harness.lifecycle.media.store({
			bytes,
			kind: "image",
			mimeType: "image/png",
			source: "channel",
		});
		await database.insert(messages).values({
			contentText: "[image]",
			conversationId: current.sessionId,
			direction: "inbound",
			id: randomUUID(),
			kind: "onebot-v11",
			occurredAt: new Date().toISOString(),
			partsJson: JSON.stringify([
				{ mediaId: stored.id, mimeType: stored.mimeType, sha256: stored.sha256, type: "image" },
			]),
			platformMessageId: "scoped-image-message",
			senderDisplayName: "Synthetic speaker",
			senderExternalId: "10005",
		});
		const sameChat = await invokeTool(
			harness.lifecycle,
			"onebot-napcat.viewImage",
			{ mediaId: stored.id },
			current.durableConversationId,
		);
		expect(sameChat.ok).toBe(true);
		await expect(
			invokeTool(
				harness.lifecycle,
				"onebot-napcat.viewImage",
				{ mediaId: stored.id },
				other.durableConversationId,
			),
		).rejects.toThrow("not referenced by a message in this conversation");
		await expect(
			invokeTool(
				harness.lifecycle,
				"onebot-napcat.viewImage",
				{ url: "https://example.invalid/unreferenced.png" },
				current.durableConversationId,
			),
		).rejects.toThrow("not referenced by a message in this conversation");

		const bigBytes = Buffer.alloc(5 * 1024 * 1024 + 1, 0x89);
		const big = await harness.lifecycle.media.store({
			bytes: bigBytes,
			kind: "image",
			mimeType: "image/png",
			source: "webui",
		});
		await database.insert(messages).values({
			contentText: "[image]",
			conversationId: current.sessionId,
			direction: "inbound",
			id: randomUUID(),
			kind: "onebot-v11",
			occurredAt: new Date().toISOString(),
			partsJson: JSON.stringify([
				{ mediaId: big.id, mimeType: big.mimeType, sha256: big.sha256, type: "image" },
			]),
			platformMessageId: "oversized-image-message",
			senderDisplayName: "Synthetic speaker",
			senderExternalId: "10005",
		});
		await expect(
			invokeTool(
				harness.lifecycle,
				"onebot-napcat.viewImage",
				{ mediaId: big.id },
				current.durableConversationId,
			),
		).rejects.toThrow("size cap");
	});
});
