import { LURK_MARKER } from "./trigger.ts";

/**
 * Block the stream flush when a private context block or reasoning tag appears: the reader must
 * never see harness internals, and a half-streamed block cannot be sanitized safely.
 */
const INTERNAL_TAG =
	/<\/?(?:think|thought|thinking|turn-context|previous-summary|persona|memories|memory|skills?)\b/iu;

const FENCE = /^\s*(`{3,}|~{3,})/u;

/**
 * Split a streamed partial into lines that are safe to send: no fence markers and no lines
 * inside a fenced block. `open` is true when the text ends inside an unclosed fence.
 */
function outsideFences(text: string): {
	readonly open: boolean;
	readonly safe: ReadonlySet<number>;
} {
	const safe = new Set<number>();
	let open: string | undefined;
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const match = FENCE.exec(line);
		if (match !== null) {
			const marker = match[1] ?? "";
			if (open === undefined) open = marker;
			else if (marker.charAt(0) === open.charAt(0) && marker.length >= open.length) {
				open = undefined;
			}
			continue;
		}
		if (open === undefined) safe.add(index);
	}
	return { open: open !== undefined, safe };
}

export interface StreamLineFlushOptions {
	/** Lines already flushed for this run; only later complete lines are returned. */
	readonly afterLine: number;
	readonly enabled: boolean;
	readonly partialText: string;
	readonly repetitionRewriteEnabled: boolean;
}

export interface StreamLine {
	/** Absolute zero-based index of the line within this run's partial text. */
	readonly index: number;
	readonly text: string;
}

export interface StreamLineFlushResult {
	/** Number of newline-terminated lines considered after this decision, flushed or skipped. */
	readonly afterLine: number;
	/** Newly completed, non-empty lines, trimmed and in order. */
	readonly lines: readonly StreamLine[];
}

const completedLineCount = (text: string): number => text.split("\n").length - 1;

/**
 * Extract newly completed newline-terminated lines from a streamed partial answer.
 *
 * Streaming must stay safe: no line is returned while a fenced code block is still open, and
 * nothing at all when the turn may lurk or when internal context tags leaked into the stream.
 * A repetition rewrite is a whole-answer correction, so it disables incremental flushing for
 * that turn. The returned `afterLine` advances even on a skip, so a later poll never dumps the
 * lines that were deliberately withheld.
 */
export function flushStreamLines(options: StreamLineFlushOptions): StreamLineFlushResult {
	const afterLine = Math.max(0, Math.floor(options.afterLine));
	const complete = completedLineCount(options.partialText);
	const fences = outsideFences(options.partialText);
	if (
		!options.enabled ||
		options.repetitionRewriteEnabled ||
		options.partialText.includes(LURK_MARKER) ||
		INTERNAL_TAG.test(options.partialText) ||
		fences.open
	) {
		return { afterLine: Math.max(afterLine, complete), lines: [] };
	}
	if (complete <= afterLine) return { afterLine, lines: [] };
	const rawLines = options.partialText.split("\n");
	const lines: StreamLine[] = [];
	for (let index = afterLine; index < complete; index += 1) {
		if (!fences.safe.has(index)) continue;
		const text = (rawLines[index] ?? "").replace(/\r$/u, "").trim();
		if (text.length > 0) lines.push({ index, text });
	}
	return { afterLine: complete, lines };
}
