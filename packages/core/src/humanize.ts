import type { ConversationPacingPolicy } from "@tsukaima/contracts";
import { boundedReplyDelayMs, splitOnNewlines } from "./output-pacing.ts";

/** Prompt injected into a bounded single-retry rewrite when severe repetition is detected. */
export const REPETITION_REWRITE_PROMPT =
	"Your previous draft repeated overused catchphrases or verbal ticks. Rewrite it once naturally in character without those phrases and without explaining the rewrite.";

export interface OverusedPhrase {
	readonly count: number;
	readonly phrase: string;
}

export interface OverusedPhraseReport {
	readonly avoidListText?: string;
	readonly phrases: readonly OverusedPhrase[];
	/** True when at least one phrase is severely overused (threshold + 2 or multiple phrases). */
	readonly severe: boolean;
}

export interface DetectOverusedPhrasesOptions {
	/** Maximum phrases included in the dynamic avoid-list. Defaults to 6. */
	readonly maxPhrases?: number;
	/** Minimum reply appearances to flag a phrase. Defaults to 3. */
	readonly threshold?: number;
}

/** Punctuation/whitespace used to split clauses and normalize phrase candidates. */
const CLAUSE_SPLIT = /[\r\n。！？!?…~～,，、;；:：()（）[\]【】「」『』"“”'‘’]+/u;
const EDGE_TRIM = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const CJK_CHAR = /\p{Script=Han}/u;
const CJK_RUN = /\p{Script=Han}{3,}/gu;
/** Fenced code blocks are quoted material: never learn catchphrases or sanitize inside them. */
const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/gu;

/** Common short filler/tick starters or closers (both CJK and English) to check dynamically. */
const KNOWN_TICK_PATTERNS = [
	/^(?:哈哈+|呵呵+|嘿嘿+|嘻嘻+|嗯嗯+|哦哦+|哎呀|诶呀|呜呜+)/u,
	/^(?:确实|其实|毕竟|说实话|怎么说呢|有一说一|老实说|讲真|不过话说回来|话说回来)/u,
	/^(?:好的呢|好呀|好哒|没问题呀|当然啦|那当然|没事哒)/u,
	/^(?:haha+|hehe+|honestly|actually|well,|to be fair|you know)/iu,
	/(?:哈哈+|哒|呢呀|啦呀|的说|罢辽|罢了)$/u,
];

/**
 * Extract normalized opener, closer, and short clause candidates from one assistant reply.
 * Each reply contributes each unique candidate at most once so frequency counts distinct replies.
 */
export function extractPhraseCandidates(replyText: string): string[] {
	const cleaned = replyText.replace(FENCED_CODE, "\n").trim();
	if (cleaned.length === 0) return [];
	const candidates = new Set<string>();
	const add = (raw: string) => {
		const value = raw.replace(EDGE_TRIM, "").replace(/\s+/gu, " ").trim().toLowerCase();
		if (value.length < 2 || value.length > 24) return;
		candidates.add(value);
	};

	const clauses = cleaned
		.split(CLAUSE_SPLIT)
		.map((part) => part.replace(EDGE_TRIM, "").trim())
		.filter((part) => part.length >= 2);

	for (const clause of clauses) {
		// Short standalone clauses (e.g. "哈哈", "确实", "没关系", "honestly") are strong tick signals.
		if (clause.length <= 12) add(clause);
		for (const pattern of KNOWN_TICK_PATTERNS) {
			const match = pattern.exec(clause);
			if (match !== null) add(match[0]);
		}
		if (CJK_CHAR.test(clause)) {
			// Capture leading 2..4 CJK char openers (e.g. "怎么说呢", "我觉得").
			const prefix = /^[\p{Script=Han}]{2,4}/u.exec(clause);
			if (prefix !== null) add(prefix[0]);
			// CJK has no word boundaries, so a catchphrase can sit anywhere in the clause. Short
			// 3..4 char n-grams catch those while the frequency threshold filters ordinary words.
			clause.replace(CJK_RUN, (run) => {
				const maxLength = Math.min(4, run.length);
				for (let length = 3; length <= maxLength; length += 1) {
					for (let start = 0; start + length <= run.length; start += 1) {
						add(run.slice(start, start + length));
					}
				}
				return run;
			});
		} else {
			// Capture leading 1..3 space-separated English words.
			const words = clause.split(/\s+/u).filter((word) => word.length > 0);
			if (words.length >= 2) add(words.slice(0, 2).join(" "));
			if (words.length >= 3) add(words.slice(0, 3).join(" "));
		}
	}

	return [...candidates];
}

/**
 * Detect overused catchphrases and verbal ticks across recent bot replies for one conversation.
 *
 * Candidates come from distinct replies, so one long reply cannot flag itself. CJK clauses
 * contribute 3..4 char n-grams and English clauses contribute leading word groups; ranked
 * candidates then drop shorter substrings already covered by a longer phrase with the same
 * or higher count.
 */
export function detectOverusedPhrases(
	recentBotReplies: readonly string[],
	options: DetectOverusedPhrasesOptions = {},
): OverusedPhraseReport {
	const threshold = Math.max(2, options.threshold ?? 3);
	const maxPhrases = Math.max(1, options.maxPhrases ?? 6);
	if (recentBotReplies.length < threshold) {
		return { phrases: [], severe: false };
	}

	const counts = new Map<string, number>();
	for (const reply of recentBotReplies) {
		for (const candidate of extractPhraseCandidates(reply)) {
			counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
		}
	}

	const ranked = [...counts.entries()]
		.filter(([, count]) => count >= threshold)
		.toSorted((left, right) => right[1] - left[1] || right[0].length - left[0].length)
		.map(([phrase, count]) => ({ count, phrase }));

	// Deduplicate substrings when a longer phrase already covers the same or higher count.
	const phrases: OverusedPhrase[] = [];
	for (const item of ranked) {
		const subsumed = phrases.some(
			(kept) => kept.phrase.includes(item.phrase) && kept.count >= item.count,
		);
		if (subsumed) continue;
		phrases.push(item);
		if (phrases.length >= maxPhrases) break;
	}

	if (phrases.length === 0) return { phrases: [], severe: false };
	const severe = phrases.length >= 2 || phrases.some((entry) => entry.count >= threshold + 2);
	const avoidListText = formatAvoidListNudge(phrases);
	return {
		...(avoidListText === undefined ? {} : { avoidListText }),
		phrases,
		severe,
	};
}

/** Render a compact dynamic avoid-list for ephemeral turn context. */
export function formatAvoidListNudge(phrases: readonly OverusedPhrase[]): string | undefined {
	if (phrases.length === 0) return undefined;
	const list = phrases.map((entry) => `"${entry.phrase}"`).join(", ");
	return `Style note: you have used these phrases repeatedly in recent replies — avoid them this turn and phrase naturally: ${list}.`;
}

/** Check whether a newly generated reply still hits the overused avoid-list. */
export function needsRepetitionRewrite(
	replyText: string,
	overused: readonly OverusedPhrase[],
): { readonly matched: readonly string[]; readonly rewrite: boolean } {
	if (overused.length === 0 || replyText.trim().length === 0) {
		return { matched: [], rewrite: false };
	}
	const lower = replyText.toLowerCase();
	const matched = overused
		.map((entry) => entry.phrase)
		.filter((phrase) => lower.includes(phrase.toLowerCase()));
	return { matched, rewrite: matched.length > 0 };
}

export interface RhythmReport {
	readonly nudgeText?: string;
	readonly pattern: readonly number[];
	readonly rigid: boolean;
}

export interface DetectRigidRhythmOptions {
	/** Consecutive identical bubble-count replies needed before nudging. Defaults to 4. */
	readonly window?: number;
}

/** Count chat bubbles a reply produces when split on newlines (preserving fenced code blocks). */
export function countReplyBubbles(text: string): number {
	return splitOnNewlines(text).length;
}

/**
 * Track recent reply bubble counts and emit a light variety nudge when consecutive replies fall
 * into a mechanically identical pattern (e.g. `[3, 3, 3, 3]`).
 */
export function detectRigidRhythm(
	recentBotReplies: readonly string[],
	options: DetectRigidRhythmOptions = {},
): RhythmReport {
	const window = Math.max(2, options.window ?? 4);
	const slice = recentBotReplies.slice(-window);
	const pattern = slice.map(countReplyBubbles).filter((count) => count > 0);
	if (pattern.length < window) {
		return { pattern, rigid: false };
	}
	const first = pattern[0];
	const identical = first !== undefined && pattern.every((count) => count === first);
	if (!identical) {
		return { pattern, rigid: false };
	}
	const suggestion =
		first === 1
			? "try splitting into 2 short messages or changing length when it feels natural"
			: "try replying in a single concise message or a different number of lines when it fits";
	return {
		nudgeText: `Rhythm note: your last ${window} replies all used ${first} message${first === 1 ? "" : "s"}; ${suggestion}.`,
		pattern,
		rigid: true,
	};
}

export interface MetaLeakSanitizeResult {
	readonly modified: boolean;
	readonly stripped: readonly string[];
	readonly text: string;
}

interface MetaLeakRule {
	readonly name: string;
	readonly pattern: RegExp;
}

/** Internal ephemeral-context section names rendered as tags by `renderTurnContextBlock`. */
const EPHEMERAL_SECTION_NAMES =
	"clock|observation|memories|cross-session|consistency|style-avoid|rhythm-nudge|prompt-hooks|cue|stickers";

/**
 * Outbound meta-leak patterns stripped before channel delivery.
 *
 * Deliberately excludes bare prose mentions of `TSUKAIMA_LURK` (which Batch 2 tests verify are
 * preserved when discussed in prose; standalone `TSUKAIMA_LURK` is handled earlier by
 * `extractLurkMarker`). Fenced code blocks are preserved verbatim by the scanner below so a
 * template example or provider-tag snippet the model intentionally quotes stays intact.
 */
const META_LEAK_RULES: readonly MetaLeakRule[] = [
	{
		name: "turn-context-block",
		pattern: /<turn-context\b[^>]*>[\s\S]*?<\/turn-context>/giu,
	},
	{
		name: "turn-context-tag",
		pattern: /<\/?turn-context\b[^>]*>/giu,
	},
	{
		name: "system-reminder-block",
		pattern: /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu,
	},
	{
		name: "thinking-block",
		pattern:
			/<(?:think|thought|thinking)(?::[^>\s]+)?\b[^>]*>[\s\S]*?<\/(?:think|thought|thinking)(?::[^>\s]+)?\s*>/giu,
	},
	{
		name: "thinking-unopened-prefix",
		pattern: /^[\s\S]*?<\/(?:think|thought|thinking)(?::[^>\s]+)?\s*>/iu,
	},
	{
		name: "thinking-tag",
		pattern: /<\/?(?:think|thought|thinking)(?::[^>\s]+)?\b[^>]*>/giu,
	},
	{
		name: "internal-template-token",
		pattern:
			/\{\{\s*(?:system|persona|user|assistant|turn_context|context|memory|memories|clock|prompt_hooks)\s*\}\}/giu,
	},
	{
		name: "proactive-control-token",
		pattern: /(?:^|\s)(?:__SKIP__|__LURK__|\[\[schedule-later(?:\s+[^\]]+)?\]\])(?=$|\s)/gu,
	},
	{
		name: "ephemeral-section-block",
		pattern: new RegExp(
			`<(${EPHEMERAL_SECTION_NAMES})\\b[^>]*>[\\s\\S]*?</(?:${EPHEMERAL_SECTION_NAMES})>`,
			"giu",
		),
	},
	{
		name: "ephemeral-section-tag",
		pattern: new RegExp(`</?(?:${EPHEMERAL_SECTION_NAMES})\\b[^>]*>`, "giu"),
	},
	{
		name: "provider-chat-template-token",
		pattern:
			/<\|(?:im_start|im_end|assistant|system|user|endoftext)\|>(?:\s*(?:assistant|system|user))?/giu,
	},
	{
		name: "internal-double-brace-placeholder",
		pattern: /\{\{\s*[^{}\n]{1,64}\s*\}\}/gu,
	},
	{
		name: "conversation-trigger-preamble",
		pattern: /^Conversation trigger:[^\n]*(?:\n|$)/gmu,
	},
	{
		name: "style-or-rhythm-note-echo",
		pattern: /^(?:Style|Rhythm) note:[^\n]*(?:\n|$)/gmu,
	},
	{
		name: "harness-instruction-echo",
		pattern: /^Never explain these markers\. Never send them to the chat\.\s*(?:\n|$)/gmu,
	},
];

