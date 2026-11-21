import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { conversationPolicySchema, defaultConversationPolicy } from "@tsukaima/contracts";
import { directFlushDecision } from "./output-pacing.ts";
import { narrationCandidate, samplingOverrides } from "./run-hooks.ts";
import { extractLurkMarker, LURK_MARKER } from "./trigger.ts";

// These pin the pure helpers; end-to-end cases live in `batch-2-acceptance.test.ts`.

const policy = conversationPolicySchema.parse(defaultConversationPolicy);

const assistant = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	api: "openai-compatible",
	content,
	model: "fake",
	provider: "fake",
	role: "assistant",
	stopReason,
	timestamp: 0,
	usage: {
		cacheRead: 0,
		cacheWrite: 0,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
		input: 0,
		output: 0,
		totalTokens: 0,
	},
});

describe("batch 2 pacing defaults", () => {
	test("schema defaults remove the 8 second settle floor", () => {
		expect(policy.pacing.burstSettleMs).toBe(1_200);
		expect(policy.pacing.burstMaxWaitMs).toBe(5_000);
		expect(policy.pacing.burstLongMessageThreshold).toBe(32);
		expect(policy.trigger.recentActivityEscalation).toBe("throttled");
		expect(policy.notices.pokeWake).toBe(false);
	});
});

describe("extractLurkMarker", () => {
	test("a standalone marker lurks", () => {
		expect(extractLurkMarker(`  ${LURK_MARKER}. `).lurk).toBe(true);
		expect(extractLurkMarker(`「${LURK_MARKER}」`).lurk).toBe(true);
	});

	test("a marker inside prose does not wipe the reply", () => {
		const decision = extractLurkMarker(`The token ${LURK_MARKER} is internal, sorry!`);
		expect(decision.lurk).toBe(false);
		expect(decision.text).toBe("The token is internal, sorry!");
		expect(extractLurkMarker(`ok\n${LURK_MARKER}`)).toEqual({ lurk: false, text: "ok" });
	});
});

describe("directFlushDecision", () => {
	const pacing = policy.pacing;

	test("a complete direct question flushes at once", () => {
		expect(
			directFlushDecision({
				classification: "direct",
				pacing,
				previousMessageAtMs: undefined,
				submittedAtMs: 1_000,
				text: "are you there?",
			}),
		).toEqual({ flush: true, reason: "terminal-punctuation" });
	});

	test("an active burst keeps merging", () => {
		expect(
			directFlushDecision({
				classification: "direct",
				pacing,
				previousMessageAtMs: 500,
				submittedAtMs: 1_000,
				text: "and one more thing.",
			}).flush,
		).toBe(false);
	});

	test("a trailing emoji or CJK closing particle reads as complete", () => {
		for (const text of ["sounds good 😊", "你在吗", "就这样呢"]) {
			expect(
				directFlushDecision({
					classification: "direct",
					pacing,
					previousMessageAtMs: undefined,
					submittedAtMs: 1_000,
					text,
				}),
			).toEqual({ flush: true, reason: "terminal-punctuation" });
		}
	});

	test("soft messages never shortcut the settle window", () => {
		expect(
			directFlushDecision({
				classification: "soft",
				pacing,
				previousMessageAtMs: undefined,
				submittedAtMs: 1_000,
				text: "a complete sentence.",
			}).flush,
		).toBe(false);
	});
});

describe("narrationCandidate", () => {
	test("narrates text written before a tool call", () => {
		const decision = narrationCandidate({
			message: assistant(
				[
					{ text: "Let me check.", type: "text" },
					{ arguments: {}, id: "call-1", name: "web_search", type: "toolCall" },
				],
				"toolUse",
			),
			policy,
			runKind: "chat",
		});
		expect(decision).toEqual({ narrate: true, text: "Let me check.", toolNames: ["web_search"] });
	});

	test("skips trivial preambles and a later round after a direct send", () => {
		for (const preamble of ["…", "😊", "好"]) {
			const decision = narrationCandidate({
				message: assistant(
					[
						{ text: preamble, type: "text" },
						{ arguments: {}, id: "call-1", name: "web_search", type: "toolCall" },
					],
					"toolUse",
				),
				policy,
				runKind: "chat",
			});
			expect(decision).toMatchObject({ narrate: false, reason: "trivial" });
		}
		expect(
			narrationCandidate({
				message: assistant(
					[
						{ text: "Checking again.", type: "text" },
						{ arguments: {}, id: "call-2", name: "web_search", type: "toolCall" },
					],
					"toolUse",
				),
				directSendEarlier: true,
				policy,
				runKind: "chat",
			}),
		).toMatchObject({ narrate: false, reason: "direct-send-earlier" });
	});

	test("skips direct send tools, background runs, and final answers", () => {
		const message = assistant(
			[
				{ text: "On it.", type: "text" },
				{ arguments: {}, id: "call-1", name: "onebot-napcat.send", type: "toolCall" },
			],
			"toolUse",
		);
		expect(
			narrationCandidate({
				isDirectSendTool: (name) => name.endsWith(".send"),
				message,
				policy,
				runKind: "chat",
			}).narrate,
		).toBe(false);
		expect(narrationCandidate({ message, policy, runKind: "background" }).narrate).toBe(false);
		expect(
			narrationCandidate({
				message: assistant([{ text: "Done.", type: "text" }], "stop"),
				policy,
				runKind: "chat",
			}).narrate,
		).toBe(false);
	});
});

describe("samplingOverrides", () => {
	test("maps policy fields to OpenAI request fields", () => {
		expect(samplingOverrides(policy.generation)).toBeUndefined();
		expect(
			samplingOverrides({ ...policy.generation, stop: ["\n\n"], temperature: 0.7, topP: 0.9 }),
		).toEqual({ stop: ["\n\n"], temperature: 0.7, top_p: 0.9 });
	});
});
