import { z } from "zod";

/**
 * Legacy activity-window settings stay supported. `windowMs` maps to
 * `pacing.burstSettleMs` and `maxMessages` maps to `pacing.burstMaxMessages`; the former
 * 3–10 second clamp is deliberately gone so tests and deployments can use short windows.
 */
export const activityAggregationPolicySchema = z
	.object({
		maxMessages: z.number().int().min(1),
		windowMs: z.number().int().min(1),
		burstMaxWaitMs: z.number().int().min(1).optional(),
	})
	.strict();

export type ActivityAggregationPolicy = z.infer<typeof activityAggregationPolicySchema>;

export const defaultActivityAggregationPolicy: ActivityAggregationPolicy = {
	maxMessages: 20,
	windowMs: 6_000,
};

export const triggerClassificationSchema = z.enum(["direct", "soft", "ambient"]);
export type TriggerClassification = z.infer<typeof triggerClassificationSchema>;

export const triggerDecisionSchema = z.enum(["direct", "soft", "ambient", "ignored"]);
export type TriggerDecision = z.infer<typeof triggerDecisionSchema>;

export const conversationTriggerPolicySchema = z
	.object({
		privateAccess: z.enum(["open", "allowlist", "disabled"]).default("open"),
		groupAccess: z.enum(["open", "allowlist", "disabled"]).default("open"),
		allowlist: z.array(z.string().min(1)).default([]),
		keywords: z.array(z.string().min(1)).default([]),
		groupMentionMode: z.enum(["always", "smart", "disabled"]).default("always"),
		replyToBotCounts: z.boolean().default(true),
		stickerOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).default("lurk"),
		imageOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).default("lurk"),
		selfAliases: z.array(z.string().min(1)).default([]),
		peerBotIds: z.array(z.string().min(1)).default([]),
	})
	.strict();

export type ConversationTriggerPolicy = z.infer<typeof conversationTriggerPolicySchema>;

export const quietHoursSchema = z
	.object({
		enabled: z.boolean().default(false),
		startHour: z.number().int().min(0).max(23).default(22),
		endHour: z.number().int().min(0).max(23).default(7),
	})
	.strict();

export type QuietHoursPolicy = z.infer<typeof quietHoursSchema>;

export const conversationPacingPolicySchema = z
	.object({
		burstSettleMs: z.number().int().min(1).default(6_000),
		burstMaxWaitMs: z.number().int().min(1).default(15_000),
		burstMaxMessages: z.number().int().min(1).default(20),
		burstLongMessageThreshold: z.number().int().min(1).default(400),
		replyCooldownMs: z.number().int().min(0).default(0),
		typingEnabled: z.boolean().default(false),
		replyDelayEnabled: z.boolean().default(false),
		replyDelayMaxMs: z.number().int().min(0).default(2_000),
		sendIntervalMs: z.number().int().min(0).default(400),
		maxImmediateOutputMessages: z.number().int().min(1).default(6),
		stripMarkdown: z.boolean().default(true),
		quietHours: quietHoursSchema.optional(),
		maxRepliesPerMinute: z.number().int().min(0).default(20),
		allowedTools: z.array(z.string().min(1)).optional(),
	})
	.strict();

export type ConversationPacingPolicy = z.infer<typeof conversationPacingPolicySchema>;

export const conversationPolicySchema = z
	.object({
		version: z.number().int().min(1).default(1),
		enabled: z.boolean().default(true),
		followUpWhenBusy: z.enum(["follow-up", "reject"]).default("follow-up"),
		steerWhenBusy: z.enum(["steer", "follow-up", "reject"]).default("steer"),
		memoryEnabled: z.boolean().default(true),
		sharedMemoryEnabled: z.boolean().default(true),
		sharedMemoryWriteEnabled: z.boolean().default(true),
		memoryReviewRequired: z.boolean().default(false),
		memoryCompactionEnabled: z.boolean().default(true),
		memoryExtractModel: z.string().min(1).optional(),
		memoryExtractionPromptVersion: z.string().min(1).default("memory-extract-v1"),
		memoryMinConfidence: z.number().min(0).max(1).default(0.55),
		memoryMaxWritesPerActivity: z.number().int().min(1).max(50).default(8),
		trigger: conversationTriggerPolicySchema.default({
			allowlist: [],
			groupAccess: "open",
			groupMentionMode: "always",
			imageOnly: "lurk",
			keywords: [],
			peerBotIds: [],
			privateAccess: "open",
			replyToBotCounts: true,
			selfAliases: [],
			stickerOnly: "lurk",
		}),
		pacing: conversationPacingPolicySchema.default({
			burstLongMessageThreshold: 400,
			burstMaxMessages: 20,
			burstMaxWaitMs: 15_000,
			burstSettleMs: 6_000,
			maxImmediateOutputMessages: 6,
			maxRepliesPerMinute: 20,
			replyCooldownMs: 0,
			replyDelayEnabled: false,
			replyDelayMaxMs: 2_000,
			sendIntervalMs: 400,
			stripMarkdown: true,
			typingEnabled: false,
		}),
	})
	.strict();

