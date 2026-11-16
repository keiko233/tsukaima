import {
	type ConversationPolicy,
	type MessageEnvelope,
	messagePartsText,
	type TriggerClassification,
	type TriggerDecision,
} from "@tsukaima/contracts";

/** Exact model-visible marker that means "stay silent for this turn". */
export const LURK_MARKER = "TSUKAIMA_LURK";

export interface ResolvedReplyTarget {
	readonly direction: "inbound" | "outbound" | "system";
	readonly senderExternalId?: string | null;
	readonly senderKind?: "human" | "bot" | "assistant" | "system";
}

export interface TriggerClassificationInput {
	readonly botIds?: readonly string[];
	readonly chatKind: "private" | "group" | "webui" | "task" | "plugin";
	readonly envelope: MessageEnvelope;
	readonly nowMs?: number;
	readonly policy: ConversationPolicy;
	/** Merged aliases from the policy and the active persona. */
	readonly selfAliases?: readonly string[];
	readonly replyTarget?: ResolvedReplyTarget;
	/** Recent conversation activity makes a group message eligible for quiet participation. */
	readonly recentActivity?: boolean;
}

export interface TriggerClassificationResult {
	readonly aliasMentioned: boolean;
	readonly classification: TriggerDecision;
	readonly mediaOnly?: "image" | "sticker";
	readonly peerBotSpeaking: boolean;
	readonly quietHours: boolean;
	readonly reason: string;
}

const includesAny = (text: string, values: readonly string[]): string | undefined => {
	const haystack = text.toLocaleLowerCase();
	for (const value of values) {
		const needle = value.trim().toLocaleLowerCase();
		if (needle.length > 0 && haystack.includes(needle)) return value;
	}
	return undefined;
};

const selfIds = (input: TriggerClassificationInput): string[] => {
	const ids = new Set<string>(input.botIds ?? []);
	if (input.envelope.target?.id !== undefined) ids.add(input.envelope.target.id);
	const raw = input.envelope.raw;
	if (typeof raw === "object" && raw !== null) {
		const record = raw as Record<string, unknown>;
		for (const key of ["self_id", "selfId", "botId"] as const) {
			const value = record[key];
			if (typeof value === "string" || typeof value === "number") ids.add(String(value));
		}
	}
	return [...ids];
};

const isAllowlisted = (input: TriggerClassificationInput): boolean => {
	const allowlist = input.policy.trigger.allowlist;
	if (allowlist.length === 0) return false;
	const candidates = new Set<string>([
		input.envelope.sender.id,
		input.envelope.sender.platformId,
		input.envelope.conversationKey.peerId ?? "",
		input.envelope.conversationKey.groupId ?? "",
		input.envelope.target?.id ?? "",
	]);
	for (const value of allowlist) {
		if (candidates.has(value)) return true;
	}
	return false;
};

const insideQuietHours = (policy: ConversationPolicy, nowMs: number): boolean => {
	const quiet = policy.pacing.quietHours;
	if (quiet?.enabled !== true) return false;
	const hour = new Date(nowMs).getHours();
	if (quiet.startHour === quiet.endHour) return true;
	if (quiet.startHour < quiet.endHour) {
		return hour >= quiet.startHour && hour < quiet.endHour;
	}
	return hour >= quiet.startHour || hour < quiet.endHour;
};

/** A message is media-only when it carries no meaningful text and one media family only. */
export const mediaOnlyKind = (parts: MessageEnvelope["parts"]): "image" | "sticker" | undefined => {
	const meaningfulText = parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text.trim() : ""))
		.join("");
	if (meaningfulText.length > 0) return undefined;
	const mediaParts = parts.filter((part) => part.type !== "text");
	if (mediaParts.length === 0) return undefined;
	const families = new Set(mediaParts.map((part) => part.type));
	if (families.size !== 1) return undefined;
	const only = [...families][0];
	return only === "image" || only === "sticker" ? only : undefined;
};

const mediaDecision = (
	policy: ConversationPolicy,
	kind: "image" | "sticker",
): TriggerDecision | undefined => {
	const choice = kind === "image" ? policy.trigger.imageOnly : policy.trigger.stickerOnly;
	switch (choice) {
		case "wake":
			return "direct";
		case "lurk":
			return "soft";
		case "text-only":
			return "ambient";
		case "ignore":
			return "ignored";
	}
};

const isReplyToBot = (input: TriggerClassificationInput): boolean => {
	const replyId = input.envelope.target?.replyToEnvelopeId;
	if (replyId === undefined) return false;
	const target = input.replyTarget;
	if (target === undefined) return false;
	return (
		target.direction === "outbound" ||
		target.senderKind === "assistant" ||
		target.senderExternalId === "tsukaima"
	);
};

