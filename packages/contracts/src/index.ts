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
	channelKind: z.string().min(1),
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

export const channelNoticeTypeSchema = z.enum([
	"poke",
	"revoke",
	"reaction",
	"typing",
	"ban",
	"mute",
	"group-file",
	"title",
	"member-change",
	"unknown",
]);

export type ChannelNoticeType = z.infer<typeof channelNoticeTypeSchema>;

/**
 * Platform notices are deliberately not `MessageEnvelope`s: they have no required message
 * parts and must never trigger a model turn by themselves. The server persists the ones that
 * matter as system/notice rows and hands poke-at-bot to the Phase 2 wake policy later.
 */
export const channelNoticeSchema = z.object({
	channelId: z.string().min(1),
	channelKind: z.string().min(1),
	conversationKey: conversationKeySchema.refine(
		(key) => key.kind === "private" || key.kind === "group",
		{ message: "Channel notices only belong to private or group conversations" },
	),
	noticeType: channelNoticeTypeSchema,
	id: z.string().min(1),
	occurredAtMs: z.number().int().nonnegative(),
	actorId: z.string().min(1).optional(),
	actorDisplayName: z.string().min(1).optional(),
	targetUserId: z.string().min(1).optional(),
	targetMessageId: z.string().min(1).optional(),
	isSelfTarget: z.boolean().optional(),
	details: z.record(z.string(), z.unknown()).optional(),
	raw: z.unknown().optional(),
});

export type ChannelNotice = z.infer<typeof channelNoticeSchema>;

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

export * from "./policy.ts";
export * from "./proactive.ts";

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
	activityPolicy: "elaina.conversationPolicy",
	activityWindow: "elaina.activityWindow",
} as const;
