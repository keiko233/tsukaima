import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { conversations, messages } from "@tsukaima/db";
import { createFakeModel, type ModelPort } from "@tsukaima/core";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
import { createLocalChat, sendMessage } from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
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

type RecordedAction = {
	readonly action: string;
	readonly params: Record<string, unknown>;
};

/** OneBot transport double that records actions and answers every action with `retcode: 0`. */
const createOneBotTransportSpy = () => {
	const actions: RecordedAction[] = [];
	const connections: Array<{ emitOpen: () => void }> = [];
	const urls: string[] = [];
	const createTransport: OneBotTransportFactory = (url): OneBotTransport => {
		urls.push(url);
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
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify({ data: { message_id: 9001 }, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return { actions, connections, createTransport, urls };
};

async function createLifecycle(
	options: { model?: ModelPort; onebot?: OneBotTransportFactory } = {},
) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-reply-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			...(options.onebot === undefined ? {} : { TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001" }),
		},
		{
			...(options.model === undefined ? {} : { model: options.model }),
			...(options.onebot === undefined
				? {}
				: {
						pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, options.onebot]]),
					}),
		},
	);
	await lifecycle.start();
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("Domain database is not ready");
	return { database, lifecycle };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(40);
	}
	throw new Error("Timed out waiting for condition");
}

describe("reply dispatcher", () => {
	test(
		"sends a settled private answer to the channel exactly once",
		async () => {
			const onebot = createOneBotTransportSpy();
			const { database, lifecycle } = await createLifecycle({ onebot: onebot.createTransport });
			try {
				onebot.connections[0]?.emitOpen();
				expect(lifecycle.channels.get("onebot")?.diagnostics().connected).toBe(true);
				const replied: unknown[] = [];
				lifecycle.hooks.on("after.reply", (payload) => {
					replied.push(payload);
				});

				await lifecycle.processEnvelope(envelope("message-1", "hi"));
				const answer = await waitFor(async () => {
					const rows = await database
						.select()
						.from(messages)
						.where(
							and(eq(messages.direction, "outbound"), eq(messages.senderExternalId, "tsukaima")),
						);
					return rows.find((row) => row.deliveryStatus === "sent");
				});

				expect(answer.contentText).toBe("ok");
				expect(answer.kind).toBe("onebot-v11");
				expect(answer.platformMessageId).toBe("9001");
				expect(answer.durableEntryId).not.toBeNull();

				const sent = onebot.actions.filter((action) => action.action === "send_private_msg");
				expect(sent).toHaveLength(1);
				expect(sent[0]?.params).toEqual({
					message: [{ data: { text: "ok" }, type: "text" }],
					user_id: "user-1",
				});
				expect(replied).toEqual([
					expect.objectContaining({
						channelId: "onebot",
						deliveryStatus: "sent",
						entryId: answer.durableEntryId,
						text: "ok",
					}),
				]);

				const entryId = answer.durableEntryId;
				if (entryId === null) throw new Error("Answer has no durable entry id");
				const [session] = await database
					.select()
					.from(conversations)
					.where(eq(conversations.id, answer.conversationId))
					.limit(1);
				if (session === undefined) throw new Error("Answer session is missing");
				await lifecycle.replyDispatcher.handleAnswer({
					activityId: "test-activity",
					conversationId: session.durableConversationId,
					entryId,
					text: "ok",
				});

				expect(
					onebot.actions.filter((action) => action.action === "send_private_msg"),
				).toHaveLength(1);
				const replies = await database
					.select()
					.from(messages)
					.where(eq(messages.senderExternalId, "tsukaima"));
				expect(replies).toHaveLength(1);
			} finally {
				await lifecycle.stop();
			}
		},
		// The single private message is answered when the activity window flushes (~6s).
		20_000,
	);

	test("strips outbound meta-leaks with a warn diagnostic while preserving fenced code", async () => {
		const onebot = createOneBotTransportSpy();
		const leaked = [
			"前文 <turn-context>Local time: 12:00</turn-context> 后文",
			"```html",
			"{{persona}} <turn-context>keep this example</turn-context>",
			"```",
		].join("\n");
		const { database, lifecycle } = await createLifecycle({
			model: createFakeModel({ responses: [leaked] }),
			onebot: onebot.createTransport,
		});
		try {
			onebot.connections[0]?.emitOpen();
			await lifecycle.conversationPolicy.update({
				policy: {
					humanization: { metaLeakSanitizeEnabled: true },
					pacing: { replyDelayEnabled: false, sendIntervalMs: 0, stripMarkdown: false },
				},
				scope: "global",
			});
			await lifecycle.processEnvelope(envelope("meta-leak", "show the template?"));
			const answer = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(
						and(eq(messages.direction, "outbound"), eq(messages.senderExternalId, "tsukaima")),
					);
				return rows.find((row) => row.deliveryStatus === "sent");
			});
			expect(answer.contentText).toContain("{{persona}} <turn-context>keep this example");
			expect(answer.contentText).not.toContain("Local time: 12:00");
			expect(
				lifecycle.logs
					.list({ level: "warn" })
					.some((entry) => entry.message === "outbound meta-leak sanitized"),
			).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	}, 20_000);

	test("shapes reply delay by hour and length and shows a typing indicator in a DM", async () => {
		const onebot = createOneBotTransportSpy();
		const { database, lifecycle } = await createLifecycle({
			model: createFakeModel({ responses: ["ok"] }),
			onebot: onebot.createTransport,
		});
		try {
			onebot.actions.splice(0);
			onebot.connections[0]?.emitOpen();
			await lifecycle.conversationPolicy.update({
				policy: {
					humanization: { delayCurveEnabled: true },
					pacing: {
						replyDelayEnabled: true,
						replyDelayMaxMs: 300,
						sendIntervalMs: 0,
						typingEnabled: true,
					},
				},
				scope: "global",
			});
			const startedAt = Date.now();
			await lifecycle.processEnvelope(envelope("typing-delay", "hello?"));
			const answer = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(
						and(eq(messages.direction, "outbound"), eq(messages.senderExternalId, "tsukaima")),
					);
				return rows.find((row) => row.deliveryStatus === "sent");
			});
			const elapsed = Date.now() - startedAt;
			expect(elapsed).toBeGreaterThanOrEqual(40);
			expect(elapsed).toBeLessThan(2_000);
			expect(answer.contentText).toBe("ok");
			const typing = onebot.actions.filter((action) => action.action === "set_input_status");
			expect(typing.map((action) => action.params.event_type)).toEqual(
				expect.arrayContaining([1, 2]),
			);
			expect(typing.every((action) => action.params.user_id === "user-1")).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	}, 20_000);

	test("persists a local WebUI answer without sending it anywhere", async () => {
		const onebot = createOneBotTransportSpy();
		const { database, lifecycle } = await createLifecycle({ onebot: onebot.createTransport });
		try {
			onebot.connections[0]?.emitOpen();
			const chat = await createLocalChat(lifecycle, {
				sessionTitle: "Main",
				title: "Local chat",
			});
			await sendMessage(lifecycle, {
				sessionId: chat.sessionId,
				target: "tsukaima",
				text: "hello tsukaima",
			});
			const reply = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(
						and(
							eq(messages.conversationId, chat.sessionId),
							eq(messages.senderExternalId, "tsukaima"),
						),
					);
				return rows[0];
			});
			expect(reply.contentText).toBe("ok");
			expect(reply.kind).toBe("webui");
			expect(reply.deliveryStatus).toBe("sent");
			expect(onebot.actions).toHaveLength(0);
		} finally {
			await lifecycle.stop();
		}
	});
});
