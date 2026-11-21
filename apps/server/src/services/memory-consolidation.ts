import { createHash } from "node:crypto";
import {
	emptyWarmState,
	memoryConsolidationOutputSchema,
	warmStatePayloadSchema,
	WARM_STATE_SCHEMA_VERSION,
	type MemoryConsolidationOutput,
	type MemoryConsolidationPolicy,
	type WarmStateCommitment,
	type WarmStatePayload,
	type WarmStatePersonCard,
} from "@tsukaima/contracts";

/**
 * Pure helpers of the background semantic memory consolidation pipeline. `MemoryService` owns
 * the I/O (watermark, model call, writes); everything here is deterministic so it can be tested
 * without a database or model.
 */

export const MEMORY_CONSOLIDATION_PROMPT_VERSION = "memory-consolidate-v2";
/** Evidence key that carries the structured {@link WarmStatePayload} on a `summary` memory. */
export const WARM_STATE_EVIDENCE_KEY = "state";

/** Settled message as the consolidation pass sees it. */
export interface ConsolidationMessage {
	readonly id: string;
	readonly direction: string;
	readonly occurredAt: string;
	readonly senderDisplayName: string | null;
	readonly senderUserId: string | null;
	readonly text: string;
}

const PHATIC_PATTERNS: readonly RegExp[] = [
	// Laughter and pure reactions.
	/^(?:[哈呵嘿嘻嗯噢哦啊呃唉诶欸草]+|h+a+(?:h+a+)*|l+o+l+|x+d+|233+|w+|66+|\?+|？+|!+|！+|\.+|。+|…+)$/iu,
	// Short confusion / acknowledgement interjections.
	/^(?:什么|啥|蛤|嗯嗯|好的?|行|ok(?:ay)?|k|收到|确实|是的?|对|真的?|笑死|绷|乐|草|what|huh|yes|no|yep|nope|sure|thanks?|thx|ty)[\s?？!！。.~～]*$/iu,
	// One or two-character reactions that carry no durable fact (but never a known content noun).
	/^(?:哈|呵|嘿|嘻|嗯|噢|哦|啊|呃|唉|诶|欸|草|啥|蛤|咦|喔|哇|呀|哎|喂)[\s?？!！。.~～]{0,3}$/u,
	// Casual jokes and back-and-forth questions with no commitment behind them.
	/^(?:你猜|然后呢|真的假的|怎么说|为什么|怎么了|在吗|在么|有事吗|吃了吗|干嘛呢|睡了吗|就这|笑死|绷不住了|离谱|好家伙|绝了|牛|厉害|6{2,}|233+)[\s?？!！。.~～]*$/iu,
	// Short small-talk questions (weather, meals, chit-chat) that carry no durable commitment.
	/^(?:今天|明天|现在)?(?:天气|吃饭|吃什么|喝什么|玩什么|干嘛|怎么样|咋样|怎么回事|为什么|怎么了|在干|在忙|睡了吗|醒了吗|吃了吗)[\p{Script=Han}]{0,4}[\s?？!！。.~～]*$/iu,
];

/**
 * Lines that should never become warm state or memories on their own: laughter, reactions,
 * bare interjections, emoji/sticker-only messages, and empty text.
 */
export function isPhaticMessage(text: string): boolean {
	const trimmed = text.replace(/\s+/gu, "").trim();
	if (trimmed.length === 0) return true;
	if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\p{P}\p{S}]+$/u.test(trimmed)) return true;
	if (/^\[(?:sticker|image|face|表情|图片)[^\]]*\]$/iu.test(trimmed)) return true;
	// Short CJK reactions are covered by the curated patterns above rather than a blanket
	// length rule, so a one-word answer that names a real thing is not mistaken for filler.
	return PHATIC_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Stable identity of one consolidation batch: the first unconsolidated message. It stays the
 * same while the batch grows, so failures of "the same window" are counted together.
 */
export function consolidationBatchKey(delta: readonly ConsolidationMessage[]): string | undefined {
	const first = delta[0];
	if (first === undefined) return undefined;
	return createHash("sha256")
		.update(`${first.id}|${first.occurredAt}`, "utf8")
		.digest("hex")
		.slice(0, 24);
}

/**
 * When the debounced consolidation job should run: immediately once enough messages piled up,
 * otherwise after the idle window, but never later than `maxDelayMs` after the first pending
 * message.
 */
export function nextConsolidationRunAt(input: {
	readonly nowMs: number;
	readonly pendingMessages: number;
	readonly pendingSinceMs: number;
	readonly policy: Pick<MemoryConsolidationPolicy, "idleMs" | "maxDelayMs" | "minNewMessages">;
}): number {
	if (input.pendingMessages >= input.policy.minNewMessages) return input.nowMs;
	const idle = input.nowMs + input.policy.idleMs;
	const deadline = input.pendingSinceMs + input.policy.maxDelayMs;
	return Math.max(input.nowMs, Math.min(idle, deadline));
}