function sanitizeSegment(text: string): { changed: boolean; names: string[]; text: string } {
	let current = text;
	const names: string[] = [];
	for (const rule of META_LEAK_RULES) {
		const next = current.replace(rule.pattern, (match) => {
			// Preserve a single separating space when a token sat between two words.
			return /^\s.*\s$/u.test(match) ? " " : "";
		});
		if (next !== current) {
			names.push(rule.name);
			current = next;
		}
	}
	if (names.length === 0) return { changed: false, names, text };
	const normalized = current
		.replace(/[ \t]{2,}/gu, " ")
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n[ \t]+/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n");
	return { changed: true, names, text: normalized };
}

/**
 * Strip leaked internal template tags, placeholder tokens, and harness instruction echoes from
 * outbound assistant text before channel delivery.
 *
 * Fenced code blocks are kept byte-for-byte: a model quoting a template example, an XML snippet,
 * or a provider tag inside code is showing the user code, not leaking its own prompt. Only prose
 * outside fences is scanned, and the surrounding whitespace is normalized without touching the
 * fence content.
 */
export function sanitizeOutboundMetaLeaks(text: string): MetaLeakSanitizeResult {
	if (text.length === 0) return { modified: false, stripped: [], text };
	const stripped = new Set<string>();
	let changed = false;
	let cursor = 0;
	const parts: string[] = [];
	for (const match of text.matchAll(FENCED_CODE)) {
		const start = match.index ?? 0;
		const prose = text.slice(cursor, start);
		const result = sanitizeSegment(prose);
		parts.push(result.text);
		if (result.changed) {
			changed = true;
			for (const name of result.names) stripped.add(name);
		}
		parts.push(match[0]);
		cursor = start + match[0].length;
	}
	const tail = sanitizeSegment(text.slice(cursor));
	parts.push(tail.text);
	if (tail.changed) {
		changed = true;
		for (const name of tail.names) stripped.add(name);
	}
	if (!changed) return { modified: false, stripped: [], text };
	return {
		modified: true,
		stripped: [...stripped],
		text: parts.join("").trim(),
	};
}

