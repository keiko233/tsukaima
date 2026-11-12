import { z } from "zod";
import { messagePartSchema } from "./base.ts";

export * from "./base.ts";
export * from "./api.ts";

export const conversationKeySchema = z.object({
	groupId: z.string().min(1).optional(),
	kind: z.enum(["private", "group", "webui", "task"]),
	peerId: z.string().min(1).optional(),
});

export const messageEnvelopeSchema = z.object({
	channelId: z.string().min(1),
	channelKind: z.enum(["onebot-v11", "webui", "system", "plugin"]),
	conversationKey: conversationKeySchema,
	id: z.string().min(1),
	mentions: z.array(z.object({ id: z.string().min(1).optional(), all: z.boolean().optional() })),
	parts: z.array(messagePartSchema).min(1),
	raw: z.unknown().optional(),
	sender: z.object({
		id: z.string().min(1),
		platformId: z.string().min(1),
		displayName: z.string().min(1),
		groupRole: z.enum(["owner", "admin", "member"]).optional(),
		isBot: z.boolean().optional(),
	}),
	source: z.object({
		messageId: z.string().min(1).optional(),
		timestampMs: z.number().int().nonnegative(),
		sequence: z.number().int().nonnegative().optional(),
	}),
	target: z
		.object({
			id: z.string().min(1).optional(),
			replyToEnvelopeId: z.string().min(1).optional(),
		})
		.optional(),
});

export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;

export const channelRequestSchema = z.object({
	accountId: z.string().min(1),
	channelId: z.string().min(1),
	comment: z.string().optional(),
	flag: z.string().min(1),
	groupId: z.string().min(1).optional(),
	kind: z.enum(["friend", "group-add", "group-invite"]),
	raw: z.unknown().optional(),
	receivedAtMs: z.number().int().nonnegative(),
	requesterDisplayName: z.string().min(1).optional(),
	requesterId: z.string().min(1),
	subType: z.string().optional(),
});

export type ChannelRequest = z.infer<typeof channelRequestSchema>;

export const channelMessageSchema = z.object({
	channelId: z.string().min(1),
	deliveryStatus: z.enum(["received", "pending", "accepted", "sent", "failed", "uncertain"]),
	direction: z.enum(["inbound", "outbound", "system"]),
	id: z.string().min(1),
	occurredAt: z.string().min(1),
	parts: z.array(messagePartSchema),
	replyToMessageId: z.string().min(1).optional(),
	senderDisplayName: z.string().min(1),
	senderExternalId: z.string().min(1).optional(),
	senderKind: z.enum(["human", "bot", "assistant", "system"]),
	text: z.string(),
});

export type ChannelMessage = z.infer<typeof channelMessageSchema>;

export const activityAggregationPolicySchema = z.object({
	maxMessages: z.number().int().min(1),
	windowMs: z.number().int().min(3_000).max(10_000),
});

export type ActivityAggregationPolicy = z.infer<typeof activityAggregationPolicySchema>;

export const defaultActivityAggregationPolicy: ActivityAggregationPolicy = {
	maxMessages: 20,
	windowMs: 6_000,
};

export const conversationPolicySchema = z.object({
	enabled: z.boolean().default(true),
	followUpWhenBusy: z.enum(["follow-up", "reject"]).default("follow-up"),
	steerWhenBusy: z.enum(["steer", "follow-up", "reject"]).default("steer"),
});

export type ConversationPolicy = z.infer<typeof conversationPolicySchema>;

export const defaultConversationPolicy: ConversationPolicy = {
	enabled: true,
	followUpWhenBusy: "follow-up",
	steerWhenBusy: "steer",
};

export const activityWindowSchema = z.object({
	activityId: z.string().min(1),
	conversationId: z.string().min(1),
	envelopes: z.array(messageEnvelopeSchema),
	openedAtMs: z.number().int().nonnegative(),
});

export type ActivityWindow = z.infer<typeof activityWindowSchema>;

export const submissionSchema = z.object({
	activityId: z.string().min(1),
	context: z.string(),
	whenBusy: z.enum(["steer", "follow-up"]),
});

export type Submission = z.infer<typeof submissionSchema>;

export const adminEventSchema = z.discriminatedUnion("type", [
	z.object({
		conversationId: z.string().min(1),
		messageId: z.string().min(1),
		type: z.literal("message.appended"),
	}),
	z.object({
		activityId: z.string().min(1),
		conversationId: z.string().min(1),
		type: z.literal("activity.opened"),
	}),
	z.object({
		activityId: z.string().min(1),
		conversationId: z.string().min(1),
		type: z.literal("activity.closed"),
	}),
	z.object({
		submissionId: z.string().min(1),
		type: z.literal("submission.created"),
	}),
	z.object({
		submissionId: z.string().min(1),
		type: z.literal("submission.settled"),
	}),
]);

export type AdminEvent = z.infer<typeof adminEventSchema>;

export const durableDocumentKinds = {
	activityPolicy: "tsukaima.conversationPolicy",
	activityWindow: "tsukaima.activityWindow",
} as const;
