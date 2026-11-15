import { describe, expect, test } from "bun:test";
import {
	adminEventSchema,
	activityAggregationPolicySchema,
	conversationPolicyFromActivityAggregation,
	conversationCompactionPresets,
	conversationPolicyPatchSchema,
	conversationPolicySchema,
	defaultActivityAggregationPolicy,
	defaultConversationPolicy,
} from "./index.ts";

describe("contracts", () => {
	test("widened activity aggregation policy maps legacy fields", () => {
		expect(activityAggregationPolicySchema.parse(defaultActivityAggregationPolicy)).toEqual({
			maxMessages: 20,
			windowMs: 6_000,
		});
		expect(activityAggregationPolicySchema.parse({ maxMessages: 1, windowMs: 2_000 })).toEqual({
			maxMessages: 1,
			windowMs: 2_000,
		});
		const mapped = conversationPolicyFromActivityAggregation({
			maxMessages: 7,
			windowMs: 1_250,
		});
		expect(mapped.pacing.burstMaxMessages).toBe(7);
		expect(mapped.pacing.burstSettleMs).toBe(1_250);
		expect(mapped.pacing.burstMaxWaitMs).toBe(15_000);
	});

	test("validates the full versioned conversation policy and defaults", () => {
		expect(conversationPolicySchema.parse({})).toEqual(defaultConversationPolicy);
		expect(defaultConversationPolicy.version).toBe(1);
		expect(defaultConversationPolicy.trigger.privateAccess).toBe("open");
		expect(defaultConversationPolicy.pacing.burstMaxMessages).toBe(20);
		expect(defaultConversationPolicy.pacing.stripMarkdown).toBe(true);
		expect(defaultConversationPolicy.compaction.reserveTokens).toBe(16_384);
		expect(defaultConversationPolicy.compaction.keepRecentTokens).toBe(20_000);
		expect(defaultConversationPolicy.compaction.backgroundTokens).toBe(32_768);
		expect(defaultConversationPolicy.compaction.triggerTokens).toBe(0);
		expect(() => conversationPolicySchema.parse({ steerWhenBusy: "later" })).toThrow();
		expect(() =>
			conversationPolicySchema.parse({ trigger: { privateAccess: "friends" } }),
		).toThrow();
		expect(() => conversationPolicySchema.parse({ compaction: { reserveTokens: -1 } })).toThrow();
	});

	test("compaction presets move from late to early and keep the balanced defaults", () => {
		const { aggressive, balanced, conservative } = conversationCompactionPresets;
		expect(conservative.reserveTokens).toBeLessThan(balanced.reserveTokens);
		expect(balanced.reserveTokens).toBeLessThan(aggressive.reserveTokens);
		expect(conservative.keepRecentTokens).toBeGreaterThan(balanced.keepRecentTokens);
		expect(balanced.keepRecentTokens).toBeGreaterThan(aggressive.keepRecentTokens);
		expect(defaultConversationPolicy.compaction).toMatchObject(balanced);
		expect(conservative.triggerTokens).toBe(0);
		expect(aggressive.triggerTokens).toBe(0);
	});

	test("rejects unknown keys in full and patch documents instead of dropping them", () => {
		expect(() => conversationPolicySchema.parse({ unexpected: true })).toThrow();
		expect(() => conversationPolicyPatchSchema.parse({ pacing: { unknownSetting: 1 } })).toThrow();
		expect(() => conversationPolicySchema.parse({ trigger: { unknownTrigger: true } })).toThrow();
		expect(() =>
			conversationPolicyPatchSchema.parse({ compaction: { unknownSetting: 1 } }),
		).toThrow();
	});

	test("validates admin events", () => {
		expect(
			adminEventSchema.parse({
				conversationId: "conversation-1",
				messageId: "message-1",
				type: "message.appended",
			}),
		).toEqual({
			conversationId: "conversation-1",
			messageId: "message-1",
			type: "message.appended",
		});
		expect(() => adminEventSchema.parse({ type: "message.appended" })).toThrow();
	});
});
