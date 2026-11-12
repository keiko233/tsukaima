import type { MessageEnvelope, MessagePart } from "@elaina/contracts";
import type { OneBotEvent, OneBotSegment } from "./types.ts";

const mediaHashPattern = /^[0-9a-f]{64}$/i;

const asString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
};

const displayMedia = (
	segment: OneBotSegment,
	type: "image" | "sticker",
): MessagePart | undefined => {
	const hash = asString(segment.data?.sha256);
	const url = asString(segment.data?.url ?? segment.data?.file);
	const reference =
		hash !== undefined && mediaHashPattern.test(hash)
			? hash
			: url !== undefined
				? url
				: asString(segment.data?.file_id);
	return reference === undefined ? undefined : { sha256: reference, type };
};

const normalizedParts = (segments: readonly OneBotSegment[]): MessagePart[] => {
	const parts: MessagePart[] = [];
	for (const segment of segments) {
		const part =
			segment.type === "text"
				? textPart(segment)
				: segment.type === "face"
					? displayMedia(segment, "sticker")
					: segment.type === "image"
						? displayMedia(segment, "image")
						: undefined;
		if (part !== undefined) {
			parts.push(part);
		}
	}
	return parts;
};

const senderName = (event: OneBotEvent): string => {
	const sender = event.sender;
	return (
		sender?.card ?? sender?.nickname ?? asString(sender?.user_id ?? event.user_id) ?? "unknown"
	);
};

const textPart = (segment: OneBotSegment) => {
	const text = asString(segment.data?.text);
	return text === undefined ? undefined : { text, type: "text" as const };
};

export const normalizeOneBotEvent = (
	event: OneBotEvent,
	config: { botAccountId: string; channelId: string },
): MessageEnvelope | undefined => {
	if (
		event.post_type !== "message" ||
		(event.message_type !== "private" && event.message_type !== "group")
	) {
		return undefined;
	}
	const senderId = asString(event.sender?.user_id ?? event.user_id);
	const messageId = asString(event.message_id);
	const peerId = event.message_type === "private" ? senderId : asString(event.group_id);
	const parts = event.message === undefined ? [] : normalizedParts(event.message);
	if (
		senderId === undefined ||
		messageId === undefined ||
		peerId === undefined ||
		parts.length === 0
	) {
		return undefined;
	}
	const mentions =
		event.message === undefined
			? []
			: event.message
					.filter((segment) => segment.type === "at")
					.map((segment) => asString(segment.data?.qq))
					.filter((mentionId): mentionId is string => mentionId !== undefined)
					.map((mentionId) => (mentionId === "all" ? { all: true } : { id: mentionId }));
	const replyId =
		event.message === undefined
			? undefined
			: event.message.find((segment) => segment.type === "reply")?.data?.id;
	const sender =
		event.message_type === "group" && event.sender?.role !== undefined
			? {
					displayName: senderName(event),
					groupRole: event.sender.role,
					id: senderId,
					platformId: senderId,
				}
			: {
					displayName: senderName(event),
					id: senderId,
					platformId: senderId,
				};
	return {
		channelId: config.channelId,
		channelKind: "onebot-v11",
		conversationKey:
			event.message_type === "group"
				? { groupId: peerId, kind: "group", peerId: senderId }
				: { kind: "private", peerId },
		id: messageId,
		mentions: mentions.map((mention) => ({ id: mention.id })),
		parts,
		raw: event,
		sender,
		source: {
			messageId,
			timestampMs: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time * 1_000 : 0,
		},
		target:
			typeof replyId !== "string" && typeof replyId !== "number"
				? undefined
				: { replyToEnvelopeId: String(replyId) },
	};
};
