import { z } from "zod";

export const messagePartSchema = z.discriminatedUnion("type", [
	z.object({ text: z.string(), type: z.literal("text") }),
	z.object({ sha256: z.string().min(1), type: z.literal("image") }),
	z.object({ sha256: z.string().min(1), type: z.literal("sticker") }),
]);

export type MessagePart = z.infer<typeof messagePartSchema>;

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

export const healthStateSchema = z.enum(["starting", "degraded", "ready", "maintenance", "failed"]);

export const healthResponseSchema = z.object({
	stage: z.string(),
	state: healthStateSchema,
	uptimeMs: z.number().int().nonnegative(),
	version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