/**
 * Read the structured warm state from a `summary` memory's evidence. Pre-Batch-5 rows carry the
 * regex harvest (`topic`, `decisions`, `todos`, `openThreads`); that output is noisy by
 * construction, so it is ignored and the next pass rebuilds the state from scratch.
 */
export function parseWarmState(evidence: Record<string, unknown>): WarmStatePayload | undefined {
	const raw = evidence[WARM_STATE_EVIDENCE_KEY];
	if (raw === undefined) return undefined;
	const parsed = warmStatePayloadSchema.safeParse(raw);
	return parsed.success ? parsed.data : undefined;
}

/** Extract and validate the JSON object a consolidation model returned. */
export function parseConsolidationOutput(text: string): MemoryConsolidationOutput | undefined {
	const trimmed = text.trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		const parsed = memoryConsolidationOutputSchema.safeParse(
			JSON.parse(trimmed.slice(start, end + 1)) as unknown,
		);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function clip(text: string, max: number): string {
	const normalized = text.replace(/\s+/gu, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function personKey(value: string): string {
	return value.trim().toLowerCase().normalize("NFKC");
}

/**
 * Merge-not-append: the model returns the complete merged state, and this function enforces
 * the invariants regardless of what the model did — keyed de-duplication, bounds, expiry of
 * commitments, and carrying forward person cards the model forgot to repeat.
 */
export function mergeWarmState(input: {
	readonly previous: WarmStatePayload | undefined;
	readonly next: MemoryConsolidationOutput["state"];
	readonly nowIso: string;
	readonly policy: Pick<MemoryConsolidationPolicy, "maxPersonCards" | "summaryMaxChars">;
}): WarmStatePayload {
	const previous = input.previous ?? emptyWarmState;
	const people = new Map<string, WarmStatePersonCard>();
	for (const card of previous.people) people.set(personKey(card.key), card);
	for (const card of input.next.people) {
		const key = personKey(card.key);
		const prior = people.get(key);
		people.set(key, {
			...card,
			aliases: [...new Set([...(prior?.aliases ?? []), ...card.aliases])].slice(0, 8),
			notes: card.notes.slice(0, 8),
			...(card.lastSeenAt === undefined && prior?.lastSeenAt !== undefined
				? { lastSeenAt: prior.lastSeenAt }
				: {}),
		});
	}
	const now = Date.parse(input.nowIso);
	const commitments = new Map<string, WarmStateCommitment>();
	for (const item of [...previous.commitments, ...input.next.commitments]) {
		commitments.set(item.key, item);
	}
	const openCommitments = [...commitments.values()].filter((item) => {
		if (item.status !== "open") return false;
		if (item.expiresAt === undefined) return true;
		const expires = Date.parse(item.expiresAt);
		return !Number.isFinite(expires) || expires > now;
	});
	const answers = new Map(previous.answers.map((item) => [item.key, item]));
	for (const item of input.next.answers) answers.set(item.key, item);
	const glossary = new Map(previous.glossary.map((item) => [personKey(item.term), item]));
	for (const item of input.next.glossary) glossary.set(personKey(item.term), item);
	// Cards omitted by the model are carried forward: model omissions are usually an oversight,
	// not a deletion. The cap evicts the least recently seen cards deterministically instead.
	const orderedPeople = [...people.values()].toSorted((left, right) => {
		const leftAt = left.lastSeenAt === undefined ? 0 : Date.parse(left.lastSeenAt);
		const rightAt = right.lastSeenAt === undefined ? 0 : Date.parse(right.lastSeenAt);
		const delta = (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
		return delta === 0 ? left.key.localeCompare(right.key) : delta;
	});
	return {
		answers: [...answers.values()].slice(-30),
		atmosphere: clip(input.next.atmosphere || previous.atmosphere, 400),
		commitments: openCommitments.slice(-20),
		glossary: [...glossary.values()].slice(-30),
		people: orderedPeople.slice(0, input.policy.maxPersonCards),
		summary: clip(input.next.summary || previous.summary, input.policy.summaryMaxChars),
		topics: input.next.topics.slice(0, 6),
		version: WARM_STATE_SCHEMA_VERSION,
	};
}

/**
 * Deterministic fallback when no consolidation model is available. It deliberately does not
 * guess topics, decisions, or todos from keywords; it only refreshes who was present.
 */
export function deterministicWarmState(input: {
	readonly delta: readonly ConsolidationMessage[];
	readonly previous: WarmStatePayload | undefined;
	readonly policy: Pick<MemoryConsolidationPolicy, "maxPersonCards">;
}): WarmStatePayload {
	const previous = input.previous ?? emptyWarmState;
	const people = new Map(previous.people.map((card) => [personKey(card.key), card]));
	for (const message of input.delta) {
		if (message.direction !== "inbound") continue;
		const name = message.senderDisplayName?.trim();
		const key = message.senderUserId ?? (name === undefined ? undefined : `name:${name}`);
		if (key === undefined || name === undefined || name.length === 0) continue;
		const prior = people.get(personKey(key));
		people.set(personKey(key), {
			aliases: [...new Set([...(prior?.aliases ?? []), ...(prior?.name === name ? [] : [name])])]
				.filter((alias) => alias !== name)
				.slice(0, 8),
			key,
			lastSeenAt: message.occurredAt,
			name,
			notes: prior?.notes ?? [],
		});
	}
	return {
		...previous,
		people: [...people.values()].slice(-input.policy.maxPersonCards),
		version: WARM_STATE_SCHEMA_VERSION,
	};
}

/**
 * Model input for one consolidation pass. The editable instructions come first; the output
 * contract is appended by the host so prompt edits cannot break parsing.
 */
export function renderConsolidationPrompt(input: {
	readonly chatKind: string;
	readonly delta: readonly ConsolidationMessage[];
	readonly instructions: string;
	readonly nowIso: string;
	readonly previous: WarmStatePayload | undefined;
	readonly policy: Pick<MemoryConsolidationPolicy, "maxPersonCards" | "summaryMaxChars">;
}): string {
	const transcript = input.delta
		.filter((message) => message.text.trim().length > 0)
		.map((message) => {
			const speaker =
				message.direction === "outbound"
					? "(assistant)"
					: `${message.senderDisplayName?.trim() || "Unknown"}${
							message.senderUserId === null ? "" : ` <${message.senderUserId}>`
						}`;
			return `[${message.occurredAt}] ${speaker}: ${clip(message.text, 500)}`;
		})
		.join("\n");
	// The schema version is host bookkeeping; `undefined` drops it from the serialized state.
	const previousState = { ...(input.previous ?? emptyWarmState), version: undefined };
	return [
		input.instructions.trim(),
		"",
		"Output contract:",
		'Return ONLY one JSON object: {"state": {...}, "memories": [...]}.',
		`- state is the COMPLETE merged state (not a diff) with: summary (<= ${input.policy.summaryMaxChars} chars), topics (<= 6 short strings), people (<= ${input.policy.maxPersonCards} cards: key, name, aliases, notes, lastSeenAt), atmosphere, glossary (term, meaning), commitments (key, text, owner, status open|done|cancelled, expiresAt ISO), answers (key, question, answer, answeredAt).`,
		"- Person card keys: use the <id> shown after a speaker name when present, otherwise name:<display name>. Never invent keys.",
		"- memories: only new durable facts worth remembering beyond this chat window: kind (fact|preference|person|relationship|event|todo|glossary|style), summary, optional content, optional subject (person card key), confidence 0..1, importance 0..1, optional expiresAt.",
		"- Return an empty memories array when nothing durable was said.",
		"",
		`Chat kind: ${input.chatKind}. Current time: ${input.nowIso}.`,
		"<previous-state>",
		JSON.stringify(previousState),
		"</previous-state>",
		"<new-messages>",
		transcript,
		"</new-messages>",
	].join("\n");
}

/**
 * Compact, model-facing rendering of the warm state for the ephemeral turn context. Lines are
 * clipped and capped so one stale note or glossary list cannot eat the turn budget; person
 * cards of the current speakers come first, then the rest by most recent activity.
 */
export function renderWarmStateLines(
	state: WarmStatePayload,
	options: {
		readonly maxLineChars?: number;
		readonly preferredPersonKeys?: readonly string[];
	} = {},
): string[] {
	const maxLineChars = Math.max(40, options.maxLineChars ?? 600);
	const lines: string[] = [];
	const add = (line: string) => {
		lines.push(clip(line, maxLineChars));
	};
	if (state.summary.length > 0) add(`- So far: ${state.summary}`);
	if (state.topics.length > 0) add(`- Topics: ${state.topics.join(", ")}`);
	if (state.atmosphere.length > 0) add(`- Room: ${state.atmosphere}`);
	const preferred = new Set((options.preferredPersonKeys ?? []).map(personKey));
	const people = state.people.toSorted((left, right) => {
		const leftPreferred =
			preferred.has(personKey(left.key)) || preferred.has(personKey(left.name)) ? 1 : 0;
		const rightPreferred =
			preferred.has(personKey(right.key)) || preferred.has(personKey(right.name)) ? 1 : 0;
		if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
		const leftAt = left.lastSeenAt === undefined ? 0 : Date.parse(left.lastSeenAt);
		const rightAt = right.lastSeenAt === undefined ? 0 : Date.parse(right.lastSeenAt);
		const delta = (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
		return delta === 0 ? left.key.localeCompare(right.key) : delta;
	});
	for (const card of people) {
		if (card.notes.length === 0) continue;
		add(`- ${card.name}: ${card.notes.join("; ")}`);
	}
	const open = state.commitments.filter((item) => item.status === "open");
	if (open.length > 0) {
		add(`- Open commitments: ${open.map((item) => item.text).join("; ")}`);
	}
	if (state.glossary.length > 0) {
		add(`- Glossary: ${state.glossary.map((item) => `${item.term} = ${item.meaning}`).join("; ")}`);
	}
	return lines;
}
