import type {
	ConversationPacingPolicy,
	MessagePart,
	TriggerClassification,
} from "@tsukaima/contracts";

/** Split fenced code blocks without breaking them, then treat each non-empty line as a unit. */
export function splitOnNewlines(text: string): string[] {
	const lines = text.replace(/\r\n/gu, "\n").split("\n");
	const units: string[] = [];
	let fence: string | undefined;
	let buffer: string[] = [];
	const flushBuffer = () => {
		const value = buffer.join("\n").trim();
		if (value.length > 0) units.push(value);
		buffer = [];
	};
	for (const line of lines) {
		const trimmed = line.trimStart();
		const marker = /^(```+|~~~+)/u.exec(trimmed)?.[1];
		if (fence === undefined && marker !== undefined) {
			flushBuffer();
			fence = marker.startsWith("`") ? "`" : "~";
			buffer.push(line);
			continue;
		}
		if (fence !== undefined) {
			buffer.push(line);
			if (marker !== undefined && marker.startsWith(fence)) {
				flushBuffer();
				fence = undefined;
			}
			continue;
		}
		flushBuffer();
		const value = line.trim();
		if (value.length > 0) units.push(value);
	}
	flushBuffer();
	return units;
}

const stripInlineMarkdown = (line: string): string => {
	let value = line;
	value = value.replace(/^#{1,6}\s+/u, "");
	value = value.replace(/^\s*[-*+]\s+/u, "• ");
	value = value.replace(/^\s*>\s?/u, "");
	value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_match, alt, url) =>
		alt.length > 0 ? `${alt} (${url})` : String(url),
	);
	value = value.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_match, label, url) =>
		label === url ? String(label) : `${label} (${url})`,
	);
	value = value.replace(/`([^`]+)`/gu, "$1");
	value = value.replace(/\*\*([^*]+)\*\*/gu, "$1");
	value = value.replace(/__([^_]+)__/gu, "$1");
	value = value.replace(/~~([^~]+)~~/gu, "$1");
	value = value.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gu, "$1$2");
	value = value.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gu, "$1$2");
	return value;
};

/** Strip common Markdown while preserving fenced code blocks, URLs, and plain text. */
export function stripMarkdownFormatting(text: string): string {
	const lines = text.replace(/\r\n/gu, "\n").split("\n");
	const output: string[] = [];
	let fence: string | undefined;
	for (const line of lines) {
		const marker = /^(```+|~~~+)/u.exec(line.trimStart())?.[1];
		if (fence === undefined && marker !== undefined) {
			fence = marker.startsWith("`") ? "`" : "~";
			output.push(line);
			continue;
		}
		if (fence !== undefined) {
			output.push(line);
			if (marker !== undefined && marker.startsWith(fence)) fence = undefined;
			continue;
		}
		output.push(stripInlineMarkdown(line));
	}
	return output.join("\n");
}

export interface PreparedOutput {
	/** Units that will be sent immediately, after the immediate-message cap is applied. */
	readonly units: string[];
	/** Units folded into the final immediate message because the cap was reached. */
	readonly overflowCount: number;
	readonly text: string;
}

export interface PreparedPartsOutput {
	/** Ordered delivery batches. Text lines and media each become their own chat message. */
	readonly units: MessagePart[][];
	/** Batches folded into the final immediate message because the cap was reached. */
	readonly overflowCount: number;
	/** Normalized logical content in source order, suitable for outbound history. */
	readonly parts: MessagePart[];
	readonly text: string;
}

/** Fold several delivery units into one message, joining adjacent text with a newline. */
const foldUnits = (units: readonly (readonly MessagePart[])[]): MessagePart[] => {
	const folded: MessagePart[] = [];
	for (const unit of units) {
		for (const part of unit) {
			const last = folded.at(-1);
			if (part.type === "text" && last?.type === "text") {
				folded[folded.length - 1] = { text: `${last.text}\n${part.text}`, type: "text" };
			} else {
				folded.push(part);
			}
		}
	}
	return folded;
};

/** Split normalized text into delivery units without applying the immediate-message cap. */
const normalizeTextUnits = (
	text: string,
	pacing: ConversationPacingPolicy,
): { readonly text: string; readonly units: string[] } => {
	const stripped = pacing.stripMarkdown ? stripMarkdownFormatting(text) : text;
	const normalized = stripped.trim();
	return { text: normalized, units: splitOnNewlines(normalized) };
};

/**
 * Normalize model text for humanlike delivery: optional Markdown stripping, newline units,
 * then a hard cap on immediate output. Extra units are joined into the last message instead of
 * being dropped silently.
 */
export function prepareOutboundText(
	text: string,
	pacing: ConversationPacingPolicy,
): PreparedOutput {
	const normalized = normalizeTextUnits(text, pacing);
	if (normalized.units.length === 0) return { overflowCount: 0, text: "", units: [] };
	const cap = Math.max(1, pacing.maxImmediateOutputMessages);
	if (normalized.units.length <= cap) {
		return { overflowCount: 0, text: normalized.text, units: normalized.units };
	}
	const head = normalized.units.slice(0, cap - 1);
	const overflow = normalized.units.slice(cap - 1);
	return {
		overflowCount: overflow.length,
		text: normalized.text,
		units: [...head, overflow.join("\n")],
	};
}

/**
 * Group an ordered part list into humanlike delivery batches: every newline-separated text unit
 * and every media part is sent as its own chat message. Media no longer forces one combined
 * message, so a reply can send text, a sticker, and more text in between without losing order.
 * The immediate-message cap still folds overflow into the final batch instead of dropping it.
 */
export function prepareOutboundParts(
	parts: readonly MessagePart[],
	pacing: ConversationPacingPolicy,
): PreparedPartsOutput {
	const normalizedParts: MessagePart[] = [];
	const batches: MessagePart[][] = [];
	let overflowCount = 0;
	for (const part of parts) {
		if (part.type !== "text") {
			normalizedParts.push(part);
			batches.push([part]);
			continue;
		}
		const prepared = normalizeTextUnits(part.text, pacing);
		if (prepared.text.length === 0) continue;
		normalizedParts.push({ text: prepared.text, type: "text" });
		for (const unit of prepared.units) batches.push([{ text: unit, type: "text" }]);
	}
	const text = normalizedParts
		.filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const cap = Math.max(1, pacing.maxImmediateOutputMessages);
	let units = batches;
	if (batches.length > cap) {
		const overflow = batches.slice(cap - 1);
		units = [...batches.slice(0, cap - 1), foldUnits(overflow)];
		overflowCount += overflow.length;
	}
	return { overflowCount, parts: normalizedParts, text, units };
}

/** Optional bounded pre-reply delay; the random source is injectable for deterministic tests. */
export function boundedReplyDelayMs(
	pacing: ConversationPacingPolicy,
	random: () => number = Math.random,
): number {
	if (!pacing.replyDelayEnabled || pacing.replyDelayMaxMs <= 0) return 0;
	const value = Math.max(0, Math.min(1, random()));
	return Math.round(value * pacing.replyDelayMaxMs);
}

/** Sentence-final punctuation that makes a short message read as complete. */
const TERMINAL_PUNCTUATION = /[.!?。！？…~～]["'”’」』)）\]]*$/u;
/** A trailing emoji reads as the end of a short IM sentence ("ok 😊"). */
const TERMINAL_EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*$/u;
/** Common CJK sentence particles that close a short question or statement without punctuation. */
const TERMINAL_PARTICLE = /[吗呢嘛]["'”’」』)）\]]*$/u;

export interface DirectFlushInput {
	readonly classification: TriggerClassification | undefined;
	readonly pacing: Pick<
		ConversationPacingPolicy,
		"activeBurstWindowMs" | "burstLongMessageThreshold" | "directFlushEnabled"
	>;
	/** Local observation time of the previous message in the open window, if any. */
	readonly previousMessageAtMs: number | undefined;
	/** Local observation time of this message. */
	readonly submittedAtMs: number;
	readonly text: string;
}

export type DirectFlushDecision =
	| { readonly flush: true; readonly reason: "terminal-punctuation" | "long-message" }
	| {
			readonly flush: false;
			readonly reason: "disabled" | "not-direct" | "active-burst" | "incomplete";
	  };

/**
 * Decide whether a direct message may skip the burst settle window.
 *
 * A direct address that already reads as complete (terminal punctuation, trailing emoji, a CJK
 * closing particle, or at least `burstLongMessageThreshold` characters) is submitted at once,
 * unless the sender is still typing in quick succession: a previous message inside
 * `activeBurstWindowMs` keeps the normal settle/max-wait merge so a rapid burst still becomes
 * one turn.
 */
export function directFlushDecision(input: DirectFlushInput): DirectFlushDecision {
	if (!input.pacing.directFlushEnabled) return { flush: false, reason: "disabled" };
	if (input.classification !== "direct") return { flush: false, reason: "not-direct" };
	if (
		input.previousMessageAtMs !== undefined &&
		input.submittedAtMs - input.previousMessageAtMs <= input.pacing.activeBurstWindowMs
	) {
		return { flush: false, reason: "active-burst" };
	}
	const text = input.text.trim();
	if (text.length >= input.pacing.burstLongMessageThreshold) {
		return { flush: true, reason: "long-message" };
	}
	if (
		TERMINAL_PUNCTUATION.test(text) ||
		TERMINAL_EMOJI.test(text) ||
		TERMINAL_PARTICLE.test(text)
	) {
		return { flush: true, reason: "terminal-punctuation" };
	}
	return { flush: false, reason: "incomplete" };
}

/** Steer while a run is still in its grace window, then queue a follow-up. */
export function busyDisposition(
	activeSinceMs: number | undefined,
	nowMs: number,
	graceMs = 3_000,
): "steer" | "follow-up" {
	if (activeSinceMs === undefined) return "steer";
	return nowMs - activeSinceMs <= Math.max(0, graceMs) ? "steer" : "follow-up";
}
