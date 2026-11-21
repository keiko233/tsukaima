import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import {
	messagePartSchema,
	consumeProactiveMarkers,
	type ConversationPolicy,
	defaultConversationPolicy,
	type MessagePart,
} from "@tsukaima/contracts";
import {
	type ConversationAnswer,
	type ConversationExecutionLock,
	type ConversationNarration,
	type FastLaneReply,
	extractLurkMarker,
	prepareOutboundParts,
	sanitizeOutboundMetaLeaks,
	shapedReplyDelayMs,
	withConversationLock,
} from "@tsukaima/core";
import {
	chatObjects,
	conversations,
	messages,
	replyDispatchIntents,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry, ChannelHistoryItem } from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { ConversationPacingTracker } from "./conversation-pacing.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { HookBus } from "./hook-bus.ts";
import type { FollowUpIntentStore } from "./follow-up-intents.ts";
import type { ReplyExpectation, ReplyExpectationStore } from "./reply-expectations.ts";
import { TurnEmissionTracker, type TurnEmissionSnapshot } from "./turn-emission.ts";

type ChatKind = "private" | "group" | "webui" | "workspace" | "task" | "plugin";

const DEFAULT_SPLIT_MAX_CHARS = 2_000;
const DEFAULT_PENDING_GRACE_MS = 15_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_LOOKBACK_MS = 300_000;
const isExternalChat = (kind: ChatKind): kind is "private" | "group" =>
	kind === "private" || kind === "group";

/**
 * Split text parts without dropping media parts. A long text part is sliced into chunks that
 * fit `maxChars`; non-text parts stay in order and are never dropped.
 */
export function splitMessageParts(
	parts: readonly MessagePart[],
	maxChars = DEFAULT_SPLIT_MAX_CHARS,
): MessagePart[][] {
	const limit = Math.max(1, Math.floor(maxChars));
	const chunks: MessagePart[][] = [];
	let current: MessagePart[] = [];
	let used = 0;
	const flush = () => {
		if (current.length > 0) chunks.push(current);
		current = [];
		used = 0;
	};
	for (const part of parts) {
		if (part.type !== "text") {
			current.push(part);
			continue;
		}
		let remaining = part.text;
		if (remaining.length === 0) continue;
		while (remaining.length > 0) {
			const room = limit - used;
			if (room <= 0) {
				flush();
				continue;
			}
			const slice = remaining.slice(0, room);
			current.push({ text: slice, type: "text" });
			used += slice.length;
			remaining = remaining.slice(slice.length);
			if (remaining.length > 0) flush();
			else if (used >= limit) flush();
		}
	}
	flush();
	return chunks.length === 0 ? [[]] : chunks;
}

/** Characters that carry no content: whitespace, punctuation, and symbols such as emoji. */
const NARRATION_IGNORABLE = /[\s\p{P}\p{S}]/gu;

/**
 * Drop a narration prefix a final answer repeats before its new text.
 *
 * A final answer may repeat the preamble it already narrated (or the cut prefix delivered for a
 * length continuation) and then continue. Sending that repeated prefix twice reads as a stutter,
 * so strip the longest matching already-shown prefix and send only the remainder. When nothing
 * substantive remains, the whole answer was already shown and must be suppressed.
 */
export function stripNarratedPrefix(
	shown: readonly string[] | undefined,
	text: string,
): { readonly duplicate: boolean; readonly text: string } {
	const trimmed = text.trim();
	if (shown === undefined || shown.length === 0) return { duplicate: false, text: trimmed };
	const candidates = shown.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	const joined = candidates.join("\n");
	if (joined.length > 0) candidates.push(joined);
	let matched: string | undefined;
	for (const candidate of candidates) {
		if (trimmed === candidate) {
			if (matched === undefined || candidate.length > matched.length) matched = candidate;
			continue;
		}
		if (!trimmed.startsWith(candidate)) continue;
		const next = trimmed.charAt(candidate.length);
		const boundary = next === "" || /\s/u.test(next);
		const terminal = /[.!?。！？…~～\n]$/u.test(candidate);
		if (!boundary) continue;
		if (!terminal && next !== "\n") continue;
		if (matched === undefined || candidate.length > matched.length) matched = candidate;
	}
	if (matched === undefined) return { duplicate: false, text: trimmed };
	const remainder = trimmed
		.slice(matched.length)
		.replace(/^[ \t]*\n?[ \t]*/u, "")
		.trim();
	const substantive = remainder.replace(NARRATION_IGNORABLE, "").length;
	return { duplicate: substantive === 0, text: substantive === 0 ? "" : remainder };
}

const DEDUP_PUNCTUATION = /[。.!！?？…~～,，;；:：]/u;
const DEDUP_BOUNDARY_START = /^[\s。.!！?？…~～,，;；:：]/u;
const DEDUP_BOUNDARY_ONLY = /^[\s。.!！?？…~～,，;；:：]*$/u;
const SENTENCE_SEGMENT = /[^。！？!?;；\r\n]+[。！？!?;；]?/gu;

const normalizeForDedup = (text: string): string =>
	text.replace(/\s+/gu, " ").trim().toLocaleLowerCase();

const stemForDedup = (text: string): string => {
	const normalized = normalizeForDedup(text);
	let end = normalized.length;
	while (end > 0 && DEDUP_PUNCTUATION.test(normalized.charAt(end - 1))) end -= 1;
	while (end > 0 && normalized.charAt(end - 1) === " ") end -= 1;
	return normalized.slice(0, end);
};

interface TextDedupContext {
	readonly combined: string;
	readonly normalizedSent: ReadonlySet<string>;
	readonly originalCandidates: readonly string[];
	readonly stems: ReadonlySet<string>;
}

const isDuplicateFragment = (fragment: string, context: TextDedupContext): boolean => {
	const normalized = normalizeForDedup(fragment);
	if (normalized.length === 0) return true;
	const stem = stemForDedup(fragment);
	if (context.normalizedSent.has(normalized) || context.stems.has(stem)) return true;
	if (normalized === context.combined) return true;
	for (const candidate of context.normalizedSent) {
		if (
			normalized.startsWith(candidate) &&
			DEDUP_BOUNDARY_ONLY.test(normalized.slice(candidate.length))
		) {
			return true;
		}
		if (
			candidate.startsWith(normalized) &&
			DEDUP_BOUNDARY_ONLY.test(candidate.slice(normalized.length))
		) {
			return true;
		}
	}
	return false;
};

const stripDuplicatePrefix = (line: string, context: TextDedupContext): string | undefined => {
	const lower = line.toLocaleLowerCase();
	for (const candidate of context.originalCandidates) {
		const lowerCandidate = candidate.toLocaleLowerCase();
		if (!lower.startsWith(lowerCandidate)) continue;
		const rest = line.slice(candidate.length);
		if (rest.length > 0 && !DEDUP_BOUNDARY_START.test(rest)) continue;
		const remainder = rest.replace(DEDUP_BOUNDARY_START, "").trim();
		return remainder.length === 0 ? undefined : remainder;
	}
	for (const candidate of context.normalizedSent) {
		if (candidate.length < 2 || !lower.startsWith(candidate)) continue;
		const rest = line.slice(candidate.length);
		if (rest.length > 0 && !DEDUP_BOUNDARY_START.test(rest)) continue;
		const remainder = rest.replace(DEDUP_BOUNDARY_START, "").trim();
		if (remainder.length > 0) return remainder;
	}
	return undefined;
};

const dedupeTextLine = (line: string, context: TextDedupContext): string | undefined => {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	if (isDuplicateFragment(trimmed, context)) return undefined;
	const stripped = stripDuplicatePrefix(trimmed, context);
	if (stripped !== undefined) return stripped;
	const segments = [...trimmed.matchAll(SENTENCE_SEGMENT)]
		.map((match) => match[0].trim())
		.filter((segment) => segment.length > 0);
	if (segments.length > 1) {
		const kept = segments.filter((segment) => !isDuplicateFragment(segment, context));
		const joined = kept.join("").trim();
		if (joined !== trimmed) return joined.length === 0 ? undefined : joined;
	}
	return trimmed;
};

/**
 * Drop text already delivered by `onebot-napcat.send` in this turn, matching exact parts,
 * repeated lines, and duplicated prefixes. Media/sticker parts always survive, and genuinely
 * new text inside a partially duplicated line is kept.
 */
export function suppressDuplicateTextParts(
	parts: readonly MessagePart[],
	sentTexts: readonly string[],
): MessagePart[] {
	const originals = [
		...new Set(sentTexts.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
	]
		.flatMap((entry) => [entry, ...entry.split(/\r?\n/u).map((line) => line.trim())])
		.filter((entry) => entry.length > 0)
		.toSorted((left, right) => right.length - left.length);
	const normalizedSent = new Set<string>();
	const stems = new Set<string>();
	for (const entry of sentTexts) {
		const entryNormalized = normalizeForDedup(entry);
		if (entryNormalized.length > 0) {
			normalizedSent.add(entryNormalized);
			stems.add(stemForDedup(entry));
		}
		for (const line of entry.split(/\r?\n/u)) {
			const lineNormalized = normalizeForDedup(line);
			if (lineNormalized.length === 0) continue;
			normalizedSent.add(lineNormalized);
			stems.add(stemForDedup(line));
		}
	}
	const combined = normalizeForDedup(sentTexts.join(" "));
	const context: TextDedupContext = {
		combined,
		normalizedSent,
		originalCandidates: originals,
		stems,
	};
	const finalText = normalizeForDedup(
		parts
			.filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join(" "),
	);
	if (
		finalText.length > 0 &&
		(finalText === combined || normalizedSent.has(finalText) || stems.has(stemForDedup(finalText)))
	) {
		return parts.filter((part) => part.type !== "text");
	}
	const output: MessagePart[] = [];
	for (const part of parts) {
		if (part.type !== "text") {
			output.push(part);
			continue;
		}
		const keptLines: string[] = [];
		for (const line of part.text.split(/\r?\n/u)) {
			const deduped = dedupeTextLine(line, context);
			if (deduped !== undefined) keptLines.push(deduped);
		}
		const text = keptLines.join("\n").trim();
		if (text.length > 0) output.push({ text, type: "text" });
	}
	return output;
}

export interface ReplyDispatcherOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly channels: ChannelRegistry;
	readonly database: () => TsukaimaDatabase | undefined;
	/** Durable pre-submission reply expectations; recovery only ever dispatches these. */
	readonly expectations: ReplyExpectationStore;
	/** Durable outbox for schedule-later markers owned by the originating plugin. */
	readonly followUps?: FollowUpIntentStore;
	readonly hooks: HookBus;
	readonly logger: Logger;
	/** Outbound text chunk size; Phase 2 may supply a pacing-aware value. */
	readonly splitMaxChars?: number;
	readonly pendingGraceMs?: number;
	readonly reconcileIntervalMs?: number;
	readonly reconcileLookbackMs?: number;
	/**
	 * Resolve the terminal answer of one durable submission by its request id. Recovery never
	 * scans transcript history: only the exact answer of an expected turn is dispatchable.
	 */
	readonly resolveAnswer?: (
		durableConversationId: string,
		submissionRequestId: string,
	) => Promise<
		| { readonly status: "missing" }
		| { readonly status: "pending" }
		| { readonly status: "unanswered"; readonly reason: string }
		| {
				readonly status: "answered";
				readonly entryId: string;
				readonly text: string;
				readonly truncated?: boolean;
		  }
	>;
	readonly replyAsQuote?: boolean;
	readonly now?: () => number;
	readonly pacing?: ConversationPacingTracker;
	readonly policy?: ConversationPolicyService;
	/** Test seams for deterministic pacing. */
	readonly random?: () => number;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Shared conversation execution lock; defaults to the host-wide lock. */
	readonly lock?: ConversationExecutionLock;
}

