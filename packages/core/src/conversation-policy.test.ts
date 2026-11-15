import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableStorage } from "@elaina/durable";
import {
	conversationPolicySchema,
	defaultConversationPolicy,
	type MessageEnvelope,
} from "@elaina/contracts";
import {
	ConversationExecutionLock,
	LURK_MARKER,
	PiDurableConversationHost,
	boundedReplyDelayMs,
	busyDisposition,
	classifyConversationTrigger,
	extractLurkMarker,
	prepareOutboundParts,
	prepareOutboundText,
	shouldCloseActivityWindow,
	splitOnNewlines,
	stripMarkdownFormatting,
	withConversationLock,
} from "./index.ts";

const policy = conversationPolicySchema.parse(defaultConversationPolicy);

const envelope = (overrides: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
	channelId: "test",
	channelKind: "onebot-v11",
	conversationKey: { groupId: "group-1", kind: "group", peerId: "user-1" },
	id: "message-1",
	mentions: [],
	parts: [{ text: "hello", type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: "message-1", timestampMs: 1 },
	...overrides,
});

describe("conversation trigger classification", () => {
	test("classifies direct mentions, replies, keywords, and private chat", () => {
		const mention = classifyConversationTrigger({
			botIds: ["bot-1"],
			chatKind: "group",
			envelope: envelope({ mentions: [{ id: "bot-1" }] }),
			policy,
		});
		expect(mention.classification).toBe("direct");
		expect(mention.reason).toBe("bot mention");

		const reply = classifyConversationTrigger({
			chatKind: "group",
			envelope: envelope({ target: { replyToEnvelopeId: "bot-message" } }),
			policy,
			replyTarget: { direction: "outbound", senderKind: "assistant" },
		});
		expect(reply.classification).toBe("direct");
		expect(reply.reason).toBe("reply to bot");

		const keywordPolicy = conversationPolicySchema.parse({
			...policy,
			trigger: { ...policy.trigger, keywords: ["urgent"] },
		});
		expect(
			classifyConversationTrigger({
				chatKind: "group",
				envelope: envelope({ parts: [{ text: "this is urgent", type: "text" }] }),
				policy: keywordPolicy,
			}).classification,
		).toBe("direct");

		expect(
			classifyConversationTrigger({
				chatKind: "private",
				envelope: envelope({ conversationKey: { kind: "private", peerId: "user-1" } }),
				policy,
			}).reason,
		).toBe("private chat");
	});

	test("classifies alias and recent activity as soft, otherwise ambient", () => {
		const aliasPolicy = conversationPolicySchema.parse({
			...policy,
			trigger: { ...policy.trigger, selfAliases: ["Elaina"] },
		});
		const alias = classifyConversationTrigger({
			chatKind: "group",
			envelope: envelope({ parts: [{ text: "Elaina what do you think?", type: "text" }] }),
			policy: aliasPolicy,
		});
		expect(alias.classification).toBe("soft");
		expect(alias.aliasMentioned).toBe(true);

		const recent = classifyConversationTrigger({
			chatKind: "group",
			envelope: envelope({ parts: [{ text: "just chatting", type: "text" }] }),
			policy,
			recentActivity: true,
		});
		expect(recent.classification).toBe("soft");

		const ambient = classifyConversationTrigger({
			chatKind: "group",
			envelope: envelope({ parts: [{ text: "unrelated", type: "text" }] }),
			policy,
		});
		expect(ambient.classification).toBe("ambient");

		const mentionDisabled = conversationPolicySchema.parse({
			...policy,
			trigger: { ...policy.trigger, groupMentionMode: "disabled" },
		});
		expect(
			classifyConversationTrigger({
				botIds: ["bot-1"],
				chatKind: "group",
				envelope: envelope({ mentions: [{ id: "bot-1" }] }),
				policy: mentionDisabled,
			}).classification,
		).toBe("ambient");
	});

	test("maps sticker-only and image-only policy choices", () => {
		const sticker = envelope({
			parts: [{ channelRef: "face:1", type: "sticker" }],
		});
		const image = envelope({ parts: [{ sha256: "image-hash", type: "image" }] });
		for (const [choice, expected] of [
			["wake", "direct"],
			["lurk", "soft"],
			["text-only", "ambient"],
			["ignore", "ignored"],
		] as const) {
			const custom = conversationPolicySchema.parse({
				...policy,
				trigger: { ...policy.trigger, stickerOnly: choice },
			});
			expect(
				classifyConversationTrigger({ chatKind: "group", envelope: sticker, policy: custom })
					.classification,
			).toBe(expected);
			const imageCustom = conversationPolicySchema.parse({
				...policy,
				trigger: { ...policy.trigger, imageOnly: choice },
			});
			expect(
				classifyConversationTrigger({ chatKind: "group", envelope: image, policy: imageCustom })
					.classification,
			).toBe(expected);
		}
	});

	test("drops disabled access, allowlist misses, peer bots, and quiet hours", () => {
		const disabled = conversationPolicySchema.parse({
			...policy,
			trigger: { ...policy.trigger, groupAccess: "disabled" },
		});
		expect(
			classifyConversationTrigger({ chatKind: "group", envelope: envelope(), policy: disabled })
				.classification,
		).toBe("ignored");

		const allowlist = conversationPolicySchema.parse({
			...policy,
			trigger: { ...policy.trigger, allowlist: ["trusted"], groupAccess: "allowlist" },
		});
		expect(
			classifyConversationTrigger({ chatKind: "group", envelope: envelope(), policy: allowlist })
				.classification,
		).toBe("ignored");
		expect(
			classifyConversationTrigger({
				chatKind: "group",
				envelope: envelope({ sender: { displayName: "T", id: "trusted", platformId: "trusted" } }),
				policy: allowlist,
			}).classification,
		).toBe("ambient");

		const peer = conversationPolicySchema.parse({
			...policy,
			trigger: { ...policy.trigger, peerBotIds: ["other-bot"] },
		});
		expect(
			classifyConversationTrigger({
				chatKind: "group",
				envelope: envelope({
					sender: { displayName: "Bot", id: "other-bot", isBot: true, platformId: "other-bot" },
				}),
				policy: peer,
			}).classification,
		).toBe("ignored");

		const quiet = conversationPolicySchema.parse({
			...policy,
			pacing: {
				...policy.pacing,
				quietHours: { enabled: true, endHour: 23, startHour: 0 },
			},
		});
		expect(
			classifyConversationTrigger({
				chatKind: "group",
				envelope: envelope(),
				nowMs: new Date(2026, 0, 1, 12).getTime(),
				policy: quiet,
			}).classification,
		).toBe("ignored");
	});
});

