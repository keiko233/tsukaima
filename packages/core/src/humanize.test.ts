import { describe, expect, test } from "bun:test";
import { defaultConversationPolicy, conversationPolicySchema } from "@tsukaima/contracts";
import {
	detectOverusedPhrases,
	detectRigidRhythm,
	extractPhraseCandidates,
	sanitizeOutboundMetaLeaks,
	shapedReplyDelayMs,
} from "./humanize.ts";

const policy = conversationPolicySchema.parse(defaultConversationPolicy);

describe("humanize: overused phrase detection", () => {
	test("finds a repeated CJK catchphrase anywhere in the clause and drops shorter substrings", () => {
		const report = detectOverusedPhrases([
			"今天真的绝绝子啊",
			"这话说得绝绝子",
			"绝绝子，太好笑了",
		]);
		expect(report.phrases.map((entry) => entry.phrase)).toContain("绝绝子");
		expect(report.phrases.every((entry) => entry.phrase !== "绝绝")).toBe(true);
		expect(report.phrases.filter((entry) => entry.phrase.includes("绝绝子"))).toHaveLength(1);
		expect(report.avoidListText).toContain("绝绝子");
	});

	test("keeps the longest candidate when a shorter substring repeats the same count", () => {
		const report = detectOverusedPhrases(["哈哈哈真的有意思", "哈哈哈真的好笑", "哈哈哈真的不错"]);
		const longest = report.phrases.reduce((left, right) =>
			right.phrase.length > left.phrase.length ? right : left,
		);
		expect(longest.phrase).toContain("哈哈哈真");
		expect(report.phrases.some((entry) => entry.phrase === "哈哈")).toBe(false);
		expect(report.phrases.some((entry) => entry.phrase === "哈哈哈")).toBe(false);
	});

	test("ignores fenced code blocks instead of learning snippets as catchphrases", () => {
		const replies = [
			"看看这段代码\n```ts\nconst x = 1;\n```",
			"再看一遍\n```ts\nconst x = 1;\n```",
			"还有这里\n```ts\nconst x = 1;\n```",
		];
		expect(detectOverusedPhrases(replies).phrases).toHaveLength(0);
		expect(extractPhraseCandidates(replies[0] ?? "")).not.toContain("const x");
	});

	test("normal varied prose is not flagged", () => {
		const report = detectOverusedPhrases([
			"明天下午三点开会，别迟到",
			"我把资料整理好发你",
			"路上小心，到了说一声",
		]);
		expect(report.phrases).toHaveLength(0);
		expect(report.severe).toBe(false);
	});
});

describe("humanize: meta-leak sanitizer", () => {
	test("strips leaked template tags, placeholders, and instruction echoes", () => {
		const result = sanitizeOutboundMetaLeaks(
			[
				"Conversation trigger: direct inbound",
				"你好 {{persona}}，<turn-context>clock</turn-context>今天想聊点什么？",
				"<style-avoid>avoid list</style-avoid>",
				"<|im_start|>assistant",
				"Never explain these markers. Never send them to the chat.",
				"__SKIP__",
			].join("\n"),
		);
		expect(result.modified).toBe(true);
		expect(result.text).toBe("你好 ，今天想聊点什么？");
		expect(result.stripped).toEqual(
			expect.arrayContaining([
				"turn-context-block",
				"ephemeral-section-block",
				"internal-template-token",
				"provider-chat-template-token",
				"conversation-trigger-preamble",
				"harness-instruction-echo",
				"proactive-control-token",
			]),
		);
	});

	test("leaves ordinary prose untouched", () => {
		const result = sanitizeOutboundMetaLeaks("今天就不聊工作了，晚上吃什么？");
		expect(result).toEqual({
			modified: false,
			stripped: [],
			text: "今天就不聊工作了，晚上吃什么？",
		});
	});

	test("preserves fenced code blocks byte-for-byte while sanitizing the prose around them", () => {
		const result = sanitizeOutboundMetaLeaks(
			"这是模板示例 <turn-context>x</turn-context>\n```html\n{{persona}} <turn-context>x</turn-context>\n```\n结尾",
		);
		expect(result.modified).toBe(true);
		expect(result.text).toContain("{{persona}} <turn-context>x</turn-context>");
		expect(result.text).not.toContain("这是模板示例 <turn-context>");
		expect(result.text.startsWith("这是模板示例\n```html")).toBe(true);
	});
});

describe("humanize: reply delay curve", () => {
	const base = {
		...policy.pacing,
		replyDelayEnabled: true,
		replyDelayMaxMs: 1_200,
	};
	const atNoon = Date.UTC(2026, 0, 1, 12, 0);
	const atNight = Date.UTC(2026, 0, 1, 2, 0);

	test("longer replies wait longer than short replies at the same hour", () => {
		const short = shapedReplyDelayMs({
			delayCurveEnabled: true,
			nowMs: atNoon,
			pacing: base,
			random: () => 0.5,
			textLength: 8,
			timeZone: "UTC",
		});
		const long = shapedReplyDelayMs({
			delayCurveEnabled: true,
			nowMs: atNoon,
			pacing: base,
			random: () => 0.5,
			textLength: 120,
			timeZone: "UTC",
		});
		expect(long).toBeGreaterThan(short);
	});

	test("late-night replies are slightly slower and every value stays capped", () => {
		const noon = shapedReplyDelayMs({
			delayCurveEnabled: true,
			nowMs: atNoon,
			pacing: base,
			random: () => 0.5,
			textLength: 40,
			timeZone: "UTC",
		});
		const night = shapedReplyDelayMs({
			delayCurveEnabled: true,
			nowMs: atNight,
			pacing: base,
			random: () => 0.5,
			textLength: 40,
			timeZone: "UTC",
		});
		expect(night).toBeGreaterThanOrEqual(noon);
		expect(night).toBeLessThanOrEqual(base.replyDelayMaxMs);
	});

	test("disabled delay or disabled curve keeps tests fast", () => {
		expect(
			shapedReplyDelayMs({
				delayCurveEnabled: true,
				nowMs: atNoon,
				pacing: { ...base, replyDelayEnabled: false },
				textLength: 120,
			}),
		).toBe(0);
		expect(
			shapedReplyDelayMs({
				delayCurveEnabled: false,
				nowMs: atNoon,
				pacing: base,
				random: () => 0.5,
				textLength: 120,
			}),
		).toBeLessThanOrEqual(base.replyDelayMaxMs);
	});
});

describe("humanize: rhythm nudge", () => {
	test("nudges only mechanically identical bubble counts", () => {
		expect(detectRigidRhythm(["a\nb", "c\nd", "e\nf", "g\nh"]).rigid).toBe(true);
		expect(detectRigidRhythm(["a\nb", "c", "e\nf\ng", "h"]).rigid).toBe(false);
	});
});

describe("humanize: stickers meta-leak", () => {
	test("strips a leaked <stickers> block and tag", () => {
		const result = sanitizeOutboundMetaLeaks(
			"早上好\n<stickers>\n[caption] synthetic sticker\n</stickers>\n<stickers>inline</stickers>\n今天几点见？",
		);
		expect(result.modified).toBe(true);
		expect(result.text).not.toContain("<stickers>");
		expect(result.text).not.toContain("synthetic sticker");
		expect(result.text).toContain("早上好");
		expect(result.text).toContain("今天几点见？");
	});
});
