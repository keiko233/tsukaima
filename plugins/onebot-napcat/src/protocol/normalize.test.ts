import { describe, expect, test } from "bun:test";
import { messageEnvelopeSchema } from "@tsukaima/contracts";
import { OneBotIntervalRateLimiter } from "./rate-limit.ts";
import {
	normalizeOneBotEvent,
	normalizeOneBotEventAsync,
	normalizeOneBotNotice,
} from "./normalize.ts";
import type { OneBotEvent, OneBotSegment } from "./types.ts";

const config = { botAccountId: "99", channelId: "onebot-test" };

const message = (segments: OneBotSegment[], overrides: Partial<OneBotEvent> = {}): OneBotEvent => ({
	message: segments,
	message_id: "message-1",
	message_type: "private",
	post_type: "message",
	self_id: 99,
	sender: { card: "Test User", user_id: 10_001 },
	time: 100,
	user_id: 10_001,
	...overrides,
});

const groupMessage = (segments: OneBotSegment[]): OneBotEvent =>
	message(segments, {
		group_id: 555,
		message_id: "group-message-1",
		message_type: "group",
		sender: { card: "Test User", role: "admin", user_id: 10_001 },
	});

describe("OneBot notice normalization", () => {
	test("maps poke at the bot and preserves self-target attribution", () => {
		const notice = normalizeOneBotNotice(
			{
				group_id: 555,
				notice_type: "notify",
				post_type: "notice",
				self_id: 99,
				sub_type: "poke",
				time: 50,
				target_id: 99,
				user_id: 10_001,
			},
			config,
		);
		expect(notice).toMatchObject({
			actorId: "10001",
			channelId: "onebot-test",
			conversationKey: { groupId: "555", kind: "group", peerId: "10001" },
			isSelfTarget: true,
			noticeType: "poke",
			occurredAtMs: 50_000,
			targetUserId: "99",
		});
	});

	test("maps revoke, reaction, mute, group file, title, typing, and member changes", () => {
		const cases: Array<[Partial<OneBotEvent>, string]> = [
			[{ notice_type: "group_recall" }, "revoke"],
			[{ notice_type: "friend_recall" }, "revoke"],
			[{ notice_type: "group_msg_emoji_like" }, "reaction"],
			[{ notice_type: "group_ban", sub_type: "ban" }, "mute"],
			[{ notice_type: "group_upload", file: { id: "f1", name: "a.txt" } }, "group-file"],
			[{ notice_type: "notify", sub_type: "title" }, "title"],
			[{ notice_type: "notify", sub_type: "input_status" }, "typing"],
			[{ notice_type: "group_increase" }, "member-change"],
			[{ notice_type: "group_admin", sub_type: "set" }, "member-change"],
		];
		for (const [overrides, expected] of cases) {
			const notice = normalizeOneBotNotice(
				{
					group_id: 555,
					post_type: "notice",
					self_id: 99,
					time: 60,
					user_id: 10_001,
					...overrides,
				},
				config,
			);
			expect(notice?.noticeType).toBe(expected as never);
		}
	});

	test("ignores non-notice events", () => {
		expect(normalizeOneBotNotice(message([{ data: { text: "x" }, type: "text" }]), config)).toBe(
			undefined,
		);
	});
});