interface DeliveryPlanItem {
	readonly parts: readonly MessagePart[];
}

interface DeliveryTarget {
	readonly channelId: string | null;
	readonly chatKind: "private" | "group";
	/** Durable conversation id; also the outbound lane and cancellation key. */
	readonly conversationId: string;
	readonly id: string;
	/** Mid-turn narration skips the typing indicator and the pre-reply delay. */
	readonly narration?: boolean;
	readonly parts: readonly MessagePart[];
	readonly plan: readonly DeliveryPlanItem[];
	readonly platformConversationId: string | null;
	readonly policy: ConversationPolicy;
	readonly sessionId: string;
	readonly units: readonly MessagePart[][];
}

export interface ReplyDeliveryOutcome {
	readonly deliveryStatus: "sent" | "failed" | "uncertain" | "skipped" | "suppressed";
	readonly reason?: string;
	readonly text?: string;
}

export interface ReconcilePendingResult {
	readonly confirmed: number;
	readonly skipped: number;
	readonly uncertain: number;
}

export interface RecoverAnswersResult {
	readonly conversations: number;
	readonly recovered: number;
	readonly skipped: number;
}

/**
 * Turns a settled assistant answer into durable outbound history and, for external chats, a
 * channel send. Delivery is at-most-once: the outbound row is claimed through the
 * `(conversationId, durableEntryId)` unique index before any send, so an answer is never
 * delivered twice after a restart.
 */
export class ReplyDispatcher {
	readonly #audit: ReplyDispatcherOptions["audit"];
	readonly #channels: ChannelRegistry;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #expectations: ReplyExpectationStore;
	readonly #followUps: FollowUpIntentStore | undefined;
	readonly #hooks: HookBus;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #pendingGraceMs: number;
	readonly #reconcileIntervalMs: number;
	readonly #reconcileLookbackMs: number;
	readonly #resolveAnswer: ReplyDispatcherOptions["resolveAnswer"];
	readonly #replyAsQuote: boolean;
	readonly #splitMaxChars: number;
	readonly #policy: ConversationPolicyService | undefined;
	readonly #pacing: ConversationPacingTracker | undefined;
	readonly #random: () => number;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly #lock: ConversationExecutionLock | undefined;
	readonly #pendingOutput = new Map<string, AbortController>();
	/** Per-conversation outbound lanes; tails of the serial delivery chain. */
	readonly #outboundLanes = new Map<string, Promise<unknown>>();
	/**
	 * Per-conversation lane generations. Cancellation advances the generation, so queued lane
	 * items of the cancelled turn see a stale token and never start; deliveries scheduled after
	 * the interrupting inbound message capture the new generation and still run.
	 */
	readonly #laneEpochs = new Map<string, number>();
	/**
	 * Outbound content already shown in the current turn, by durable conversation id: narrations,
	 * streamed lines, tool text sends, and stickers/media/files. Only text sends suppress a later
	 * narration or a repeated final answer; a sticker or media send never does. This is
	 * process-local and deliberately not durable: recovery only replays the expected final answer,
	 * and the outbound unique key bounds any post-restart duplicate to one message.
	 */
	readonly #emissions = new TurnEmissionTracker();
	readonly #lastNarrationAtMs = new Map<string, number>();
	#legacyIntentReported = false;
	#reconcileTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: ReplyDispatcherOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#expectations = options.expectations;
		this.#followUps = options.followUps;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("tsukaima::server::reply");
		this.#splitMaxChars = options.splitMaxChars ?? DEFAULT_SPLIT_MAX_CHARS;
		this.#pendingGraceMs = options.pendingGraceMs ?? DEFAULT_PENDING_GRACE_MS;
		this.#reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		this.#reconcileLookbackMs = options.reconcileLookbackMs ?? DEFAULT_RECONCILE_LOOKBACK_MS;
		this.#resolveAnswer = options.resolveAnswer;
		this.#replyAsQuote = options.replyAsQuote ?? false;
		this.#now = options.now ?? Date.now;
		this.#policy = options.policy;
		this.#pacing = options.pacing;
		this.#random = options.random ?? Math.random;
		this.#lock = options.lock;
		this.#sleep =
			options.sleep ??
			((ms, signal) =>
				new Promise<void>((resolve, reject) => {
					if (signal.aborted) {
						reject(new OutputCancelledError());
						return;
					}
					const timer = setTimeout(resolve, ms);
					const onAbort = () => {
						clearTimeout(timer);
						reject(new OutputCancelledError());
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}));
	}