describe("activity window and pacing helpers", () => {
	test("honors settle and max-wait separately", () => {
		const pacing = { burstMaxWaitMs: 15_000, burstSettleMs: 6_000 };
		expect(shouldCloseActivityWindow(0, 7_000, pacing, 0)).toBe(true);
		expect(shouldCloseActivityWindow(0, 7_000, pacing, 6_500)).toBe(false);
		expect(shouldCloseActivityWindow(0, 15_000, pacing, 14_500)).toBe(true);
		expect(shouldCloseActivityWindow(0, 2_000, { maxMessages: 1, windowMs: 1_000 })).toBe(true);
	});

	test("splits newlines while preserving fenced code blocks", () => {
		const units = splitOnNewlines(
			"first line\nsecond line\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nlast",
		);
		expect(units).toEqual([
			"first line",
			"second line",
			"```ts\nconst a = 1;\n\nconst b = 2;\n```",
			"last",
		]);
	});

	test("strips Markdown without mangling links or code", () => {
		const text =
			"# Title\n\n**bold** and *italic* with [docs](https://example.test/a_b)\n- bullet\n```ts\nconst x = **not stripped**;\n```";
		const stripped = stripMarkdownFormatting(text);
		expect(stripped).toContain("Title");
		expect(stripped).toContain("bold and italic");
		expect(stripped).toContain("docs (https://example.test/a_b)");
		expect(stripped).toContain("• bullet");
		expect(stripped).toContain("const x = **not stripped**;");
	});

	test("caps immediate output and folds overflow into the last unit", () => {
		const prepared = prepareOutboundText("one\ntwo\nthree\nfour", {
			...policy.pacing,
			maxImmediateOutputMessages: 3,
			stripMarkdown: false,
		});
		expect(prepared.units).toEqual(["one", "two", "three\nfour"]);
		expect(prepared.overflowCount).toBe(2);
	});

	test("groups text lines and media into ordered delivery batches", () => {
		const sticker = { channelRef: "sticker-1", type: "sticker" as const };
		const prepared = prepareOutboundParts(
			[
				{ text: "first line\nsecond line", type: "text" },
				sticker,
				{ text: "third line", type: "text" },
			],
			{ ...policy.pacing, maxImmediateOutputMessages: 6, stripMarkdown: false },
		);
		expect(prepared.units).toEqual([
			[{ text: "first line", type: "text" }],
			[{ text: "second line", type: "text" }],
			[sticker],
			[{ text: "third line", type: "text" }],
		]);
		expect(prepared.parts).toEqual([
			{ text: "first line\nsecond line", type: "text" },
			sticker,
			{ text: "third line", type: "text" },
		]);
		expect(prepared.text).toBe("first line\nsecond line\nthird line");
	});

	test("folds batch overflow into the final message without losing media", () => {
		const sticker = { channelRef: "sticker-1", type: "sticker" as const };
		const prepared = prepareOutboundParts(
			[
				{ text: "one", type: "text" },
				{ text: "two", type: "text" },
				{ text: "three", type: "text" },
				sticker,
			],
			{ ...policy.pacing, maxImmediateOutputMessages: 3, stripMarkdown: false },
		);
		expect(prepared.units).toEqual([
			[{ text: "one", type: "text" }],
			[{ text: "two", type: "text" }],
			[{ text: "three", type: "text" }, sticker],
		]);
		expect(prepared.overflowCount).toBe(2);
	});

	test("bounds reply delay and busy disposition", () => {
		expect(
			boundedReplyDelayMs(
				{ ...policy.pacing, replyDelayEnabled: true, replyDelayMaxMs: 2_000 },
				() => 0.5,
			),
		).toBe(1_000);
		expect(boundedReplyDelayMs(policy.pacing, () => 1)).toBe(0);
		expect(busyDisposition(1_000, 2_000, 3_000)).toBe("steer");
		expect(busyDisposition(1_000, 5_000, 3_000)).toBe("follow-up");
	});

	test("extracts the lurk marker as a token", () => {
		expect(extractLurkMarker(LURK_MARKER)).toEqual({ lurk: true, text: "" });
		expect(extractLurkMarker(`  ${LURK_MARKER}  `).lurk).toBe(true);
		expect(extractLurkMarker(`I will stay quiet ${LURK_MARKER}`).text).toBe("I will stay quiet");
		expect(extractLurkMarker("normal reply").lurk).toBe(false);
	});
});