describe("OneBot inbound segment fidelity", () => {
	test("normalizes media classes, faces, files, cards, and unknown segments without dropping", () => {
		const envelope = normalizeOneBotEvent(
			message([
				{ data: { text: "look" }, type: "text" },
				{ data: { file_id: "image-id", url: "https://cdn.test/a.png" }, type: "image" },
				{ data: { id: "14" }, type: "face" },
				{
					data: { name: "notes.txt", path: "/tmp/notes.txt", size: 12 },
					type: "file",
				},
				{
					data: {
						data: JSON.stringify({ prompt: "hello https://secret.test 123456789", title: "T" }),
					},
					type: "json",
				},
				{ data: { x: 1, y: "safe" }, type: "rps" },
			]),
			config,
		);
		expect(envelope?.parts).toHaveLength(6);
		expect(envelope?.parts[1]).toMatchObject({
			channelRef: "image-id",
			sourceUrl: "https://cdn.test/a.png",
			type: "image",
		});
		expect(envelope?.parts[2]).toMatchObject({ channelRef: "face:14", type: "sticker" });
		expect(envelope?.parts[3]).toMatchObject({ channelRef: "/tmp/notes.txt", type: "file" });
		expect(envelope?.parts[4]).toMatchObject({ nativeType: "json-card", type: "channel-native" });
		const card = envelope?.parts[4];
		expect(card?.type === "channel-native" ? card.summary : "").not.toContain("https://");
		expect(envelope?.parts[5]).toMatchObject({ nativeType: "rps", type: "channel-native" });
	});

	test("classifies QQ sticker images as stickers, not photos", () => {
		const cases: OneBotSegment[] = [
			{ data: { file: "a.gif", sub_type: 1, summary: "[动画表情]" }, type: "image" },
			{ data: { emoji_id: "e1", emoji_package_id: "1", file: "b.gif" }, type: "image" },
			{ data: { file: "c.webp", summary: "sticker" }, type: "image" },
		];
		for (const segment of cases) {
			const envelope = normalizeOneBotEvent(message([segment]), config);
			expect(envelope?.parts[0]?.type).toBe("sticker");
		}
	});

	test("keeps ordinary photos as images", () => {
		const envelope = normalizeOneBotEvent(
			message([{ data: { file: "photo.jpg", sub_type: 0 }, type: "image" }]),
			config,
		);
		expect(envelope?.parts[0]?.type).toBe("image");
	});

	test("does not resolve unsafe file path schemes", () => {
		const envelope = normalizeOneBotEvent(
			message([{ data: { file: "file:///tmp/../secret", name: "secret" }, type: "file" }]),
			config,
		);
		const part = envelope?.parts[0];
		expect(part?.type).toBe("file");
		if (part?.type === "file") {
			expect(part.channelRef).not.toContain("..");
			expect(part.fileName).toBe("secret");
		}
	});

	test("falls back to nickname when NapCat sends an empty card", () => {
		// NapCat sends `card: ""` for friends without a remark, and `card: null` for some
		// accounts. An empty display name fails the envelope contract, which used to drop the
		// whole message before ingestion.
		const cases: Array<[NonNullable<OneBotEvent["sender"]>, string]> = [
			[{ card: "", nickname: "TestNickname", user_id: 10_001 }, "TestNickname"],
			[{ card: "   ", nickname: "TestNickname", user_id: 10_001 }, "TestNickname"],
			[{ nickname: "TestNickname", user_id: 10_001 }, "TestNickname"],
			[{ card: "Test User", nickname: "TestNickname", user_id: 10_001 }, "Test User"],
			[{ card: "", user_id: 10_001 }, "10001"],
		];
		for (const [sender, expected] of cases) {
			const envelope = normalizeOneBotEvent(
				message([{ data: { text: "test" }, type: "text" }], { sender }),
				config,
			);
			expect(envelope?.sender.displayName).toBe(expected);
			expect(messageEnvelopeSchema.safeParse(envelope).success).toBe(true);
		}
	});

	test("fixes @all mentions", () => {
		const envelope = normalizeOneBotEvent(
			message([
				{ data: { qq: "all" }, type: "at" },
				{ data: { text: " everyone" }, type: "text" },
			]),
			config,
		);
		expect(envelope?.mentions).toEqual([{ all: true }]);
	});

	test("expands forward bundles with bounds and falls back on timeout", async () => {
		const inline = normalizeOneBotEvent(
			message([
				{
					data: {
						content: [
							{ content: [{ data: { text: "one" }, type: "text" }], sender: { nickname: "A" } },
							{ content: [{ data: { text: "two" }, type: "text" }], sender: { nickname: "B" } },
						],
					},
					type: "forward",
				},
			]),
			config,
		);
		expect(inline?.parts[0]).toMatchObject({ nativeType: "forward", type: "channel-native" });
		const inlinePart = inline?.parts[0];
		expect(inlinePart?.type === "channel-native" ? inlinePart.summary : "").toContain("A: one");

		const expanded = await normalizeOneBotEventAsync(
			message([{ data: { id: "forward-1" }, type: "forward" }]),
			config,
			{
				fetchForward: async () => ({
					messages: [
						{
							content: [{ data: { text: "remote" }, type: "text" }],
							sender: { card: "Remote" },
						},
						{
							content: [{ data: { text: "x".repeat(500) }, type: "text" }],
							sender: { nickname: "Long" },
						},
					],
				}),
				forwardMaxChars: 40,
				forwardMaxNodes: 5,
			},
		);
		const expandedPart = expanded?.parts[0];
		expect(expandedPart?.type === "channel-native" ? expandedPart.summary : "").toContain(
			"Remote: remote",
		);

		const timedOut = await normalizeOneBotEventAsync(
			message([{ data: { id: "forward-2" }, type: "forward" }]),
			config,
			{
				fetchForward: () => new Promise(() => {}),
				forwardTimeoutMs: 100,
			},
		);
		expect(timedOut?.parts[0]?.type).toBe("channel-native");
	});
});