	/**
	 * Cancel the in-flight output of one conversation without touching other chats. Callers
	 * invoke this only for a direct interrupting message, never for ambient group chatter.
	 *
	 * Advancing the lane generation aborts whatever is sending now and makes every queued item of
	 * the cancelled turn stale when its slot starts. A later turn reserves its lane item with the
	 * new generation, so this cannot drop a newer reply.
	 */
	cancelPendingOutput(conversationId: string): boolean {
		const nextEpoch = (this.#laneEpochs.get(conversationId) ?? 0) + 1;
		this.#laneEpochs.set(conversationId, nextEpoch);
		const controller = this.#pendingOutput.get(conversationId);
		const queued = this.#outboundLanes.has(conversationId);
		if (controller === undefined && !queued) return false;
		controller?.abort();
		this.#logger.info("pending output cancelled", {
			conversationId,
			inFlight: controller !== undefined,
			queued,
		});
		return true;
	}

	#laneEpoch(conversationId: string): number {
		return this.#laneEpochs.get(conversationId) ?? 0;
	}

	#laneIsCurrent(conversationId: string, epoch: number): boolean {
		return this.#laneEpoch(conversationId) === epoch;
	}

	/**
	 * Run `task` after every earlier delivery of the same conversation. Different conversations
	 * never wait on each other, and a failed delivery never blocks the next one. A queued task
	 * whose lane generation was cancelled runs `stale` instead, which must settle any durable row
	 * it already owns.
	 */
	#runOutboundLane<T>(
		conversationId: string,
		task: () => Promise<T>,
		stale: () => Promise<T>,
	): Promise<T> {
		const epoch = this.#laneEpoch(conversationId);
		const previous = this.#outboundLanes.get(conversationId) ?? Promise.resolve();
		const run = previous
			.catch(() => undefined)
			.then(() => (this.#laneIsCurrent(conversationId, epoch) ? task() : stale()));
		const tail = run.catch(() => undefined);
		this.#outboundLanes.set(conversationId, tail);
		void tail.then(() => {
			if (this.#outboundLanes.get(conversationId) === tail) {
				this.#outboundLanes.delete(conversationId);
			}
		});
		return run;
	}

	/**
	 * Run a host-owned immediate send on the same per-conversation lane as replies and narrations.
	 * Unlike a dispatcher delivery, an explicit plugin send is not dropped by a lane cancellation:
	 * it keeps its slot and ordering, because the plugin already decided to speak.
	 */
	runOnOutboundLane<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#outboundLanes.get(conversationId) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(task);
		const tail = run.catch(() => undefined);
		this.#outboundLanes.set(conversationId, tail);
		void tail.then(() => {
			if (this.#outboundLanes.get(conversationId) === tail) {
				this.#outboundLanes.delete(conversationId);
			}
		});
		return run;
	}

	/**
	 * Record text a tool already posted to this conversation's chat during the current turn, so
	 * a final answer that only repeats it is not sent a second time. `OutboundService` calls this
	 * after a successful channel send; a later tool round also stops narrating a preamble.
	 */
	noteDirectSend(durableConversationId: string, text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		this.#emissions.record(durableConversationId, {
			id: `direct-send:${randomUUID()}`,
			kind: "text",
			shown: true,
			text: trimmed,
		});
	}

	/**
	 * Record the non-text parts of a channel send from the current turn. A sticker/media/file send
	 * is remembered for the live transcript but never blocks narration or the final text reply.
	 */
	noteDirectSendParts(durableConversationId: string, parts: readonly MessagePart[]): void {
		this.#emissions.recordParts(durableConversationId, parts);
	}

	/** Record a completed outbound emission, for example a streamed line flushed mid-turn. */
	noteEmission(
		durableConversationId: string,
		emission: {
			readonly id: string;
			readonly kind: "stream-line";
			readonly text: string;
		},
	): void {
		this.#emissions.record(durableConversationId, emission);
	}

	/** True when this turn already delivered text through a channel send tool. */
	hasDirectSendThisTurn(durableConversationId: string): boolean {
		return this.#emissions.hasTextEmitted(durableConversationId);
	}

	/**
	 * Reset all per-turn dispatcher state when a turn is admitted. Without this, state from a
	 * previous turn (tool sends, shown narrations, last narration instant) would leak into the
	 * next turn and wrongly suppress a legitimate repeated reply.
	 */
	beginTurn(durableConversationId: string): void {
		this.#endTurn(durableConversationId);
		this.#lastNarrationAtMs.delete(durableConversationId);
	}

	/**
	 * The turn is over: nothing shown or sent by tools carries into the next turn. `beginTurn`
	 * calls this for an idle new turn; `handleAnswer` performs the same clear synchronously at
	 * entry, before its first await, so it can never wipe a newer turn that started meanwhile.
	 */
	#endTurn(durableConversationId: string): void {
		this.#emissions.end(durableConversationId);
	}

	/**
	 * Deliver one mid-turn narration at most once.
	 *
	 * The outbound row is keyed by `narrationId` through the `(conversationId, durableEntryId)`
	 * unique index, so a hook replayed after a crash never sends it twice. Narration is not an
	 * owed reply: it records no reply expectation or dispatch intent, and a pending row left by a
	 * crash is reconciled as uncertain rather than resent. The lane slot is reserved before any
	 * await so the narration always precedes the final answer of the same turn.
	 */
	handleNarration(narration: ConversationNarration): Promise<ReplyDeliveryOutcome | undefined> {
		// Record the shown text synchronously, before the lane item can start. `handleAnswer`
		// runs outside the lane and may otherwise see a queued-but-unstarted narration as absent
		// and send the final answer's repeated prefix twice.
		const recorded = this.#recordNarrationShown(narration);
		return this.#runOutboundLane(
			narration.conversationId,
			() => this.#handleNarrationNow(narration),
			async (): Promise<ReplyDeliveryOutcome | undefined> => ({
				deliveryStatus: "skipped",
				reason: "cancelled",
			}),
		).then((outcome) => {
			// Narration is not owed when it is skipped (disabled, rate limited, direct-send), so
			// the answer must not treat it as already shown.
			if (outcome?.deliveryStatus === "skipped") this.#rollbackNarrationShown(narration, recorded);
			return outcome;
		});
	}

	#recordNarrationShown(narration: ConversationNarration): string | undefined {
		const text = narration.text.trim();
		if (text.length === 0) return undefined;
		this.#emissions.record(narration.conversationId, {
			id: narration.narrationId,
			kind: "narration",
			text,
		});
		return text;
	}

	#rollbackNarrationShown(narration: ConversationNarration, recorded: string | undefined): void {
		if (recorded === undefined) return;
		this.#emissions.remove(narration.conversationId, narration.narrationId);
	}

	async #handleNarrationNow(
		narration: ConversationNarration,
	): Promise<ReplyDeliveryOutcome | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const [session] = await database
			.select({
				chatId: chatObjects.id,
				chatKind: chatObjects.kind,
				channelId: chatObjects.channelId,
				platformConversationId: chatObjects.platformConversationId,
				sessionId: conversations.id,
			})
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, narration.conversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) return { deliveryStatus: "skipped", reason: "no_domain_session" };
		// A length-prefix narration is owed content from a truncated answer, not an optional
		// preamble: it must be delivered even after a direct send, with narration disabled, or
		// inside the minimum interval. Dropping it loses text the reader never receives.
		const owed = narration.kind === "length-prefix";
		if (!owed && this.hasDirectSendThisTurn(narration.conversationId)) {
			return { deliveryStatus: "skipped", reason: "direct-send" };
		}
		let policy: ConversationPolicy = defaultConversationPolicy;
		try {
			policy = (await this.#policy?.effectivePolicy(session.sessionId)) ?? policy;
		} catch {}
		if (!owed && !policy.pacing.narrationEnabled) {
			return { deliveryStatus: "skipped", reason: "disabled" };
		}
		// Preamble narration is a courtesy: when two rounds produce preambles too close together,
		// drop the later one instead of delaying the actual tool work.
		const nowMs = this.#now();
		const lastNarrationAtMs = this.#lastNarrationAtMs.get(narration.conversationId);
		if (
			!owed &&
			lastNarrationAtMs !== undefined &&
			nowMs - lastNarrationAtMs < policy.pacing.narrationMinIntervalMs
		) {
			return { deliveryStatus: "skipped", reason: "rate_limited" };
		}
		const narrationText = this.#sanitizeOutboundText(
			narration.text,
			policy,
			narration.conversationId,
			narration.narrationId,
		);
		const transformed = await this.#transformReply({
			channelId: session.channelId,
			chatKind: session.chatKind,
			chatObjectId: session.chatId,
			conversationId: narration.conversationId,
			entryId: narration.narrationId,
			parts: [{ text: narrationText, type: "text" }],
			sessionId: session.sessionId,
			text: narrationText,
		});
		const sanitizedParts = this.#sanitizeOutboundParts(
			transformed.parts,
			policy,
			narration.conversationId,
			narration.narrationId,
		);
		const prepared = prepareOutboundParts(sanitizedParts, policy.pacing);
		if (prepared.units.length === 0) return { deliveryStatus: "skipped", reason: "empty_output" };
		const chatKind: ChatKind = session.chatKind;
		const external = isExternalChat(chatKind);
		const channelKind =
			external && session.channelId !== null
				? this.#channels.get(session.channelId)?.kind
				: undefined;
		const now = new Date().toISOString();
		const id = randomUUID();
		const inserted = await database
			.insert(messages)
			.values({
				chatObjectId: session.chatId,
				contentText: prepared.text,
				conversationId: session.sessionId,
				deliveryStatus: external ? "pending" : "sent",
				direction: "outbound",
				durableEntryId: narration.narrationId,
				id,
				ingestedAt: now,
				kind: external ? (channelKind ?? "plugin") : chatKind,
				occurredAt: now,
				partsJson: JSON.stringify(prepared.parts),
				senderDisplayName: "Tsukaima",
				senderExternalId: "tsukaima",
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: messages.id });
		if (inserted.length === 0) return { deliveryStatus: "skipped", reason: "duplicate" };
		this.#lastNarrationAtMs.set(narration.conversationId, nowMs);
		this.#logger.debug("narration accepted", {
			conversationId: narration.conversationId,
			kind: narration.kind,
			narrationId: narration.narrationId,
			sessionId: session.sessionId,
			toolNames: narration.toolNames,
		});
		// The row is persisted, so the live update goes out before the channel send. The WebUI
		// renders the narration bubble immediately instead of waiting for the final answer.
		if (!external) {
			this.#emitAfterReply({
				channelId: session.channelId,
				chatObjectId: session.chatId,
				deliveryStatus: "sent",
				entryId: narration.narrationId,
				sessionId: session.sessionId,
				text: prepared.text,
			});
			return { deliveryStatus: "sent", text: prepared.text };
		}
		if (session.channelId === null || session.platformConversationId === null) {
			const deliveryStatus = await this.#fail(
				database,
				id,
				session.sessionId,
				"External chat has no destination",
				{ channelId: session.channelId, platformConversationId: session.platformConversationId },
			);
			this.#emitAfterReply({
				channelId: session.channelId,
				chatObjectId: session.chatId,
				deliveryStatus,
				entryId: narration.narrationId,
				sessionId: session.sessionId,
				text: prepared.text,
			});
			return { deliveryStatus, text: prepared.text };
		}
		const deliveryStatus = await this.#deliverNow(
			database,
			{
				channelId: session.channelId,
				chatKind,
				conversationId: narration.conversationId,
				id,
				narration: true,
				parts: prepared.parts,
				plan: prepared.units.map((parts) => ({ parts })),
				platformConversationId: session.platformConversationId,
				policy,
				sessionId: session.sessionId,
				units: prepared.units,
			},
			session.channelId,
			session.platformConversationId,
		);
		this.#emitAfterReply({
			channelId: session.channelId,
			chatObjectId: session.chatId,
			deliveryStatus,
			entryId: narration.narrationId,
			sessionId: session.sessionId,
			text: prepared.text,
		});
		return { deliveryStatus, text: prepared.text };
	}

	#emitAfterReply(input: {
		readonly channelId: string | null;
		readonly chatObjectId: string;
		readonly deliveryStatus: "failed" | "sent" | "uncertain";
		readonly entryId: string;
		readonly sessionId: string;
		readonly text: string;
	}): void {
		this.#hooks.emitDetached("after.reply", input);
	}

	#shownText(durableConversationId: string): TurnEmissionSnapshot {
		return this.#emissions.capture(durableConversationId);
	}

	#sanitizeOutboundText(
		text: string,
		policy: ConversationPolicy,
		conversationId: string,
		entryId: string,
	): string {
		if (!policy.humanization.metaLeakSanitizeEnabled) return text;
		const result = sanitizeOutboundMetaLeaks(text);
		if (result.modified) {
			this.#logger.warn("outbound meta-leak sanitized", {
				conversationId,
				entryId,
				stripped: result.stripped,
			});
		}
		return result.text;
	}

	#sanitizeOutboundParts(
		parts: readonly MessagePart[],
		policy: ConversationPolicy,
		conversationId: string,
		entryId: string,
	): readonly MessagePart[] {
		if (!policy.humanization.metaLeakSanitizeEnabled) return parts;
		const stripped = new Set<string>();
		const next: MessagePart[] = [];
		for (const part of parts) {
			if (part.type !== "text") {
				next.push(part);
				continue;
			}
			const result = sanitizeOutboundMetaLeaks(part.text);
			if (result.modified) {
				for (const name of result.stripped) stripped.add(name);
			}
			if (result.text.length > 0) {
				next.push({ text: result.text, type: "text" });
			}
		}
		if (stripped.size > 0) {
			this.#logger.warn("outbound meta-leak sanitized", {
				conversationId,
				entryId,
				stripped: [...stripped],
			});
		}
		return next;
	}

	/**
	 * Deliver an out-of-band fast-lane busy interjection reply without touching the active main
	 * turn's reply expectation or `#emissions` state. Deduplicated by `interjectId`.
	 */
	handleFastLaneReply(reply: FastLaneReply): Promise<ReplyDeliveryOutcome | undefined> {
		return this.#runOutboundLane(
			reply.conversationId,
			() => this.#handleFastLaneReplyNow(reply),
			async () => ({ deliveryStatus: "skipped", reason: "cancelled" }),
		);
	}

	async #handleFastLaneReplyNow(reply: FastLaneReply): Promise<ReplyDeliveryOutcome | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const [session] = await database
			.select({
				chatId: chatObjects.id,
				chatKind: chatObjects.kind,
				channelId: chatObjects.channelId,
				platformConversationId: chatObjects.platformConversationId,
				sessionId: conversations.id,
			})
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, reply.conversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) return { deliveryStatus: "skipped", reason: "no_domain_session" };
		let policy: ConversationPolicy = defaultConversationPolicy;
		try {
			policy = (await this.#policy?.effectivePolicy(session.sessionId)) ?? policy;
		} catch {}
		const sanitized = this.#sanitizeOutboundText(
			reply.text,
			policy,
			reply.conversationId,
			reply.interjectId,
		);
		const prepared = prepareOutboundParts([{ text: sanitized, type: "text" }], policy.pacing);
		if (prepared.units.length === 0) return { deliveryStatus: "skipped", reason: "empty_output" };
		const chatKind: ChatKind = session.chatKind;
		const external = isExternalChat(chatKind);
		const channelKind =
			external && session.channelId !== null
				? this.#channels.get(session.channelId)?.kind
				: undefined;
		const now = new Date().toISOString();
		const id = randomUUID();
		const inserted = await database
			.insert(messages)
			.values({
				chatObjectId: session.chatId,
				contentText: prepared.text,
				conversationId: session.sessionId,
				deliveryStatus: external ? "pending" : "sent",
				direction: "outbound",
				durableEntryId: reply.interjectId,
				id,
				ingestedAt: now,
				kind: external ? (channelKind ?? "plugin") : chatKind,
				occurredAt: now,
				partsJson: JSON.stringify(prepared.parts),
				senderDisplayName: "Tsukaima",
				senderExternalId: "tsukaima",
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: messages.id });
		if (inserted.length === 0) return { deliveryStatus: "skipped", reason: "duplicate" };
		if (!external) return { deliveryStatus: "sent", text: prepared.text };
		if (session.channelId === null || session.platformConversationId === null) {
			const deliveryStatus = await this.#fail(
				database,
				id,
				session.sessionId,
				"External chat has no destination",
				{ channelId: session.channelId, platformConversationId: session.platformConversationId },
			);
			return { deliveryStatus, text: prepared.text };
		}
		const deliveryStatus = await this.#deliverNow(
			database,
			{
				channelId: session.channelId,
				chatKind,
				conversationId: reply.conversationId,
				id,
				narration: true,
				parts: prepared.parts,
				plan: prepared.units.map((parts) => ({ parts })),
				platformConversationId: session.platformConversationId,
				policy,
				sessionId: session.sessionId,
				units: prepared.units,
			},
			session.channelId,
			session.platformConversationId,
		);
		return { deliveryStatus, text: prepared.text };
	}

	/**
	 * Record an outbound send delivered by a channel tool (`onebot-napcat.send`) during an active
	 * turn so `handleAnswer` can suppress duplicate final text while preserving standalone media.
	 */
	recordTurnToolSend(input: {
		readonly durableConversationId: string;
		readonly text: string;
	}): void {
		const trimmed = input.text.trim();
		if (trimmed.length === 0) return;
		this.#emissions.record(input.durableConversationId, {
			id: `tool-send:${randomUUID()}`,
			kind: "text",
			text: trimmed,
		});
	}

	/**
	 * Settle an expectation whose turn was intentionally suppressed before any send.
	 *
	 * Background turns decide suppression outside the dispatcher (proactive markers, empty
	 * output). Recording that here keeps recovery from treating a deliberate silence as a lost
	 * reply, and keeps the decision durable across a crash right after the answer commits.
	 */
	async suppressExpectation(input: {
		readonly durableEntryId: string;
		readonly durableConversationId: string;
		readonly reason: string;
		readonly submissionRequestId: string;
	}): Promise<boolean> {
		const sessionId = await this.#sessionIdFor(input.durableConversationId);
		if (sessionId === undefined) return false;
		await this.#expectations.settle({
			conversationId: sessionId,
			detail: input.reason,
			durableEntryId: input.durableEntryId,
			state: "suppressed",
			submissionRequestId: input.submissionRequestId,
		});
		return true;
	}

	/** True when this submission still owes a reply (including a deferred follow-up handoff). */
	async expectationPending(
		durableConversationId: string,
		submissionRequestId: string,
	): Promise<boolean> {
		const sessionId = await this.#sessionIdFor(durableConversationId);
		if (sessionId === undefined) return false;
		const expectation = await this.#expectations.get(sessionId, submissionRequestId);
		return expectation?.state === "pending";
	}

	/**
	 * Record a plugin-owned follow-up before settling the suppressed answer.
	 *
	 * A schedule-later marker is an obligation, not just silence. If the intent cannot be
	 * persisted, the expectation stays pending and recovery retries the handoff instead of
	 * recording a successful suppression that silently lost the follow-up.
	 */
	async deferExpectation(input: {
		readonly delayMs: number;
		readonly durableEntryId: string;
		readonly durableConversationId: string;
		readonly followUpKind: string;
		readonly pluginId: string;
		readonly sourceTaskId?: string;
		readonly submissionRequestId: string;
	}): Promise<boolean> {
		const followUps = this.#followUps;
		const sessionId = await this.#sessionIdFor(input.durableConversationId);
		if (followUps === undefined || sessionId === undefined) return false;
		try {
			await followUps.record({
				conversationId: sessionId,
				delayMs: input.delayMs,
				followUpKind: input.followUpKind,
				pluginId: input.pluginId,
				...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
				submissionRequestId: input.submissionRequestId,
			});
		} catch (error) {
			this.#logger.warn(
				"follow-up intent could not be recorded; leaving reply expectation pending",
				{
					conversationId: input.durableConversationId,
					error: error instanceof Error ? error.message : String(error),
					pluginId: input.pluginId,
					submissionRequestId: input.submissionRequestId,
				},
			);
			return false;
		}
		await this.#expectations.settle({
			conversationId: sessionId,
			detail: "marker_schedule-later",
			durableEntryId: input.durableEntryId,
			state: "suppressed",
			submissionRequestId: input.submissionRequestId,
		});
		return true;
	}

	async #sessionIdFor(durableConversationId: string): Promise<string | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const [row] = await database
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.limit(1);
		return row?.id;
	}

	async handleAnswer(answer: ConversationAnswer): Promise<ReplyDeliveryOutcome | undefined> {
		// Capture and consume this turn's presentation state synchronously, before the first
		// await. A newer turn may be admitted and start narrating while this call is reading the
		// database; clearing the live maps after that await would wipe the newer turn's state.
		// A recovered answer belongs to an older, not-live turn, so it must neither read nor clear
		// the state an active live turn is still recording.
		const recovered = answer.recovered === true;
		const emissions = this.#shownText(answer.conversationId);
		const shownThisTurn = recovered ? undefined : emissions.narrated;
		const turnToolSends = recovered ? undefined : emissions.sentTexts;
		if (!recovered) {
			this.#endTurn(answer.conversationId);
			this.#lastNarrationAtMs.delete(answer.conversationId);
		}
		const database = this.#database();
		if (database === undefined) return undefined;
		const [session] = await database
			.select({
				chatId: chatObjects.id,
				chatKind: chatObjects.kind,
				channelId: chatObjects.channelId,
				platformConversationId: chatObjects.platformConversationId,
				sessionId: conversations.id,
			})
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, answer.conversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) {
			this.#logger.warn("answer has no domain session", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
			return { deliveryStatus: "skipped", reason: "no_domain_session" };
		}

		this.#logger.debug("handling assistant answer", {
			activityId: answer.activityId,
			chatKind: session.chatKind,
			conversationId: answer.conversationId,
			entryId: answer.entryId,
			sessionId: session.sessionId,
			textChars: answer.text.length,
		});
		this.#logger.trace("assistant answer preview", {
			conversationId: answer.conversationId,
			entryId: answer.entryId,
			preview: previewText(answer.text),
		});

		// Claim the durable dispatch intent before doing anything that could send. Recovery uses
		// this row to find answers whose send may have happened, independent of time windows.
		// Claiming and persisting are short critical sections under the conversation lock; the
		// slow part (typing, delays, multi-bubble sends) runs later on the outbound lane.
		const claim = await withConversationLock(
			answer.conversationId,
			() => this.#claimIntent(database, session.sessionId, answer.entryId),
			this.#lock,
		);
		if (claim !== "claimed") {
			await this.#settleExpectation(answer, session.sessionId, "settled", "already_dispatched");
			return { deliveryStatus: "skipped", reason: "already_dispatched" };
		}

		let policy: ConversationPolicy = defaultConversationPolicy;
		try {
			policy = (await this.#policy?.effectivePolicy(session.sessionId)) ?? policy;
		} catch (error) {
			this.#logger.warn("reply pacing policy unavailable", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// `shownThisTurn` and `turnToolSends` were snapshotted at entry; the final answer may still
		// repeat a narration or a tool-delivered text from this same turn.
		const lurk = extractLurkMarker(
			this.#sanitizeOutboundText(answer.text, policy, answer.conversationId, answer.entryId),
		);
		if (lurk.lurk) {
			const now = new Date(this.#now()).toISOString();
			await this.#insertOutbound(database, {
				chatObjectId: session.chatId,
				conversationId: session.sessionId,
				direction: "system",
				durableEntryId: answer.entryId,
				id: randomUUID(),
				ingestedAt: now,
				kind: "reply-lurk",
				occurredAt: now,
				senderDisplayName: "Tsukaima",
				senderExternalId: "tsukaima",
				updatedAt: now,
			});
			this.#pacing?.recordLurk(answer.conversationId);
			await this.#audit({
				action: "message.lurk",
				actorKind: "agent",
				payload: {
					activityId: answer.activityId,
					entryId: answer.entryId,
					remainingText: lurk.text,
				},
				result: "ok",
				targetId: session.sessionId,
				targetKind: "session",
			});
			this.#logger.info("assistant lurk marker suppressed", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
			// A lurk is a deliberate decision, not pending work: settle the intent so recovery
			// never replays it.
			await this.#settleIntent(database, session.sessionId, answer.entryId);
			await this.#settleExpectation(answer, session.sessionId, "suppressed", "lurk");
			return { deliveryStatus: "suppressed", reason: "lurk", text: lurk.text };
		}

		const stripped = stripNarratedPrefix(shownThisTurn, lurk.text);
		if (stripped.duplicate) {
			this.#logger.debug("assistant answer repeats text already shown this turn", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
			await this.#settleIntent(database, session.sessionId, answer.entryId);
			await this.#settleExpectation(answer, session.sessionId, "suppressed", "already_shown");
			return { deliveryStatus: "suppressed", reason: "already_shown", text: stripped.text };
		}
		const answerText = stripped.text;
		// The turn already showed substantive outbound content (a narration, a streamed line, or a
		// sticker/media/file) and the final answer adds nothing. That is a satisfied turn, not a
		// missing reply: settle the expectation instead of waiting for a follow-up send.
		const midTurnSubstantive = recovered !== true && emissions.substantiveOutbound;
		if (midTurnSubstantive && answerText.replace(NARRATION_IGNORABLE, "").length === 0) {
			this.#logger.debug("assistant answer empty after mid-turn outbound content", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
			await this.#settleIntent(database, session.sessionId, answer.entryId);
			await this.#settleExpectation(answer, session.sessionId, "suppressed", "already_shown");
			return { deliveryStatus: "suppressed", reason: "already_shown", text: answerText };
		}
		if (answer.truncated === true) {
			// Continuation was unavailable or the budget is spent: deliver the cut text as-is and
			// leave a durable audit trail instead of silently shipping a mid-word cut.
			await this.#audit({
				action: "message.answer-truncated",
				actorKind: "agent",
				payload: {
					activityId: answer.activityId,
					entryId: answer.entryId,
					textChars: answer.text.length,
				},
				result: "ok",
				targetId: session.sessionId,
				targetKind: "session",
			});
			this.#logger.warn("assistant answer was cut off by the output limit", {
				conversationId: answer.conversationId,
				entryId: answer.entryId,
			});
		}

		const transformed = await this.#transformReply({
			channelId: session.channelId,
			chatKind: session.chatKind,
			chatObjectId: session.chatId,
			conversationId: answer.conversationId,
			entryId: answer.entryId,
			parts: [{ text: answerText, type: "text" }],
			sessionId: session.sessionId,
			text: answerText,
		});
		let effectiveTransformedParts = transformed.parts;
		if (turnToolSends !== undefined && turnToolSends.length > 0) {
			effectiveTransformedParts = suppressDuplicateTextParts(transformed.parts, turnToolSends);
			if (effectiveTransformedParts.length === 0) {
				this.#logger.info("assistant final text suppressed after channel tool send", {
					conversationId: answer.conversationId,
					entryId: answer.entryId,
					sessionId: session.sessionId,
				});
				await this.#settleIntent(database, session.sessionId, answer.entryId);
				await this.#settleExpectation(
					answer,
					session.sessionId,
					"suppressed",
					"already_sent_via_tool",
				);
				return {
					deliveryStatus: "suppressed",
					reason: "already_sent_via_tool",
					text: lurk.text,
				};
			}
		}
		const sanitizedParts = this.#sanitizeOutboundParts(
			effectiveTransformedParts,
			policy,
			answer.conversationId,
			answer.entryId,
		);
		const prepared = prepareOutboundParts(sanitizedParts, policy.pacing);
		if (prepared.units.length === 0) {
			this.#logger.debug("assistant answer skipped as empty output", {
				entryId: answer.entryId,
				sessionId: session.sessionId,
			});
			await this.#settleIntent(database, session.sessionId, answer.entryId);
			await this.#settleExpectation(answer, session.sessionId, "settled", "empty_output");
			return { deliveryStatus: "skipped", reason: "empty_output" };
		}
		const text = prepared.text;
		const parts = prepared.parts;
		// Text lines and media parts each stay in their own batch, so a reply can send a message,
		// a sticker, and the next message in the exact order the model placed them.
		const plan: DeliveryPlanItem[] = prepared.units.map((unitParts) => ({ parts: unitParts }));
		if (prepared.overflowCount > 0) {
			await this.#audit({
				action: "message.output-overflow",
				actorKind: "agent",
				payload: {
					immediateCap: policy.pacing.maxImmediateOutputMessages,
					overflowCount: prepared.overflowCount,
				},
				result: "ok",
				targetId: session.sessionId,
				targetKind: "session",
			});
		}

		const chatKind: ChatKind = session.chatKind;
		const external = isExternalChat(chatKind);
		const channelId = session.channelId;
		const channelKind =
			external && channelId !== null ? this.#channels.get(channelId)?.kind : undefined;
		const kind = external ? (channelKind ?? "plugin") : chatKind;
		const now = new Date().toISOString();
		const id = randomUUID();
		const inserted = await withConversationLock(
			answer.conversationId,
			() =>
				this.#insertOutbound(database, {
					chatObjectId: session.chatId,
					contentText: text,
					conversationId: session.sessionId,
					deliveryStatus: external ? "pending" : "sent",
					direction: "outbound",
					durableEntryId: answer.entryId,
					id,
					ingestedAt: now,
					kind,
					occurredAt: now,
					partsJson: JSON.stringify(parts),
					senderDisplayName: "Tsukaima",
					senderExternalId: "tsukaima",
					updatedAt: now,
				}),
			this.#lock,
		);
		if (inserted.length === 0) {
			this.#logger.debug("assistant answer already dispatched", {
				entryId: answer.entryId,
				sessionId: session.sessionId,
			});
			await this.#settleIntent(database, session.sessionId, answer.entryId);
			await this.#settleExpectation(answer, session.sessionId, "settled", "duplicate");
			return { deliveryStatus: "skipped", reason: "duplicate" };
		}
		await database
			.update(replyDispatchIntents)
			.set({ messageId: id, updatedAtMs: this.#now() })
			.where(
				and(
					eq(replyDispatchIntents.conversationId, session.sessionId),
					eq(replyDispatchIntents.durableEntryId, answer.entryId),
				),
			);
		await Promise.all([
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, session.sessionId)),
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, session.chatId)),
		]);
		if (external) {
			await this.#hooks.emit("before.reply", {
				channelId,
				chatKind,
				chatObjectId: session.chatId,
				entryId: answer.entryId,
				sessionId: session.sessionId,
				text,
			});
		}
		const deliveryStatus = external
			? await this.#deliver(database, {
					channelId,
					chatKind,
					conversationId: answer.conversationId,
					id,
					parts,
					plan,
					platformConversationId: session.platformConversationId,
					policy,
					sessionId: session.sessionId,
					units: prepared.units,
				})
			: "sent";
		// A skipped/suppressed/duplicate outcome above already settled or left no intent. Any
		// delivery attempt is terminal once the outbound row exists, so the ledger is settled even
		// for a failed send: the row's `deliveryStatus` carries the truth.
		await this.#settleIntent(database, session.sessionId, answer.entryId);
		await this.#settleExpectation(answer, session.sessionId, "settled", deliveryStatus);
		this.#pacing?.recordReply(answer.conversationId);
		this.#hooks.emitDetached("after.reply", {
			channelId,
			chatObjectId: session.chatId,
			deliveryStatus,
			entryId: answer.entryId,
			sessionId: session.sessionId,
			text,
		});
		return { deliveryStatus, text };
	}

	/**
	 * Settle the reply expectation that admitted this answer, if one exists.
	 *
	 * A terminal dispatch outcome always settles: a failed or uncertain send is carried by the
	 * outbound row's `deliveryStatus`, and replaying it would violate at-most-once delivery.
	 */
	async #settleExpectation(
		answer: ConversationAnswer,
		sessionId: string,
		state: "settled" | "suppressed",
		detail: string,
	): Promise<void> {
		const submissionRequestId = answer.submissionRequestId;
		if (submissionRequestId === undefined) return;
		await this.#expectations.settle({
			conversationId: sessionId,
			detail,
			durableEntryId: answer.entryId,
			state,
			submissionRequestId,
		});
	}

	async #transformReply(input: {
		readonly channelId: string | null;
		readonly chatKind: ChatKind;
		readonly chatObjectId: string;
		readonly conversationId: string;
		readonly entryId: string;
		readonly parts: readonly MessagePart[];
		readonly sessionId: string;
		readonly text: string;
	}): Promise<{ readonly parts: readonly MessagePart[]; readonly text: string }> {
		let current = { parts: [...input.parts], text: input.text };
		let result: unknown;
		try {
			result = await this.#hooks.transform("reply.transform", {
				channelId: input.channelId,
				chatKind: input.chatKind,
				chatObjectId: input.chatObjectId,
				conversationId: input.conversationId,
				entryId: input.entryId,
				parts: current.parts,
				sessionId: input.sessionId,
				text: current.text,
			});
		} catch (error) {
			this.#logger.warn("reply transform failed; using original answer", {
				error: error instanceof Error ? error.message : String(error),
			});
			return current;
		}
		if (typeof result !== "object" || result === null) return current;
		const candidate = result as { readonly parts?: unknown; readonly text?: unknown };
		let text = typeof candidate.text === "string" ? candidate.text : current.text;
		let parts: MessagePart[] = current.parts;
		if (candidate.parts !== undefined) {
			const parsed = messagePartSchema.array().safeParse(candidate.parts);
			if (!parsed.success) {
				this.#logger.warn("reply transform returned invalid message parts", {
					error: parsed.error.message,
				});
				return current;
			}
			parts = [...parsed.data];
			if (typeof candidate.text !== "string") {
				const textParts = parts.filter((part) => part.type === "text");
				if (textParts.length > 0) {
					text = textParts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				}
			}
		}
		if (candidate.text !== undefined && typeof candidate.text !== "string") {
			this.#logger.warn("reply transform returned an invalid text value");
			return current;
		}
		// A text-only transform replaces the textual content, so keep `parts` consistent with the
		// text later hooks and delivery receive. Media-bearing results stay part-authoritative.
		if (
			typeof candidate.text === "string" &&
			candidate.parts === undefined &&
			parts.every((part) => part.type === "text")
		) {
			parts = candidate.text.length > 0 ? [{ text: candidate.text, type: "text" }] : [];
		}
		if (typeof candidate.text === "string" && !parts.some((part) => part.type === "text")) {
			if (candidate.text.length > 0) parts = [{ text: candidate.text, type: "text" }, ...parts];
		}
		if (parts.length === 0 && text.length > 0) parts = [{ text, type: "text" }];
		return { parts, text };
	}

	/** Startup and periodic reconciliation; never resends an unconfirmed pending row. */
	async reconcilePendingDeliveries(
		options: {
			graceMs?: number;
			lookbackMs?: number;
			nowMs?: number;
		} = {},
	): Promise<ReconcilePendingResult> {
		const database = this.#database();
		if (database === undefined) return { confirmed: 0, skipped: 0, uncertain: 0 };
		const nowMs = options.nowMs ?? this.#now();
		const graceMs = options.graceMs ?? this.#pendingGraceMs;
		const lookbackMs = options.lookbackMs ?? this.#reconcileLookbackMs;
		const cutoff = new Date(nowMs - graceMs).toISOString();
		const rows = await database
			.select({
				channelId: chatObjects.channelId,
				chatKind: chatObjects.kind,
				contentText: messages.contentText,
				id: messages.id,
				occurredAt: messages.occurredAt,
				platformConversationId: chatObjects.platformConversationId,
				platformMessageId: messages.platformMessageId,
				partsJson: messages.partsJson,
				sessionId: messages.conversationId,
			})
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(
				and(
					eq(messages.direction, "outbound"),
					eq(messages.deliveryStatus, "pending"),
					lt(messages.occurredAt, cutoff),
				),
			)
			.orderBy(asc(messages.occurredAt));
		let confirmed = 0;
		let uncertain = 0;
		let skipped = 0;
		for (const row of rows) {
			const chatKind = row.chatKind;
			const channelId = row.channelId;
			const platformConversationId = row.platformConversationId;
			if (!isExternalChat(chatKind) || channelId === null || platformConversationId === null) {
				await this.#markUncertain(database, row.id, row.sessionId, "no destination to reconcile", {
					channelId,
					platformConversationId,
				});
				uncertain += 1;
				continue;
			}
			const adapter = this.#channels.get(channelId);
			if (adapter === undefined || adapter.readHistory === undefined) {
				await this.#markUncertain(
					database,
					row.id,
					row.sessionId,
					"adapter has no read-history capability",
					{ channelId, platformConversationId },
				);
				uncertain += 1;
				continue;
			}
			let history: readonly ChannelHistoryItem[] = [];
			try {
				history = await adapter.readHistory(
					{ channelId, kind: chatKind, platformConversationId },
					{ limit: 50, sinceMs: nowMs - lookbackMs },
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.#logger.warn("pending delivery reconciliation read failed", {
					error: reason,
					messageId: row.id,
				});
				await this.#markUncertain(database, row.id, row.sessionId, reason, {
					channelId,
					platformConversationId,
				});
				uncertain += 1;
				continue;
			}
			const match = findReconciled(history, row.platformMessageId, row.contentText);
			if (match === undefined) {
				await this.#markUncertain(
					database,
					row.id,
					row.sessionId,
					"pending delivery was not confirmed in bounded lookback",
					{ channelId, platformConversationId, lookbackMs },
				);
				uncertain += 1;
				continue;
			}
			await database
				.update(messages)
				.set({
					deliveryStatus: "sent",
					platformMessageId: match.platformMessageId,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messages.id, row.id));
			await this.#audit({
				action: "message.reconcile-sent",
				payload: {
					platformConversationId,
					platformMessageId: match.platformMessageId,
				},
				result: "ok",
				targetId: row.sessionId,
				targetKind: "session",
			});
			confirmed += 1;
		}
		if (uncertain > 0) {
			this.#logger.warn("pending deliveries reconciled as uncertain", {
				confirmed,
				skipped,
				uncertain,
			});
		} else if (rows.length > 0) {
			this.#logger.debug("pending deliveries reconciled", {
				candidateCount: rows.length,
				confirmed,
				skipped,
				uncertain,
			});
		}
		return { confirmed, skipped, uncertain };
	}

	startPendingReconciliation(): void {
		if (this.#reconcileTimer !== undefined) return;
		this.#reconcileTimer = setInterval(() => {
			void this.reconcilePendingDeliveries().catch((error) => {
				this.#logger.warn("pending delivery reconciliation failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			void this.recoverUndispatchedAnswers().catch((error) => {
				this.#logger.warn("answer recovery failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, this.#reconcileIntervalMs);
		this.#reconcileTimer.unref?.();
	}

	/**
	 * Replay replies whose turn was admitted but whose answer never reached the outbound
	 * transcript.
	 *
	 * Correctness comes from two durable records, never from transcript history:
	 *
	 * - The reply expectation is written *before* the durable submission exists, so a crash
	 *   between "answer committed" and "observer claimed it" is still covered.
	 * - Recovery resolves that exact submission by request id and dispatches only its terminal
	 *   `answer` entry. Intermediate assistant entries, suppressed markers, and answers belonging
	 *   to turns that were already handled are never candidates, so nothing is re-sent by
	 *   inference.
	 *
	 * Every pending expectation is visited regardless of conversation age or activity, so a long
	 * backlog or many idle conversations cannot starve recovery. `handleAnswer` still claims a
	 * `reply_dispatch_intents` row and the outbound unique index keeps the send at-most-once, so
	 * repeated sweeps and repeated boots are idempotent.
	 */
	async recoverUndispatchedAnswers(): Promise<RecoverAnswersResult> {
		const database = this.#database();
		const resolveAnswer = this.#resolveAnswer;
		if (database === undefined || resolveAnswer === undefined) {
			return { conversations: 0, recovered: 0, skipped: 0 };
		}
		await this.#reportUnrecoverableLegacyIntents(database);
		// Every conversation with a pending expectation, with no recency or count window.
		const conversationIds = await this.#expectations.pendingConversationIds();
		let recovered = 0;
		let skipped = 0;
		for (const sessionId of conversationIds) {
			const [conversation] = await database
				.select({
					channelId: chatObjects.channelId,
					chatKind: chatObjects.kind,
					durableConversationId: conversations.durableConversationId,
				})
				.from(conversations)
				.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
				.where(eq(conversations.id, sessionId))
				.limit(1);
			if (conversation === undefined) continue;
			const durableConversationId = conversation.durableConversationId;
			if (durableConversationId.length === 0) continue;
			// An external answer cannot be sent while its channel is down. Leave the expectation
			// pending (nothing is claimed) so a later sweep retries it instead of losing it.
			if (isExternalChat(conversation.chatKind)) {
				const adapter =
					conversation.channelId === null ? undefined : this.#channels.get(conversation.channelId);
				if (adapter === undefined || adapter.diagnostics().connected !== true) {
					skipped += 1;
					continue;
				}
			}
			const expectations = await this.#expectations.pending(sessionId);
			for (const expectation of expectations) {
				let outcome: "done" | "recovered" | "skipped";
				try {
					outcome = await this.#recoverExpectation({
						durableConversationId,
						expectation,
						resolveAnswer,
						sessionId,
					});
				} catch (error) {
					// One conversation's failure must not starve every other pending expectation;
					// the row stays pending and a later sweep retries it.
					this.#logger.warn("answer recovery failed for one expectation", {
						conversationId: durableConversationId,
						error: error instanceof Error ? error.message : String(error),
						submissionRequestId: expectation.submissionRequestId,
					});
					outcome = "skipped";
				}
				if (outcome === "recovered") recovered += 1;
				else if (outcome === "skipped") skipped += 1;
			}
		}
		if (recovered > 0 || skipped > 0) {
			this.#logger.debug("answer recovery sweep finished", {
				conversations: conversationIds.length,
				recovered,
				skipped,
			});
		}
		return { conversations: conversationIds.length, recovered, skipped };
	}

	/**
	 * Report claimed dispatch rows that predate reply expectations.
	 *
	 * The old ledger recorded only `(conversationId, durableEntryId)`, which carries no
	 * submission request id. Replaying them would require scanning transcript history and could
	 * resend suppressed or intermediate answers, so they are deliberately not recovered. They are
	 * counted once per process so an operator knows a reply from before the upgrade may be lost
	 * instead of assuming recovery covered it.
	 */
	async #reportUnrecoverableLegacyIntents(database: TsukaimaDatabase): Promise<void> {
		if (this.#legacyIntentReported) return;
		this.#legacyIntentReported = true;
		const orphans = await database
			.select({ sessionId: replyDispatchIntents.conversationId })
			.from(replyDispatchIntents)
			.where(eq(replyDispatchIntents.state, "claimed"));
		if (orphans.length === 0) return;
		const sessions = [...new Set(orphans.map((row) => row.sessionId))];
		this.#logger.warn(
			"claimed dispatch intents without a reply expectation cannot be replayed safely",
			{ count: orphans.length, sessions: sessions.length },
		);
		await this.#audit({
			action: "message.answer-recovery-unavailable",
			actorKind: "system",
			payload: { conversations: sessions.length, intents: orphans.length },
			reason: "legacy_dispatch_intents_have_no_submission_request_id",
			result: "denied",
			targetId: "reply-dispatch",
			targetKind: "session",
		});
	}

	/** Recover one expected turn. Returns whether it produced work or was deliberately skipped. */
	async #recoverExpectation(input: {
		readonly durableConversationId: string;
		readonly expectation: ReplyExpectation;
		readonly resolveAnswer: NonNullable<ReplyDispatcherOptions["resolveAnswer"]>;
		readonly sessionId: string;
	}): Promise<"done" | "recovered" | "skipped"> {
		const { durableConversationId, expectation, resolveAnswer, sessionId } = input;
		let resolution: Awaited<ReturnType<typeof resolveAnswer>>;
		try {
			resolution = await resolveAnswer(durableConversationId, expectation.submissionRequestId);
		} catch (error) {
			this.#logger.warn("durable submission resolution failed", {
				conversationId: durableConversationId,
				error: error instanceof Error ? error.message : String(error),
				submissionRequestId: expectation.submissionRequestId,
			});
			return "skipped";
		}
		if (resolution.status === "missing") {
			// The expectation is written immediately before the durable commit, so a missing
			// submission is either still in flight or a turn that never started. Only the latter
			// may be abandoned, and the store applies the TTL.
			await this.#expectations.abandonIfStale({
				conversationId: sessionId,
				submissionRequestId: expectation.submissionRequestId,
			});
			return "skipped";
		}
		if (resolution.status === "pending") {
			// Queued behind a busy run, still running, or its answer is not visible yet. Retry on a
			// later sweep; queued turns keep their place in the durable queue.
			return "skipped";
		}
		if (resolution.status === "unanswered") {
			await this.#expectations.settle({
				conversationId: sessionId,
				detail: resolution.reason,
				state: "abandoned",
				submissionRequestId: expectation.submissionRequestId,
			});
			await this.#audit({
				action: "message.answer-recovered",
				actorKind: "system",
				payload: {
					reason: resolution.reason,
					submissionRequestId: expectation.submissionRequestId,
				},
				result: "denied",
				targetId: sessionId,
				targetKind: "session",
			});
			return "skipped";
		}
		await this.#expectations.recordAnswer({
			conversationId: sessionId,
			durableEntryId: resolution.entryId,
			submissionRequestId: expectation.submissionRequestId,
		});
		if (await this.#alreadyDispatched(sessionId, resolution.entryId)) {
			await this.#settleIntent(this.#databaseOrThrow(), sessionId, resolution.entryId);
			await this.#expectations.settle({
				conversationId: sessionId,
				durableEntryId: resolution.entryId,
				state: "settled",
				submissionRequestId: expectation.submissionRequestId,
			});
			return "done";
		}
		const background = expectation.kind === "background";
		const consumed = background ? consumeProactiveMarkers(resolution.text) : undefined;
		// The plugin suppresses the whole turn whenever a proactive marker is present, even when
		// some text remains after it. Recovery must make the same decision instead of sending a
		// fragment the original process deliberately withheld.
		if (background && consumed?.marker !== undefined) {
			// A schedule-later marker is a durable obligation, not silence. Hand it back to the
			// originating plugin before settling; if that handoff cannot be persisted, leave the
			// expectation pending so a later sweep retries instead of silently dropping it.
			if (consumed.marker === "schedule-later") {
				if (expectation.sourcePluginId === null || expectation.sourceFollowUpKind === null) {
					await this.#expectations.settle({
						conversationId: sessionId,
						detail: "marker_schedule-later_missing_plugin_origin",
						durableEntryId: resolution.entryId,
						state: "abandoned",
						submissionRequestId: expectation.submissionRequestId,
					});
					await this.#audit({
						action: "message.answer-recovered",
						actorKind: "system",
						payload: {
							entryId: resolution.entryId,
							reason: "missing_plugin_origin",
							submissionRequestId: expectation.submissionRequestId,
						},
						result: "denied",
						targetId: sessionId,
						targetKind: "session",
					});
					return "skipped";
				}
				const followUps = this.#followUps;
				if (followUps === undefined) return "skipped";
				try {
					await followUps.record({
						conversationId: sessionId,
						delayMs: consumed.scheduleLaterMs ?? 30 * 60_000,
						followUpKind: expectation.sourceFollowUpKind,
						pluginId: expectation.sourcePluginId,
						...(expectation.sourceTaskId === null
							? {}
							: { sourceTaskId: expectation.sourceTaskId }),
						submissionRequestId: expectation.submissionRequestId,
					});
				} catch (error) {
					this.#logger.warn("recovered follow-up intent could not be recorded", {
						conversationId: durableConversationId,
						error: error instanceof Error ? error.message : String(error),
						pluginId: expectation.sourcePluginId,
						submissionRequestId: expectation.submissionRequestId,
					});
					return "skipped";
				}
				await this.#expectations.settle({
					conversationId: sessionId,
					detail: "marker_schedule-later",
					durableEntryId: resolution.entryId,
					state: "suppressed",
					submissionRequestId: expectation.submissionRequestId,
				});
				await this.#audit({
					action: "message.answer-recovered",
					actorKind: "system",
					payload: {
						entryId: resolution.entryId,
						reason: "marker_schedule-later",
						submissionRequestId: expectation.submissionRequestId,
					},
					result: "ok",
					targetId: sessionId,
					targetKind: "session",
				});
				return "recovered";
			}
			// Skip and lurk markers are deliberate silence with no follow-up obligation.
			await this.#expectations.settle({
				conversationId: sessionId,
				detail: `marker_${consumed.marker}`,
				durableEntryId: resolution.entryId,
				state: "suppressed",
				submissionRequestId: expectation.submissionRequestId,
			});
			await this.#audit({
				action: "message.answer-recovered",
				actorKind: "system",
				payload: {
					entryId: resolution.entryId,
					reason: `marker_${consumed.marker}`,
					submissionRequestId: expectation.submissionRequestId,
				},
				result: "denied",
				targetId: sessionId,
				targetKind: "session",
			});
			return "skipped";
		}
		const text = consumed?.text ?? resolution.text;
		if (text.length === 0) {
			await this.#expectations.settle({
				conversationId: sessionId,
				detail: "empty_output",
				durableEntryId: resolution.entryId,
				state: "suppressed",
				submissionRequestId: expectation.submissionRequestId,
			});
			return "skipped";
		}
		const outcome = await this.handleAnswer({
			conversationId: durableConversationId,
			entryId: resolution.entryId,
			recovered: true,
			submissionRequestId: expectation.submissionRequestId,
			text,
			...(resolution.truncated === true ? { truncated: true } : {}),
		});
		if (outcome?.deliveryStatus === "sent") {
			await this.#expectations.settle({
				conversationId: sessionId,
				durableEntryId: resolution.entryId,
				state: "settled",
				submissionRequestId: expectation.submissionRequestId,
			});
			await this.#audit({
				action: "message.answer-recovered",
				actorKind: "system",
				payload: { entryId: resolution.entryId },
				result: "ok",
				targetId: sessionId,
				targetKind: "session",
			});
			this.#logger.info("undispatched answer recovered", {
				conversationId: durableConversationId,
				entryId: resolution.entryId,
				sessionId,
			});
			return "recovered";
		}
		// Any terminal dispatch outcome (sent, failed, uncertain, suppressed, duplicate) settles
		// the expectation: the outbound row's `deliveryStatus` carries the truth from here on.
		// Retrying would risk a second send, which at-most-once delivery forbids.
		await this.#expectations.settle({
			conversationId: sessionId,
			...(outcome?.reason === undefined ? {} : { detail: outcome.reason }),
			durableEntryId: resolution.entryId,
			state: outcome?.deliveryStatus === "suppressed" ? "suppressed" : "settled",
			submissionRequestId: expectation.submissionRequestId,
		});
		await this.#audit({
			action: "message.answer-recovered",
			actorKind: "system",
			payload: { entryId: resolution.entryId, status: outcome?.deliveryStatus ?? "missing" },
			...(outcome?.reason === undefined ? {} : { reason: outcome.reason }),
			result: "denied",
			targetId: sessionId,
			targetKind: "session",
		});
		return "skipped";
	}

	async #alreadyDispatched(sessionId: string, entryId: string): Promise<boolean> {
		const database = this.#databaseOrThrow();
		const [row] = await database
			.select({ id: messages.id })
			.from(messages)
			.where(and(eq(messages.conversationId, sessionId), eq(messages.durableEntryId, entryId)))
			.limit(1);
		return row !== undefined;
	}

	#databaseOrThrow(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	/** Claim the durable dispatch intent for one answer before any send or outbound insert. */
	async #insertOutbound(
		database: TsukaimaDatabase,
		values: typeof messages.$inferInsert,
	): Promise<{ id: string }[]> {
		return database
			.insert(messages)
			.values(values)
			.onConflictDoNothing()
			.returning({ id: messages.id });
	}

	async #claimIntent(
		database: TsukaimaDatabase,
		sessionId: string,
		entryId: string,
	): Promise<"claimed" | "settled"> {
		const now = this.#now();
		const existing = await database
			.select({ state: replyDispatchIntents.state })
			.from(replyDispatchIntents)
			.where(
				and(
					eq(replyDispatchIntents.conversationId, sessionId),
					eq(replyDispatchIntents.durableEntryId, entryId),
				),
			)
			.limit(1);
		if (existing[0]?.state === "settled") return "settled";
		await database
			.insert(replyDispatchIntents)
			.values({
				claimedAtMs: now,
				conversationId: sessionId,
				durableEntryId: entryId,
				messageId: null,
				state: "claimed",
				updatedAtMs: now,
			})
			.onConflictDoUpdate({
				set: { updatedAtMs: now },
				target: [replyDispatchIntents.conversationId, replyDispatchIntents.durableEntryId],
			});
		return "claimed";
	}

	async #settleIntent(
		database: TsukaimaDatabase,
		sessionId: string,
		entryId: string,
	): Promise<void> {
		await database
			.update(replyDispatchIntents)
			.set({ state: "settled", updatedAtMs: this.#now() })
			.where(
				and(
					eq(replyDispatchIntents.conversationId, sessionId),
					eq(replyDispatchIntents.durableEntryId, entryId),
				),
			);
	}

	stopPendingReconciliation(): void {
		if (this.#reconcileTimer === undefined) return;
		clearInterval(this.#reconcileTimer);
		this.#reconcileTimer = undefined;
	}

	async #markUncertain(
		database: TsukaimaDatabase,
		messageId: string,
		sessionId: string,
		reason: string,
		payload: unknown,
	): Promise<void> {
		await database
			.update(messages)
			.set({ deliveryStatus: "uncertain", updatedAt: new Date().toISOString() })
			.where(eq(messages.id, messageId));
		await this.#audit({
			action: "message.reconcile-uncertain",
			payload,
			reason,
			result: "failed",
			targetId: sessionId,
			targetKind: "session",
		});
		this.#logger.warn("pending delivery marked uncertain", { messageId, reason, sessionId });
	}

	async #deliver(
		database: TsukaimaDatabase,
		target: DeliveryTarget,
	): Promise<"failed" | "sent" | "uncertain"> {
		const { channelId, platformConversationId } = target;
		if (channelId === null || platformConversationId === null) {
			return this.#fail(database, target.id, target.sessionId, "External chat has no destination", {
				channelId,
				platformConversationId,
			});
		}
		// Delivery sleeps (typing, pre-reply delay, `sendIntervalMs`) run on the per-conversation
		// outbound lane, never under the conversation execution lock: an inbound `host.append` must
		// not stall behind a multi-bubble send burst. The lane still keeps bubbles of consecutive
		// deliveries (narration, then the final answer) in order.
		return this.#runOutboundLane(
			target.conversationId,
			() => this.#deliverNow(database, target, channelId, platformConversationId),
			() => this.#dropStaleDelivery(database, target),
		);
	}

	/** A queued lane item of a cancelled turn: own the durable row, but never send it. */
	async #dropStaleDelivery(database: TsukaimaDatabase, target: DeliveryTarget): Promise<"failed"> {
		await database
			.update(messages)
			.set({ deliveryStatus: "failed", updatedAt: new Date().toISOString() })
			.where(eq(messages.id, target.id));
		await this.#audit({
			action: "message.cancel-output",
			actorKind: "agent",
			payload: {
				chatKind: target.chatKind,
				platformConversationId: target.platformConversationId,
				reason: "stale_lane_item",
				remainingUnits: target.units.length,
			},
			result: "ok",
			targetId: target.sessionId,
			targetKind: "session",
		});
		this.#logger.info("stale outbound lane item dropped", {
			conversationId: target.conversationId,
			messageId: target.id,
			sessionId: target.sessionId,
		});
		return "failed";
	}

	/** Body of {@link ReplyDispatcher.#deliver}; callers must already be on the outbound lane. */
	async #deliverNow(
		database: TsukaimaDatabase,
		target: DeliveryTarget,
		channelId: string,
		platformConversationId: string,
	): Promise<"failed" | "sent" | "uncertain"> {
		const startedAt = performance.now();
		const controller = new AbortController();
		const typing = target.policy.pacing.typingEnabled && target.narration !== true;
		this.#pendingOutput.set(target.conversationId, controller);
		const replyTo = this.#replyAsQuote
			? await this.#quoteTarget(database, target.sessionId, target.chatKind)
			: undefined;
		let firstPlatformMessageId: string | null = null;
		let sentCount = 0;
		const failures: string[] = [];
		try {
			if (typing) {
				await this.#channels.sendTyping(channelId, target.chatKind, platformConversationId, true);
			}
			const totalTextChars = target.parts.reduce(
				(sum, part) => sum + (part.type === "text" ? part.text.length : 0),
				0,
			);
			const delayMs =
				target.narration === true
					? 0
					: shapedReplyDelayMs({
							delayCurveEnabled: target.policy.humanization.delayCurveEnabled,
							nowMs: this.#now(),
							pacing: target.policy.pacing,
							random: this.#random,
							textLength: totalTextChars,
						});
			this.#logger.trace("delivering reply to channel", {
				channelId,
				chatKind: target.chatKind,
				delayMs,
				planItems: target.plan.length,
				platformConversationId,
				sessionId: target.sessionId,
				unitCount: target.units.length,
			});
			if (delayMs > 0) await this.#sleep(delayMs, controller.signal);
			let replyTargetSent = false;
			const sendChunk = async (chunk: readonly MessagePart[]) => {
				if (controller.signal.aborted) throw new OutputCancelledError();
				const result = await this.#channels.send(
					channelId,
					target.chatKind,
					platformConversationId,
					chunk,
					replyTo !== undefined && !replyTargetSent
						? { replyToPlatformMessageId: replyTo }
						: undefined,
				);
				replyTargetSent = true;
				if (firstPlatformMessageId === null && result.platformMessageId !== undefined) {
					firstPlatformMessageId = result.platformMessageId;
				}
				sentCount += 1;
			};
			for (const [itemIndex, item] of target.plan.entries()) {
				const chunks = splitMessageParts(item.parts, this.#splitMaxChars).filter(
					(chunk) => chunk.length > 0,
				);
				for (const [chunkIndex, chunk] of chunks.entries()) {
					try {
						await sendChunk(chunk);
					} catch (error) {
						if (error instanceof OutputCancelledError) throw error;
						const reason = error instanceof Error ? error.message : String(error);
						failures.push(reason);
						this.#logger.warn("reply chunk delivery failed; continuing with remaining output", {
							channelId,
							chunkIndex,
							itemIndex,
							reason,
							sentCount,
							sessionId: target.sessionId,
						});
					}
					if (
						target.policy.pacing.sendIntervalMs > 0 &&
						(itemIndex < target.plan.length - 1 || chunkIndex < chunks.length - 1)
					) {
						await this.#sleep(target.policy.pacing.sendIntervalMs, controller.signal);
					}
				}
			}
			if (failures.length > 0) {
				// A failed chunk must not discard the rest of the reply. Keep sending the remaining
				// text and media, then report the logical message as partial.
				const firstFailure = failures[0] ?? "unknown send failure";
				const deliveryStatus =
					sentCount > 0 || failures.some((reason) => /timeout/i.test(reason))
						? "uncertain"
						: "failed";
				await database
					.update(messages)
					.set({
						deliveryStatus,
						platformMessageId: firstPlatformMessageId,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(messages.id, target.id));
				await this.#audit({
					action: "message.send-reply",
					payload: {
						chatKind: target.chatKind,
						failedCount: failures.length,
						platformConversationId,
						sentCount,
						unitCount: target.units.length,
					},
					reason: firstFailure,
					result: "failed",
					targetId: target.sessionId,
					targetKind: "session",
				});
				this.#logger.warn("assistant reply partially delivered", {
					channelId,
					chatKind: target.chatKind,
					deliveryStatus,
					failedCount: failures.length,
					firstFailure,
					platformConversationId,
					sentCount,
					sessionId: target.sessionId,
				});
				return deliveryStatus;
			}
			await database
				.update(messages)
				.set({
					deliveryStatus: "sent",
					platformMessageId: firstPlatformMessageId,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messages.id, target.id));
			await this.#audit({
				action: "message.send-reply",
				payload: {
					chatKind: target.chatKind,
					platformConversationId,
					sentCount,
					unitCount: target.units.length,
				},
				result: "ok",
				targetId: target.sessionId,
				targetKind: "session",
			});
			this.#logger.debug("reply delivered to channel", {
				channelId,
				chatKind: target.chatKind,
				durationMs: Math.round(performance.now() - startedAt),
				platformConversationId,
				sentCount,
				sessionId: target.sessionId,
			});
			return "sent";
		} catch (error) {
			if (error instanceof OutputCancelledError) {
				const deliveryStatus = sentCount === 0 ? "failed" : "uncertain";
				await database
					.update(messages)
					.set({
						deliveryStatus,
						platformMessageId: firstPlatformMessageId,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(messages.id, target.id));
				await this.#audit({
					action: "message.cancel-output",
					payload: {
						chatKind: target.chatKind,
						platformConversationId,
						remainingUnits: target.units.length,
						sentCount,
					},
					reason: "superseded by new inbound activity",
					result: "ok",
					targetId: target.sessionId,
					targetKind: "session",
				});
				this.#logger.info("assistant reply delivery cancelled", {
					sentCount,
					sessionId: target.sessionId,
				});
				return deliveryStatus;
			}
			const message = error instanceof Error ? error.message : String(error);
			return this.#fail(database, target.id, target.sessionId, message, {
				chatKind: target.chatKind,
				platformConversationId,
			});
		} finally {
			if (typing) {
				await this.#channels.sendTyping(channelId, target.chatKind, platformConversationId, false);
			}
			if (this.#pendingOutput.get(target.conversationId) === controller) {
				this.#pendingOutput.delete(target.conversationId);
			}
		}
	}

	async #quoteTarget(
		database: TsukaimaDatabase,
		sessionId: string,
		chatKind: "private" | "group",
	): Promise<string | undefined> {
		const [row] = await database
			.select({ platformMessageId: messages.platformMessageId })
			.from(messages)
			.where(and(eq(messages.conversationId, sessionId), eq(messages.direction, "inbound")))
			.orderBy(desc(messages.occurredAt))
			.limit(1);
		if (row?.platformMessageId === null || row === undefined) {
			this.#logger.debug("quote requested but no inbound platform id is available", { chatKind });
			return undefined;
		}
		return row.platformMessageId;
	}

	async #fail(
		database: TsukaimaDatabase,
		messageId: string,
		sessionId: string,
		reason: string,
		payload: unknown,
	): Promise<"failed" | "uncertain"> {
		const deliveryStatus = /timeout/i.test(reason) ? "uncertain" : "failed";
		await database
			.update(messages)
			.set({ deliveryStatus, updatedAt: new Date().toISOString() })
			.where(eq(messages.id, messageId));
		this.#logger.warn("assistant reply could not be delivered", { reason, sessionId });
		await this.#audit({
			action: "message.send-reply",
			payload,
			reason,
			result: "failed",
			targetId: sessionId,
			targetKind: "session",
		});
		return deliveryStatus;
	}
}

class OutputCancelledError extends Error {
	constructor() {
		super("Output cancelled");
		this.name = "OutputCancelledError";
	}
}

function findReconciled(
	history: readonly ChannelHistoryItem[],
	platformMessageId: string | null,
	contentText: string | null,
): ChannelHistoryItem | undefined {
	if (platformMessageId !== null && platformMessageId.length > 0) {
		const exact = history.find((item) => item.platformMessageId === platformMessageId);
		if (exact !== undefined) return exact;
	}
	const expected = contentText?.trim();
	if (expected === undefined || expected.length === 0) return undefined;
	return history.find((item) => {
		const actual = item.text?.trim();
		if (actual === undefined || actual.length === 0) return false;
		return actual === expected || actual.includes(expected) || expected.includes(actual);
	});
}
