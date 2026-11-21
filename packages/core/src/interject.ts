import type {
	ConversationPolicy,
	SocialFamiliarityLevel,
	TriggerClassification,
} from "@tsukaima/contracts";

const MAX_INTERJECT_INPUT_CHARS = 180;
const MAX_ANCHOR_CHARS = 240;
const MAX_RUNNING_SUMMARY_CHARS = 200;
const MAX_RECENT_LINE_CHARS = 160;

/**
 * Identity / persona / meta-self probes must stay on the main conversation where full persona
 * and memory live, never routed to a minimal fast-lane interjection.
 */
const IDENTITY_PROBE_PATTERNS: readonly RegExp[] = [
	/你是谁/u,
	/你叫什么/u,
	/你是(?:哪位|什么(?:东西|模型|ai|机器人|程序|人))/iu,
	/介绍一下你(?:自己)?/u,
	/你(?:是|不是)(?:ai|机器人|大模型|chatgpt|claude|gpt|人|真人)/iu,
	/你(?:用|背后)的?(?:什么|哪个)?模型/u,
	/\bwho\s+are\s+you\b/iu,
	/\bwhat(?:'s|\s+is)\s+your\s+name\b/iu,
	/\bare\s+you\s+(?:an?\s+)?(?:ai|bot|robot|human|llm|model)\b/iu,
	/\bwhat\s+model\s+are\s+you\b/iu,
	/\bintroduce\s+yourself\b/iu,
];

/**
 * Trailing follow-ups or addenda belong to the in-flight main turn (merge/steer/follow-up),
 * never to an out-of-band fast-lane reply.
 */
const TRAILING_FOLLOWUP_PATTERNS: readonly RegExp[] = [
	/^(?:对了|哦对|还有|顺便|另外|补充(?:一下)?|忘说了|忘了说|差点忘了|再补充|再加一句|等等|等一下|算了|不用了|先别)/u,
	/^(?:好的?|嗯+|哦+|行|收到|明白|了解|谢谢|多谢|辛苦了|加油|没关系|可以)[!！。.~～]*$/u,
	/^(?:and\s+also|also\b|btw\b|by\s+the\s+way|oh\s+also|one\s+more\s+thing|wait\s+actually|forgot\s+to\s+(?:say|mention)|never\s*mind|cancel\s+that)/iu,
	/^(?:ok(?:ay)?|sure|thanks|thx|got\s+it|cool|nice)[!.\s]*$/iu,
];

/** Signals that a direct message during a busy run is a quick/urgent check suitable for fast-lane. */
const URGENT_OR_DIRECT_CHECK_PATTERNS: readonly RegExp[] = [
	/(?:在吗|在不在|忙吗|忙不忙|还好吗|怎么了|出什么事|急|紧急|赶紧|快点|先问一下|问个事|帮我看一下|卡住了吗|还在吗)/u,
	/\b(?:urgent|asap|quick\s+question|are\s+you\s+there|you\s+busy|status|eta|still\s+there)\b/iu,
	/[?？]\s*$/u,
];

export function isIdentityProbe(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	return IDENTITY_PROBE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isTrailingFollowUp(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	return TRAILING_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export interface InterjectEvaluationInput {
	readonly classification: TriggerClassification | undefined;
	readonly policy: Pick<ConversationPolicy, "sidechat">;
	/** How long the active main turn has been running, in ms. */
	readonly runAgeMs: number;
	readonly text: string;
}

export type InterjectDecision =
	| { readonly interject: true; readonly reason: string }
	| {
			readonly interject: false;
			readonly reason:
				| "disabled"
				| "not-direct"
				| "empty"
				| "too-long"
				| "identity-probe"
				| "trailing-followup"
				| "not-urgent";
	  };

/**
 * Pure fast-lane busy interjection filter.
 *
 * Strictly excludes identity probes and trailing follow-ups (so they stay on the main
 * conversation) and admits only concise, direct urgent/quick messages when enabled.
 */
export function shouldInterject(input: InterjectEvaluationInput): InterjectDecision {
	if (!input.policy.sidechat.interjectEnabled) {
		return { interject: false, reason: "disabled" };
	}
	if (input.classification !== "direct") {
		return { interject: false, reason: "not-direct" };
	}
	const trimmed = input.text.trim();
	if (trimmed.length === 0) {
		return { interject: false, reason: "empty" };
	}
	if (trimmed.length > MAX_INTERJECT_INPUT_CHARS) {
		return { interject: false, reason: "too-long" };
	}
	if (isIdentityProbe(trimmed)) {
		return { interject: false, reason: "identity-probe" };
	}
	if (isTrailingFollowUp(trimmed)) {
		return { interject: false, reason: "trailing-followup" };
	}
	if (!URGENT_OR_DIRECT_CHECK_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return { interject: false, reason: "not-urgent" };
	}
	return { interject: true, reason: "urgent-direct" };
}

export interface InterjectPromptInput {
	/** Inbound direct message to answer concisely. */
	readonly messageText: string;
	/** One-line persona + relationship anchor (e.g. "You are Elaina (witty traveler). Familiarity: L2."). */
	readonly personaAnchor: string;
	/** Up to 3-4 recent clipped context lines. */
	readonly recentLines?: readonly string[];
	readonly relationLevel?: SocialFamiliarityLevel;
	/** Brief clipped description of what the main turn is currently working on. */
	readonly runningTaskSummary?: string;
	readonly senderName?: string;
}

export interface ComposedInterjectPrompt {
	readonly system: string;
	readonly user: string;
}

const clip = (value: string, max: number): string => {
	const single = value.replace(/\s+/gu, " ").trim();
	return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
};

/**
 * Compose a minimal fast-lane interjection prompt carrying a one-line persona/relation anchor
 * and minimal recent context, without loading the full transcript or mutating main-turn state.
 */
export function composeInterjectPrompt(input: InterjectPromptInput): ComposedInterjectPrompt {
	const anchor = clip(input.personaAnchor, MAX_ANCHOR_CHARS);
	const relation =
		input.relationLevel === undefined ? "" : ` Familiarity level: ${input.relationLevel}.`;
	const system = [
		`${anchor}${relation}`,
		"You are currently busy working on an ongoing task in this chat.",
		"Give a brief, natural 1-2 sentence reply to the urgent message below.",
		"Never invent or claim results from the unfinished task; acknowledge briefly if needed.",
	].join("\n");

	const parts: string[] = [];
	if (input.runningTaskSummary !== undefined && input.runningTaskSummary.trim().length > 0) {
		parts.push(
			`Currently working on: ${clip(input.runningTaskSummary, MAX_RUNNING_SUMMARY_CHARS)}`,
		);
	}
	const recent = (input.recentLines ?? [])
		.slice(-4)
		.map((line) => clip(line, MAX_RECENT_LINE_CHARS))
		.filter((line) => line.length > 0);
	if (recent.length > 0) {
		parts.push("Recent messages:\n" + recent.map((line) => `- ${line}`).join("\n"));
	}
	const speaker = input.senderName?.trim();
	parts.push(
		speaker !== undefined && speaker.length > 0
			? `Urgent message from ${speaker}: ${input.messageText.trim()}`
			: `Urgent message: ${input.messageText.trim()}`,
	);
	return { system, user: parts.join("\n\n") };
}

export interface FastLaneInterjectInput {
	readonly conversationId: string;
	readonly messageText: string;
	readonly policy: ConversationPolicy;
	readonly recentLines: readonly string[];
	readonly runAgeMs: number;
	readonly runningRequest: string;
	readonly senderName?: string;
}

export interface FastLaneInterjectResult {
	readonly handled: boolean;
	readonly reason?: string;
	readonly text?: string;
}

export interface FastLaneReply {
	readonly conversationId: string;
	readonly interjectId: string;
	readonly text: string;
}

/**
 * Out-of-band fast-lane interjection runner. Returning `undefined` or `{ handled: false }`
 * falls back cleanly to normal busy arbitration (`sidechat`) without touching main-turn state.
 */
export type FastLaneInterjector = (
	input: FastLaneInterjectInput,
) => Promise<FastLaneInterjectResult | undefined>;