export type ConversationPolicy = z.infer<typeof conversationPolicySchema>;

export const defaultConversationPolicy: ConversationPolicy = {
	version: 1,
	enabled: true,
	followUpWhenBusy: "follow-up",
	steerWhenBusy: "steer",
	memoryEnabled: true,
	sharedMemoryEnabled: true,
	sharedMemoryWriteEnabled: true,
	memoryReviewRequired: false,
	memoryCompactionEnabled: true,
	memoryExtractionPromptVersion: "memory-extract-v1",
	memoryMinConfidence: 0.55,
	memoryMaxWritesPerActivity: 8,
	trigger: {
		privateAccess: "open",
		groupAccess: "open",
		allowlist: [],
		keywords: [],
		groupMentionMode: "always",
		replyToBotCounts: true,
		stickerOnly: "lurk",
		imageOnly: "lurk",
		selfAliases: [],
		peerBotIds: [],
	},
	pacing: {
		burstSettleMs: 6_000,
		burstMaxWaitMs: 15_000,
		burstMaxMessages: 20,
		burstLongMessageThreshold: 400,
		replyCooldownMs: 0,
		typingEnabled: false,
		replyDelayEnabled: false,
		replyDelayMaxMs: 2_000,
		sendIntervalMs: 400,
		maxImmediateOutputMessages: 6,
		stripMarkdown: true,
		maxRepliesPerMinute: 20,
	},
};

const triggerPolicyPatchSchema = z
	.object({
		privateAccess: z.enum(["open", "allowlist", "disabled"]).optional(),
		groupAccess: z.enum(["open", "allowlist", "disabled"]).optional(),
		allowlist: z.array(z.string().min(1)).optional(),
		keywords: z.array(z.string().min(1)).optional(),
		groupMentionMode: z.enum(["always", "smart", "disabled"]).optional(),
		replyToBotCounts: z.boolean().optional(),
		stickerOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).optional(),
		imageOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).optional(),
		selfAliases: z.array(z.string().min(1)).optional(),
		peerBotIds: z.array(z.string().min(1)).optional(),
	})
	.strict();

const pacingPolicyPatchSchema = z
	.object({
		burstSettleMs: z.number().int().min(1).optional(),
		burstMaxWaitMs: z.number().int().min(1).optional(),
		burstMaxMessages: z.number().int().min(1).optional(),
		burstLongMessageThreshold: z.number().int().min(1).optional(),
		replyCooldownMs: z.number().int().min(0).optional(),
		typingEnabled: z.boolean().optional(),
		replyDelayEnabled: z.boolean().optional(),
		replyDelayMaxMs: z.number().int().min(0).optional(),
		sendIntervalMs: z.number().int().min(0).optional(),
		maxImmediateOutputMessages: z.number().int().min(1).optional(),
		stripMarkdown: z.boolean().optional(),
		quietHours: quietHoursSchema.optional(),
		maxRepliesPerMinute: z.number().int().min(0).optional(),
		allowedTools: z.array(z.string().min(1)).nullish(),
	})
	.strict();

/** Explicit, strict patch: unknown keys are rejected rather than silently dropped. */
export const conversationPolicyPatchSchema = z
	.object({
		version: z.number().int().min(1).optional(),
		enabled: z.boolean().optional(),
		followUpWhenBusy: z.enum(["follow-up", "reject"]).optional(),
		steerWhenBusy: z.enum(["steer", "follow-up", "reject"]).optional(),
		memoryEnabled: z.boolean().optional(),
		sharedMemoryEnabled: z.boolean().optional(),
		sharedMemoryWriteEnabled: z.boolean().optional(),
		memoryReviewRequired: z.boolean().optional(),
		memoryCompactionEnabled: z.boolean().optional(),
		memoryExtractModel: z.string().min(1).nullish(),
		memoryExtractionPromptVersion: z.string().min(1).optional(),
		memoryMinConfidence: z.number().min(0).max(1).optional(),
		memoryMaxWritesPerActivity: z.number().int().min(1).max(50).optional(),
		trigger: triggerPolicyPatchSchema.optional(),
		pacing: pacingPolicyPatchSchema.optional(),
	})
	.strict();

export type ConversationPolicyPatch = z.infer<typeof conversationPolicyPatchSchema>;

/** Map the legacy activity-window contract onto the richer pacing policy. */
export function conversationPolicyFromActivityAggregation(
	policy: ActivityAggregationPolicy,
): ConversationPolicy {
	const queue = conversationPolicySchema.parse({});
	return {
		...queue,
		pacing: {
			...queue.pacing,
			burstMaxMessages: policy.maxMessages,
			burstMaxWaitMs: policy.burstMaxWaitMs ?? Math.max(policy.windowMs, 15_000),
			burstSettleMs: policy.windowMs,
		},
	};
}