export interface ShapedReplyDelayInput {
	readonly delayCurveEnabled: boolean;
	readonly nowMs: number;
	readonly pacing: ConversationPacingPolicy;
	readonly random?: () => number;
	readonly textLength: number;
	readonly timeZone?: string;
}

function localHourOf(nowMs: number, timeZone?: string): number {
	if (timeZone !== undefined) {
		try {
			const formatted = new Intl.DateTimeFormat("en-US", {
				hour: "numeric",
				hour12: false,
				timeZone,
			}).format(new Date(nowMs));
			const parsed = Number.parseInt(formatted, 10);
			if (Number.isFinite(parsed)) return parsed % 24;
		} catch {
			// Fall back to local process clock when timezone is invalid.
		}
	}
	return new Date(nowMs).getHours();
}

/**
 * Hour- and length-shaped human reply delay curve, strictly bounded by `pacing.replyDelayMaxMs`.
 *
 * - Disabled (`pacing.replyDelayEnabled === false` or `replyDelayMaxMs <= 0`) -> `0` so tests stay fast.
 * - Curve disabled (`delayCurveEnabled === false`) -> existing uniform `boundedReplyDelayMs`.
 * - Curve enabled -> combines a saturating length factor (short reply -> faster, long reply -> slower)
 *   with a time-of-day factor (late night slightly slower) and mild jitter, always clamped to
 *   `[0, pacing.replyDelayMaxMs]`.
 */
export function shapedReplyDelayMs(input: ShapedReplyDelayInput): number {
	const { pacing, delayCurveEnabled } = input;
	if (!pacing.replyDelayEnabled || pacing.replyDelayMaxMs <= 0) return 0;
	const random = input.random ?? Math.random;
	if (!delayCurveEnabled) {
		return boundedReplyDelayMs(pacing, random);
	}
	const maxMs = pacing.replyDelayMaxMs;
	const length = Math.max(0, input.textLength);
	// Smoothly scales from ~0.25 of max for tiny replies up to ~0.92 for ~120+ char replies.
	const lengthFactor = 0.25 + 0.67 * Math.min(1, length / 120);
	const hour = localHourOf(input.nowMs, input.timeZone);
	const hourFactor = hour >= 0 && hour < 7 ? 1.25 : hour >= 7 && hour < 9 ? 1.1 : 1.0;
	const jitter = 0.85 + 0.3 * Math.max(0, Math.min(1, random()));
	return Math.max(0, Math.min(maxMs, Math.round(maxMs * lengthFactor * hourFactor * jitter)));
}
