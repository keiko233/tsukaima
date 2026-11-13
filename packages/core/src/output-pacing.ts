import type { ConversationPacingPolicy } from "@elaina/contracts";

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

/**
 * Normalize model text for humanlike delivery: optional Markdown stripping, newline units,
 * then a hard cap on immediate output. Extra units are joined into the last message instead of
 * being dropped silently.
 */
export function prepareOutboundText(
	text: string,
	pacing: ConversationPacingPolicy,
): PreparedOutput {
	const stripped = pacing.stripMarkdown ? stripMarkdownFormatting(text) : text;
	const normalized = stripped.trim();
	const allUnits = splitOnNewlines(normalized);
	if (allUnits.length === 0) return { overflowCount: 0, text: "", units: [] };
	const cap = Math.max(1, pacing.maxImmediateOutputMessages);
	if (allUnits.length <= cap) return { overflowCount: 0, text: normalized, units: allUnits };
	const head = allUnits.slice(0, cap - 1);
	const overflow = allUnits.slice(cap - 1);
	return {
		overflowCount: overflow.length,
		text: normalized,
		units: [...head, overflow.join("\n")],
	};
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

/** Steer while a run is still in its grace window, then queue a follow-up. */
export function busyDisposition(
	activeSinceMs: number | undefined,
	nowMs: number,
	graceMs = 3_000,
): "steer" | "follow-up" {
	if (activeSinceMs === undefined) return "steer";
	return nowMs - activeSinceMs <= Math.max(0, graceMs) ? "steer" : "follow-up";
}