export function classifyConversationTrigger(
	input: TriggerClassificationInput,
): TriggerClassificationResult {
	const { envelope, policy } = input;
	const nowMs = input.nowMs ?? Date.now();
	const access =
		input.chatKind === "group" ? policy.trigger.groupAccess : policy.trigger.privateAccess;
	const external = input.chatKind === "private" || input.chatKind === "group";

	if (!external) {
		return {
			aliasMentioned: false,
			classification: "direct",
			peerBotSpeaking: false,
			quietHours: false,
			reason: "local conversation",
		};
	}

	if (access === "disabled" || (access === "allowlist" && !isAllowlisted(input))) {
		return {
			aliasMentioned: false,
			classification: "ignored",
			peerBotSpeaking: false,
			quietHours: false,
			reason: access === "disabled" ? "access disabled" : "sender is not allowlisted",
		};
	}

	const identifiers = new Set([
		envelope.sender.id,
		envelope.sender.platformId,
		envelope.conversationKey.peerId ?? "",
	]);
	for (const peer of policy.trigger.peerBotIds) {
		if (identifiers.has(peer)) {
			return {
				aliasMentioned: false,
				classification: "ignored",
				peerBotSpeaking: true,
				quietHours: false,
				reason: "peer bot is ignored",
			};
		}
	}

	if (insideQuietHours(policy, nowMs)) {
		const quietMedia = mediaOnlyKind(envelope.parts);
		return {
			aliasMentioned: false,
			classification: "ignored",
			...(quietMedia === undefined ? {} : { mediaOnly: quietMedia }),
			peerBotSpeaking: false,
			quietHours: true,
			reason: "quiet hours",
		};
	}

	const text = messagePartsText(envelope.parts);
	const aliases = [...policy.trigger.selfAliases, ...(input.selfAliases ?? [])];
	const alias = includesAny(text, aliases);
	const aliasMentioned = alias !== undefined;
	const peerBotSpeaking =
		envelope.sender.isBot === true ||
		policy.trigger.peerBotIds.includes(envelope.sender.platformId) ||
		policy.trigger.peerBotIds.includes(envelope.sender.id);
	const media = mediaOnlyKind(envelope.parts);
	const mediaResult = media === undefined ? undefined : mediaDecision(policy, media);

	if (mediaResult !== undefined) {
		return {
			aliasMentioned,
			classification: mediaResult,
			...(media === undefined ? {} : { mediaOnly: media }),
			peerBotSpeaking,
			quietHours: false,
			reason: `${media ?? "media"}-only message mapped by policy`,
		};
	}

	const ids = selfIds(input);
	const mentionsDisabled =
		input.chatKind === "group" && policy.trigger.groupMentionMode === "disabled";
	const mention = mentionsDisabled
		? undefined
		: envelope.mentions.find((entry) =>
				entry.id === undefined ? false : ids.includes(entry.id) || aliases.includes(entry.id),
			);
	const keyword = includesAny(text, policy.trigger.keywords);
	const directByReply = policy.trigger.replyToBotCounts && isReplyToBot(input);
	const privateDirect = input.chatKind === "private";

	if (mention !== undefined || keyword !== undefined || directByReply || privateDirect) {
		return {
			aliasMentioned,
			classification: "direct",
			...(media === undefined ? {} : { mediaOnly: media }),
			peerBotSpeaking,
			quietHours: false,
			reason:
				mention !== undefined
					? "bot mention"
					: keyword !== undefined
						? "configured keyword"
						: directByReply
							? "reply to bot"
							: "private chat",
		};
	}

	if (input.chatKind === "group" && policy.trigger.groupMentionMode === "disabled") {
		return {
			aliasMentioned,
			classification: "ambient",
			...(media === undefined ? {} : { mediaOnly: media }),
			peerBotSpeaking,
			quietHours: false,
			reason: "group mention mode is disabled",
		};
	}

	if (aliasMentioned || input.recentActivity === true) {
		return {
			aliasMentioned,
			classification: "soft",
			...(media === undefined ? {} : { mediaOnly: media }),
			peerBotSpeaking,
			quietHours: false,
			reason: aliasMentioned ? "bot alias appeared" : "recent conversation activity",
		};
	}

	return {
		aliasMentioned,
		classification: "ambient",
		...(media === undefined ? {} : { mediaOnly: media }),
		peerBotSpeaking,
		quietHours: false,
		reason: "group context only",
	};
}

export interface TriggerContextInput {
	readonly result: TriggerClassificationResult;
	readonly classification: Exclude<TriggerClassification, never> | "soft";
	readonly senderIsBot?: boolean;
}

/**
 * Compact model-visible contract for a soft/direct trigger. It intentionally avoids plugin,
 * transport, SQL, and database details.
 */
export function buildTriggerContext(input: TriggerContextInput): string {
	const result = input.result;
	const media =
		result.mediaOnly === undefined
			? "none"
			: result.mediaOnly === "sticker"
				? "sticker only"
				: "image only";
	return [
		"Conversation trigger:",
		`- ${input.classification}`,
		`- Bot name used without direct address: ${result.aliasMentioned ? "yes" : "no"}`,
		`- Another bot is speaking: ${input.senderIsBot === true || result.peerBotSpeaking ? "yes" : "no"}`,
		`- Media/notice summary: ${media}`,
		`- If speaking would be noise, reply with exactly ${LURK_MARKER} and nothing else.`,
	].join("\n");
}

export interface LurkDecision {
	readonly lurk: boolean;
	readonly text: string;
}

/** Extract the lurk marker before any outbound persistence or channel send. */
export function extractLurkMarker(text: string): LurkDecision {
	const markerPattern = new RegExp(`(^|\\s)${LURK_MARKER}(?=\\s|$)`, "gu");
	if (!markerPattern.test(text)) return { lurk: false, text: text.trim() };
	const cleaned = text.replace(new RegExp(`${LURK_MARKER}`, "gu"), "").trim();
	return { lurk: true, text: cleaned };
}