describe("ConversationExecutionLock", () => {
	test("serializes one conversation but runs distinct conversations concurrently", async () => {
		const lock = new ConversationExecutionLock();
		const events: string[] = [];
		const first = lock.run("chat-a", async () => {
			events.push("a1-start");
			await Bun.sleep(30);
			events.push("a1-end");
		});
		const second = lock.run("chat-a", async () => {
			events.push("a2-start");
			events.push("a2-end");
		});
		const other = lock.run("chat-b", async () => {
			events.push("b-start");
			events.push("b-end");
		});
		await Promise.all([first, second, other]);
		expect(events.indexOf("a1-end")).toBeLessThan(events.indexOf("a2-start"));
		expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a2-end"));
	});

	test("withConversationLock uses the shared default lock", async () => {
		const events: string[] = [];
		await Promise.all([
			withConversationLock("shared", async () => {
				events.push("one-start");
				await Bun.sleep(10);
				events.push("one-end");
			}),
			withConversationLock("shared", () => {
				events.push("two");
			}),
		]);
		expect(events).toEqual(["one-start", "one-end", "two"]);
	});
});

describe("PiDurableConversationHost policy windows", () => {
	test("submits long messages immediately and honors max-wait", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-core-policy-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const events: string[] = [];
			const host = new PiDurableConversationHost({
				onActivityEvent: (event) => events.push(event.type),
				storage,
			});
			const conversationId = await host.createConversation();
			await host.updatePolicy(
				conversationId,
				conversationPolicySchema.parse({
					...policy,
					pacing: {
						...policy.pacing,
						burstLongMessageThreshold: 10,
						burstMaxMessages: 20,
						burstMaxWaitMs: 50,
						burstSettleMs: 10_000,
					},
				}),
			);
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: {
					...envelope(),
					conversationKey: { kind: "webui" },
					id: "long-1",
					parts: [{ text: "this message is long enough", type: "text" }],
					source: { timestampMs: now },
				},
				submittedAtMs: now,
			});
			expect(events).toContain("closed");

			events.length = 0;
			await host.append({
				conversationId,
				envelope: {
					...envelope(),
					conversationKey: { kind: "webui" },
					id: "short-1",
					parts: [{ text: "short", type: "text" }],
					source: { timestampMs: now + 100 },
				},
				submittedAtMs: now + 100,
			});
			expect(events).not.toContain("closed");
			await host.append({
				conversationId,
				envelope: {
					...envelope(),
					conversationKey: { kind: "webui" },
					id: "short-2",
					parts: [{ text: "next", type: "text" }],
					source: { timestampMs: now + 120 },
				},
				submittedAtMs: now + 200,
			});
			expect(events).toContain("closed");
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