describe("OneBot audio and video enrichment", () => {
	test("stores transcript on success and falls back on failure or timeout", async () => {
		const success = await normalizeOneBotEventAsync(
			message([{ data: { duration: 2, file_id: "voice-1" }, type: "record" }]),
			config,
			{ audioTranscribe: async () => "hello voice" },
		);
		expect(success?.parts[0]).toMatchObject({
			channelRef: "voice-1",
			transcript: "hello voice",
			transcriptStatus: "ok",
			type: "audio",
		});

		const failed = await normalizeOneBotEventAsync(
			message([{ data: { file_id: "voice-2" }, type: "record" }]),
			config,
			{
				audioTranscribe: async () => {
					throw new Error("stt offline");
				},
			},
		);
		expect(failed?.parts[0]).toMatchObject({ transcriptStatus: "failed", type: "audio" });

		const timedOut = await normalizeOneBotEventAsync(
			message([{ data: { file_id: "voice-3" }, type: "record" }]),
			config,
			{ audioTranscribe: () => new Promise(() => {}), audioTranscribeTimeoutMs: 100 },
		);
		expect(timedOut?.parts[0]).toMatchObject({ transcriptStatus: "failed", type: "audio" });
	});

	test("rate limits transcription per chat and globally", async () => {
		const limiter = new OneBotIntervalRateLimiter(1_000);
		let calls = 0;
		const options = {
			audioRateLimiter: limiter,
			audioTranscribe: async () => {
				calls += 1;
				return "text";
			},
			now: () => 1_000,
		};
		const first = await normalizeOneBotEventAsync(
			message([{ data: { file_id: "voice-a" }, type: "record" }]),
			config,
			options,
		);
		const second = await normalizeOneBotEventAsync(
			groupMessage([{ data: { file_id: "voice-b" }, type: "record" }]),
			config,
			options,
		);
		expect(calls).toBe(1);
		expect(first?.parts[0]).toMatchObject({ transcriptStatus: "ok" });
		expect(second?.parts[0]).toMatchObject({ transcriptStatus: "fallback" });
	});

	test("attaches bounded representative video frames", async () => {
		const envelope = await normalizeOneBotEventAsync(
			message([{ data: { file_id: "video-1", duration: 12 }, type: "video" }]),
			config,
			{
				extractVideoFrames: () => [
					{ offsetMs: 0, sha256: "a".repeat(64) },
					{ offsetMs: 1_000, sha256: "b".repeat(64) },
					{ offsetMs: 2_000, sha256: "c".repeat(64) },
					{ offsetMs: 3_000, sha256: "d".repeat(64) },
					{ offsetMs: 4_000, sha256: "e".repeat(64) },
				],
			},
		);
		expect(envelope?.parts[0]).toMatchObject({
			channelRef: "video-1",
			durationMs: 12,
			type: "video",
		});
		const part = envelope?.parts[0];
		expect(part?.type === "video" ? part.frames?.length : 0).toBe(4);
	});
});
