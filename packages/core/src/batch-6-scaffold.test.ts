import { describe, expect, test } from "bun:test";
import { conversationPolicySchema, defaultConversationPolicy } from "@tsukaima/contracts";
import {
	FailOpenConversationGate,
	GateCircuitBreaker,
	composeInterjectPrompt,
	detectOverusedPhrases,
	detectRigidRhythm,
	isIdentityProbe,
	isTrailingFollowUp,
	sanitizeOutboundMetaLeaks,
	shapedReplyDelayMs,
	shouldInterject,
} from "./index.ts";

const policy = conversationPolicySchema.parse(defaultConversationPolicy);

describe("Batch 6 scaffold", () => {
	test("conversation policy defaults expose social, humanization, gate, and interject controls", () => {
		expect(policy.social.enabled).toBe(true);
		expect(policy.social.refusalCooldownHours).toBe(48);
		expect(policy.social.unansweredSilenceHours).toBe(24);
		expect(policy.social.maxSelfMessageRatio).toBe(0.4);
		expect(policy.humanization.antiRepetitionEnabled).toBe(true);
		expect(policy.humanization.metaLeakSanitizeEnabled).toBe(true);
		expect(policy.humanization.delayCurveEnabled).toBe(false);
		expect(policy.gate.enabled).toBe(false);
		expect(policy.gate.circuitBreakerThreshold).toBe(3);
		expect(policy.sidechat.interjectEnabled).toBe(false);
	});

	test("humanize guards detect overused phrases, rigid rhythm, meta leaks, and bound delay curves", () => {
		const overused = detectOverusedPhrases([
			"说实话，今天天气不错",
			"说实话，我也觉得挺好",
			"说实话，晚点再看吧",
		]);
		expect(overused.phrases.some((entry) => entry.phrase === "说实话")).toBe(true);
		expect(overused.avoidListText).toContain("说实话");

		const rhythm = detectRigidRhythm(["a\nb", "c\nd", "e\nf", "g\nh"], { window: 4 });
		expect(rhythm.rigid).toBe(true);
		expect(rhythm.pattern).toEqual([2, 2, 2, 2]);
		expect(rhythm.nudgeText).toBeDefined();

		const sanitized = sanitizeOutboundMetaLeaks(
			"<turn-context>Local time: 12:00</turn-context>\nHello {{persona}} world __SKIP__",
		);
		expect(sanitized.modified).toBe(true);
		expect(sanitized.text).toBe("Hello world");
		expect(sanitized.stripped).toContain("turn-context-block");
		expect(sanitized.stripped).toContain("internal-template-token");
		expect(sanitized.stripped).toContain("proactive-control-token");

		const delayDisabled = shapedReplyDelayMs({
			delayCurveEnabled: true,
			nowMs: Date.UTC(2026, 0, 1, 2, 0),
			pacing: { ...policy.pacing, replyDelayEnabled: false, replyDelayMaxMs: 2_000 },
			random: () => 0.5,
			textLength: 100,
		});
		expect(delayDisabled).toBe(0);

		const delayBounded = shapedReplyDelayMs({
			delayCurveEnabled: true,
			nowMs: Date.UTC(2026, 0, 1, 2, 0),
			pacing: { ...policy.pacing, replyDelayEnabled: true, replyDelayMaxMs: 1_500 },
			random: () => 1,
			textLength: 500,
			timeZone: "UTC",
		});
		expect(delayBounded).toBeGreaterThan(0);
		expect(delayBounded).toBeLessThanOrEqual(1_500);
	});

	test("gate circuit breaker trips after consecutive failures and fails open until recovery", async () => {
		let nowMs = 1_000;
		const breaker = new GateCircuitBreaker({
			cooldownMs: 30_000,
			failureThreshold: 3,
			now: () => nowMs,
		});
		let driverCalls = 0;
		let shouldFail = true;
		const gate = new FailOpenConversationGate({
			breaker,
			now: () => nowMs,
			driver: {
				decideBurstCompletion: async () => ({ decision: "SEND" }),
				decideProactiveBubble: async () => ({ decision: "SHOULD" }),
				decideUndirectedGroupReply: async () => {
					driverCalls += 1;
					if (shouldFail) throw new Error("upstream down");
					return { decision: "SKIP", reason: "chatter" };
				},
			},
		});
		const enabledGate = { ...policy.gate, enabled: true };
		for (let i = 0; i < 3; i += 1) {
			const res = await gate.decideUndirectedGroupReply({
				conversationId: "conv-1",
				messageText: "random chatter",
				policy: enabledGate,
				senderName: "Alice",
			});
			expect(res.decision).toBe("REPLY");
			expect(res.source).toBe("fallback");
		}
		expect(gate.health().state).toBe("open");

		// While open, driver is not called and decision fails open.
		const blocked = await gate.decideUndirectedGroupReply({
			conversationId: "conv-1",
			messageText: "more chatter",
			policy: enabledGate,
			senderName: "Alice",
		});
		expect(driverCalls).toBe(3);
		expect(blocked.decision).toBe("REPLY");
		expect(blocked.reason).toBe("circuit_open");

		// After cooldown, half-open probe succeeds and closes the circuit.
		nowMs += 30_000;
		shouldFail = false;
		const recovered = await gate.decideUndirectedGroupReply({
			conversationId: "conv-1",
			messageText: "still chatter",
			policy: enabledGate,
			senderName: "Alice",
		});
		expect(recovered.decision).toBe("SKIP");
		expect(recovered.source).toBe("gate");
		expect(gate.health().state).toBe("closed");
	});

	test("fast-lane interject rejects identity probes and trailing follow-ups, accepts urgent direct asks", () => {
		const interjectPolicy = {
			sidechat: { ...policy.sidechat, interjectEnabled: true },
		};
		expect(isIdentityProbe("你是谁？")).toBe(true);
		expect(isTrailingFollowUp("对了还有一件事")).toBe(true);

		expect(
			shouldInterject({
				classification: "direct",
				policy: interjectPolicy,
				runAgeMs: 5_000,
				text: "你是谁？",
			}),
		).toEqual({ interject: false, reason: "identity-probe" });

		expect(
			shouldInterject({
				classification: "direct",
				policy: interjectPolicy,
				runAgeMs: 5_000,
				text: "对了，帮我也看一下日志",
			}),
		).toEqual({ interject: false, reason: "trailing-followup" });

		expect(
			shouldInterject({
				classification: "direct",
				policy: interjectPolicy,
				runAgeMs: 5_000,
				text: "在吗？急事问一下",
			}).interject,
		).toBe(true);

		const prompt = composeInterjectPrompt({
			messageText: "在吗？急事问一下",
			personaAnchor: "You are Iris (cheerful helper).",
			recentLines: ["user: check the build"],
			relationLevel: "L2",
			runningTaskSummary: "long report generation",
			senderName: "Bob",
		});
		expect(prompt.system).toContain("Iris");
		expect(prompt.system).toContain("L2");
		expect(prompt.user).toContain("Bob");
	});
});
