import { describe, expect, test } from "bun:test";
import {
	adminEventSchema,
	activityAggregationPolicySchema,
	conversationPolicySchema,
	defaultActivityAggregationPolicy,
	defaultConversationPolicy,
} from "./index.ts";

describe("contracts", () => {
	test("validates activity aggregation policy", () => {
		expect(activityAggregationPolicySchema.parse(defaultActivityAggregationPolicy)).toEqual({
			maxMessages: 20,
			windowMs: 6_000,
		});
		expect(() => activityAggregationPolicySchema.parse({ maxMessages: 1, windowMs: 2_000 })).toThrow();
	});

	test("validates conversation policy", () => {
		expect(conversationPolicySchema.parse({})).toEqual(defaultConversationPolicy);
		expect(() => conversationPolicySchema.parse({ steerWhenBusy: "later" })).toThrow();
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
