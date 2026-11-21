import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Tool } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	estimateMessageTokens,
	estimateTextTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import {
	AgentDoc,
	CompactionEntry,
	createRegistry,
	DEFAULT_COMPACTION_POLICY,
	defineDocFamily,
	Harness,
	LiveDoc,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type Extension,
	type Harness as DurableHarness,
	type JsonObject,
	type LiveState,
	type ModelRef,
	type RunFailure,
	type Submission,
	type SubmissionId,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
	type ActivityAggregationPolicy,
	type ConversationPolicy,
	type MessagePart,
	conversationPolicyFromActivityAggregation,
	conversationPolicySchema,
	defaultConversationPolicy,
	durableDocumentKinds,
	messagePartSchema,
	messagePartText,
	messagePartsText,
	type MessageEnvelope,
	type TriggerClassification,
} from "@tsukaima/contracts";
import type { SqliteStorage } from "@tsukaima/durable";
import {
	collectRunInputs,
	collectRunTriggers,
	createContextExtension,
	PERSONA_SECTION_KEY,
	SYSTEM_SECTION_KEY,
	POLICY_SECTION_KEY,
	renderTurnContextBlock,
	TURN_CONTEXT_MEMO,
	TURN_CONTEXT_SECTION_PREFIX,
	TURN_CONTEXT_TAG,
	TURN_MEMORIES_KEY,
	turnContextCacheKey,
	type ContextPromptProvider,
	type TurnContextSnapshot,
	type TurnTrigger,
} from "./context.ts";
import {
	applyMentionLabels,
	envelopeHeader,
	formatEnvelopeLine,
	type RenderableEnvelope,
	type TurnFormatOptions,
} from "./turn-format.ts";
import {
	ConversationExecutionLock,
	defaultConversationExecutionLock,
	withConversationLock,
} from "./execution-lock.ts";
import { createFallbackCoreLogger, previewText, type CoreLogger } from "./logger.ts";
import { createFakeModel, type ModelPort } from "./model.ts";
import { busyDisposition, directFlushDecision } from "./output-pacing.ts";
import {
	createChatRunExtension,
	type ChatRunExtensionOptions,
	type ConversationNarration,
} from "./run-hooks.ts";
import type { BusyArbiter, BusyArbitrationResult } from "./busy-arbiter.ts";
import type { ConversationGatePort } from "./gate.ts";
import { shouldInterject, type FastLaneInterjector, type FastLaneReply } from "./interject.ts";
import { shouldCloseActivityWindow } from "./index.ts";

/** Platform id of the triggering envelope's sender, tolerant of stored JSON shapes. */
function senderExternalId(envelope: StoredEnvelope | undefined): string | undefined {
	const sender = envelope?.sender;
	if (typeof sender !== "object" || sender === null) return undefined;
	const platformId =
		"platformId" in sender && typeof sender.platformId === "string" ? sender.platformId : undefined;
	if (platformId !== undefined && platformId.trim().length > 0) return platformId;
	const id = "id" in sender && typeof sender.id === "string" ? sender.id : undefined;
	return id !== undefined && id.trim().length > 0 ? id : undefined;
}

/**
 * Sender that triggered an admitted batch, or `undefined` when the batch mixes speakers.
 *
 * Binding a mixed batch to the last speaker would let that speaker's admin status authorize
 * tools on behalf of everyone in the window, so a mixed batch deliberately fails closed.
 */
function triggerSenderExternalId(envelopes: readonly StoredEnvelope[]): string | undefined {
	let trigger: string | undefined;
	for (const envelope of envelopes) {
		const sender = senderExternalId(envelope);
		if (sender === undefined) return undefined;
		if (trigger === undefined) {
			trigger = sender;
			continue;
		}
		if (sender !== trigger) return undefined;
	}
	return trigger;
}

type StoredEnvelope = JsonObject & {
	readonly id: string;
	readonly source: JsonObject & {
		readonly timestampMs: number;
		readonly receivedAtMs?: number;
	};
	/**
	 * Ephemeral routing info for the turn this envelope belongs to. Stored so recovery replays
	 * the same turn context, but never rendered into the durable user message.
	 */
	turnContext?: JsonObject & {
		classification?: "direct" | "soft" | "ambient";
		cue?: string;
		promptHooks?: string;
	};
	/**
	 * Durable context the caller explicitly attached (WebUI references, workspace handoff
	 * notes). Unlike `turnContext` it is part of the conversation and is rendered.
	 */
	attachedContext?: string;
	/**
	 * Legacy `Conversation trigger:` preamble written before Batch 1. Still parsed so pending
	 * windows survive an upgrade, but never rendered again.
	 */
	triggerContext?: string;
};

/**
 * Agent settings applied alongside a policy sync. `undefined` leaves the current value in
 * place, `null` resets it to the host default, and a concrete value overrides it.
 */
export interface ConversationAgentSettings {
	readonly model?: { readonly modelId: string; readonly providerId: string } | null;
	readonly thinkingLevel?: ModelThinkingLevel | null;
}

/**
 * Local observation time for a stored envelope, falling back to the platform timestamp for
 * envelopes persisted before `receivedAtMs` existed. Burst pacing must use the same clock
 * domain as `submittedAtMs`, which is local.
 */
/**
 * How often to read a conversation's live run while it is active. Durable commits a partial
 * answer every `progress.partialIntervalMs` (100ms by default), so a poll at that cadence sees
 * every committed partial without reading faster than the writer.
 */
const LIVE_RUN_POLL_MS = 100;
/**
 * Summary generation uses the compaction reserve as its output budget, so an explicit trigger
 * threshold still has to leave a usable reserve even when it sits at (or above) the window.
 */
const MIN_COMPACTION_RESERVE_TOKENS = 2_048;

/**
 * How long a poller waits for its run to appear before deciding the run already settled. The
 * activity flush admits the run and the scheduler starts it on a later turn, so the first polls
 * legitimately see no run.
 */
const LIVE_RUN_START_GRACE_MS = 2_000;

const envelopeObservedAtMs = (envelope: StoredEnvelope | undefined): number | undefined =>
	envelope?.source.receivedAtMs ?? envelope?.source.timestampMs;

type ActivityWindowDocument = JsonObject & {
	closedAtMs: number | null;
	envelopes: StoredEnvelope[];
	openedAtMs: number;
	status: "collecting" | "submitted" | "closed";
};

type ActivityWindowSeed = JsonObject & {
	conversationId: number;
	envelopes: StoredEnvelope[];
	openedAtMs: number;
};

type StoredConversationPolicy = JsonObject & {
	policyJson: string;
};

/**
 * One durable conversation has one activity document, but every submitted window is a
 * distinct input. `pi-durable` deduplicates submissions by `requestId`, so the request id
 * must change per window while the activity id stays stable for receipts and the UI.
 */
const ACTIVITY_REQUEST_SEPARATOR = "#";

export function activitySubmissionRequestId(activityId: string, envelopeId: string): string {
	return `${activityId}${ACTIVITY_REQUEST_SEPARATOR}${envelopeId}`;
}

export function activityIdFromSubmissionRequestId(requestId: string): string {
	const separator = requestId.lastIndexOf(ACTIVITY_REQUEST_SEPARATOR);
	return separator < 0 ? requestId : requestId.slice(0, separator);
}

type MessageReceiptDocument = JsonObject & {
	activityId: string;
	acceptedAtMs: number;
	messageId: string;
};

type MessageReceiptSeed = JsonObject & {
	activityId: string;
	acceptedAtMs: number;
	messageId: string;
};

const conversationPolicyDefinition = {
	kind: durableDocumentKinds.activityPolicy,
	version: 1,
	family: true,
	scope: "conversation",
	fork: "current",
	history: "latest",
	checkpointWhen: () => true,
	initial: (seed: JsonObject) => ({
		policyJson: JSON.stringify(conversationPolicySchema.parse(seed)),
	}),
} as const;

const conversationPolicyDoc = defineDocFamily<StoredConversationPolicy, JsonObject>(
	conversationPolicyDefinition,
);

const activityWindowDefinition = {
	kind: durableDocumentKinds.activityWindow,
	version: 1,
	family: true,
	scope: "conversation",
	fork: "current",
	history: "latest",
	checkpointWhen: () => true,
	initial: (seed: ActivityWindowSeed) => ({
		closedAtMs: null,
		envelopes: seed.envelopes,
		openedAtMs: seed.openedAtMs,
		status: "collecting" as const,
	}),
} as const;

const activityWindowDoc = defineDocFamily<ActivityWindowDocument, ActivityWindowSeed>(
	activityWindowDefinition,
);

const messageReceiptDefinition = {
	kind: "tsukaima.messageReceipt",
	version: 1,
	family: true,
	scope: "conversation",
	fork: "current",
	history: "latest",
	checkpointWhen: () => true,
	initial: (seed: MessageReceiptSeed) => ({
		activityId: seed.activityId,
		acceptedAtMs: seed.acceptedAtMs,
		messageId: seed.messageId,
	}),
} as const;

const messageReceiptDoc = defineDocFamily<MessageReceiptDocument, MessageReceiptSeed>(
	messageReceiptDefinition,
);

export type AppendConversationResult = {
	readonly activityId: string;
	readonly deduplicated: boolean;
	readonly messageId: string;
	readonly status: string;
};

export interface AppendConversationInput {
	/**
	 * Ephemeral per-turn routing info (soft cue, consumed prompt hooks). Delivered to the model
	 * through the turn-context hook only; never persisted into the durable user message.
	 */
	readonly turnContext?: TurnTrigger;
	/**
	 * Durable context explicitly attached by the caller (for example WebUI session references).
	 * Rendered before the message lines and kept in the transcript.
	 */
	readonly attachedContext?: string;
	readonly classification?: TriggerClassification;
	/** Collect only; the router uses this while a cooldown/rate limit is active. */
	readonly collectOnly?: boolean;
	readonly conversationId: string;
	readonly envelope: MessageEnvelope;
	readonly forceSubmit?: boolean;
	/** Stable submission request id; retries with the same id reuse the durable submission. */
	readonly requestId?: string;
	readonly submittedAtMs: number;
	readonly whenBusy?: "steer" | "follow-up";
}

/**
 * One settled assistant answer. Emitted by the host after an input run produced an
 * assistant entry, so the server can deliver it to the origin channel.
 */
export interface ConversationAnswer {
	/** Durable activity (submission request id) the answer belongs to; absent when recovered. */
	readonly activityId?: string;
	/** Durable conversation the answer was produced in. */
	readonly conversationId: string;
	/** Entry id of the assistant entry holding the answer text. */
	readonly entryId: string;
	/** True when the answer was replayed from durable storage after a restart. */
	readonly recovered?: boolean;
	/**
	 * Conversation-scoped durable submission request id that produced this answer. The server
	 * uses it to settle the reply expectation written before the turn was admitted.
	 */
	readonly submissionRequestId?: string;
	/** Concatenated text blocks of the assistant answer. */
	readonly text: string;
	/**
	 * True when the answer stopped on its output token limit and no continuation completed it.
	 * The dispatcher still delivers the text but records the truncation.
	 */
	readonly truncated?: boolean;
}

/**
 * Terminal state of one admitted submission, resolved by its durable request id.
 *
 * Recovery uses this instead of scanning the transcript: only the exact answer of a submission
 * the server expected to reply to is ever dispatched, so old, suppressed, and intermediate
 * assistant entries are never replayed.
 */
export type SubmissionAnswerResolution =
	| { readonly status: "missing" }
	| { readonly status: "pending" }
	| { readonly status: "unanswered"; readonly reason: string }
	| {
			readonly status: "answered";
			readonly entryId: string;
			readonly text: string;
			readonly truncated?: boolean;
	  };

/**
 * Activity-window transition for host consumers (the server forwards these to plugin
 * hooks). Ids use the durable conversation id space, matching `AdminEvent`.
 */
export interface ActivityWindowEvent {
	/** Durable activity id (`<conversationId>:activity`). */
	readonly activityId: string;
	/** Durable conversation the activity belongs to. */
	readonly conversationId: string;
	/** Envelopes in the window when the event fired. */
	readonly envelopeCount: number;
	readonly type: "opened" | "closed";
}

/**
 * One durable background/proactive turn. The caller owns marker handling and delivery so the
 * host stays policy-neutral; this method only produces an assistant answer in the same durable
 * conversation (persona, memory, and tool extensions still render normally).
 */
export interface BackgroundTurnInput {
	readonly conversationId: string;
	readonly kind: "scheduled" | "proactive";
	readonly prompt: string;
	/** Compact operational context placed before the prompt; never logged by the host. */
	readonly context?: string;
	/** Stable request id for idempotent retries. */
	readonly requestId?: string;
	/**
	 * Caller-owned origin metadata carried through admission so reply recovery can hand a
	 * deferred background follow-up back to the plugin that requested it.
	 */
	readonly origin?: BackgroundTurnOrigin;
}

export interface BackgroundTurnOrigin {
	readonly pluginId: string;
	readonly sourceTaskId?: string;
	readonly followUpKind?: string;
}

export interface BackgroundTurnResult {
	readonly activityId: string;
	readonly entryId: string;
	readonly requestId: string;
	/** Durable submission request id; settles the reply expectation the turn recorded. */
	readonly submissionRequestId: string;
	readonly text: string;
}

export interface DurableConversationHostOptions {
	/**
	 * Persona and memory prompt sections for every conversation. Sections render before each
	 * request; conversations that predate the extension are backfilled on their next append.
	 */
	readonly contextProvider?: ContextPromptProvider;
	/**
	 * Additional extensions (for example plugin tools) selected with every conversation.
	 * Existing conversations are backfilled on their next append when their stored agent does
	 * not already select them.
	 */
	readonly extensions?: readonly Extension[];
	/**
	 * Structured logger for ingestion, activity, answer, and background-turn events. Defaults
	 * to `createFallbackCoreLogger()`, which reports only errors to `console.error`.
	 */
	readonly logger?: CoreLogger;
	readonly model?: ModelPort;
	/**
	 * Fast classifier used when new messages arrive while a run is still working. Without it,
	 * busy handling stays transport-level (`steer`/`follow-up`) and never aborts a run.
	 */
	readonly busyArbiter?: BusyArbiter;
	/** Optional fail-open cheap pre-model gate (burst completion, group reply, proactive bubble). */
	readonly conversationGate?: ConversationGatePort;
	/**
	 * Optional out-of-band fast-lane interjection handler for direct urgent messages arriving while
	 * a long main turn is working. Never mutates or aborts the active main turn.
	 */
	readonly fastLaneInterjector?: FastLaneInterjector;
	/** Deliver an out-of-band fast-lane interjection reply without touching main-turn expectations. */
	readonly onFastLaneReply?: (reply: FastLaneReply) => Promise<void> | void;
	/** Optional bounded single-retry repetition rewrite check wired into `ChatRunExtension`. */
	readonly checkRepetitionRewrite?: ChatRunExtensionOptions["checkRepetitionRewrite"];
	/** Convenience for tests: deterministic fake-model replies, ignored when `model` is set. */
	readonly responses?: readonly string[];
	/** Observe activity-window opens and closes. Errors never affect message processing. */
	readonly onActivityEvent?: (event: ActivityWindowEvent) => void;
	/**
	 * Observe settled assistant answers. Called detached from `append()`/activity flush so a
	 * slow consumer never blocks ingestion; rejections are caught and logged, never surfaced.
	 */
	readonly onAnswer?: (answer: ConversationAnswer) => Promise<void> | void;
	/**
	 * Called immediately before a reply-producing submission is committed.
	 *
	 * The server persists a reply expectation here, so a crash after the answer commits but
	 * before any observer runs is still recoverable. A rejection aborts the submission: a turn
	 * must never start without a durable expectation of its reply.
	 */
	readonly onTurnAdmitted?: (turn: AdmittedTurn) => Promise<void> | void;
	/**
	 * Called before a background turn is committed, so its reply can be recovered if the process
	 * dies before the caller receives the result. Background answers need marker handling on
	 * replay, so the expectation records `kind: "background"`.
	 */
	readonly onBackgroundTurnAdmitted?: (turn: AdmittedTurn) => Promise<void> | void;
	/**
	 * Called exactly once when an admitted submission reaches a terminal state: a dispatched
	 * answer, empty final text, an interrupted/aborted run, `unanswered`, or a refused submit.
	 * Consumers key their per-submission state (the turn-bound sender) by
	 * `submissionRequestId`, so this is their only cleanup signal. Errors are logged, never
	 * retried.
	 */
	readonly onSubmissionSettled?: (event: {
		readonly conversationId: string;
		readonly preserveReplyState?: boolean;
		readonly submissionRequestId: string;
	}) => void;
	readonly policy?: ActivityAggregationPolicy;
	/** Shared execution lock; defaults to the host-wide lock. */
	readonly executionLock?: ConversationExecutionLock;
	/**
	 * Resolve a message part's bytes for the model, as a data URL or base64 payload. Images the
	 * model cannot see are just `[image]` placeholders, so a multimodal conversation needs this;
	 * without it the host falls back to text-only input.
	 */
	readonly resolveImage?: (
		part: MessagePart,
	) => Promise<{ data: string; mimeType: string } | undefined>;
	/**
	 * Observe the in-flight run of a conversation: streamed partial text, tool rounds, and the
	 * failure of a run that ended without answering. Fired detached from ingestion and from the
	 * durable commit that produced the change, so a slow consumer never blocks either.
	 */
	readonly onLiveRun?: (state: LiveRunSnapshot) => void;
	/**
	 * Receive mid-turn narration: assistant text written before a tool call, or the delivered
	 * prefix of an answer cut off by the output limit. Called from the generation hook, so the
	 * callback must not wait on the conversation lock; the dispatcher dedupes by `narrationId`.
	 */
	readonly onNarration?: (narration: ConversationNarration) => Promise<void> | void;
	/** Tools that post to the chat themselves; their message text is never narrated. */
	readonly isDirectSendTool?: (toolName: string) => boolean;
	/** True when this turn already delivered text through a direct send tool. */
	readonly hasDirectSend?: (conversationId: string) => boolean;
	/** How long a busy run may still be steered before a follow-up is queued. */
	readonly steerGraceMs?: number;
	/**
	 * IANA zone for the `[HH:mm]` stamps in durable user turns; defaults to the process zone.
	 * Tests pass a fixed zone so rendered transcripts are deterministic.
	 */
	readonly timeZone?: string;
	readonly storage: SqliteStorage;
}

/** One reply-producing submission about to be committed. */
export interface AdmittedTurn {
	/** Durable activity id (`<conversationId>:activity`). */
	readonly activityId: string;
	readonly conversationId: string;
	/**
	 * Platform id of the sender whose message completed the window and triggered this submission.
	 * The host binds it to the active turn so tool authorization never consults a later ambient
	 * message that arrived while the turn was running. Absent for background turns.
	 */
	readonly senderExternalId?: string;
	/** Conversation-scoped durable submission request id. */
	readonly submissionRequestId: string;
	/** Background-turn origin metadata; absent for ordinary chat turns. */
	readonly origin?: BackgroundTurnOrigin;
	/**
	 * True when the conversation already had a working run when this turn was admitted (a steer
	 * or follow-up joining it). Consumers must not reset per-turn presentation state for such a
	 * turn: the working run still owns it.
	 */
	readonly midRun?: boolean;
	/**
	 * Busy handling the submission was admitted with. `steer` joins the active run, so a steer
	 * from a different speaker makes the whole run mixed-speaker and must fail closed.
	 */
	readonly whenBusy?: "steer" | "follow-up";
}

/**
 * One observation of a conversation's live run, in the local clock domain. `undefined` means the
 * run settled: the caller clears whatever it was showing.
 */
function pinnedTurnContext(
	memos: Readonly<Record<string, unknown>> | undefined,
): TurnContextSnapshot | undefined {
	const raw = memos?.[TURN_CONTEXT_MEMO];
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as { renderedAtMs?: unknown; sections?: unknown };
	if (typeof record.renderedAtMs !== "number" || !Array.isArray(record.sections)) {
		return undefined;
	}
	const sections: { key: string; text: string }[] = [];
	for (const entry of record.sections) {
		if (typeof entry !== "object" || entry === null) continue;
		const section = entry as { key?: unknown; text?: unknown };
		if (typeof section.key !== "string" || typeof section.text !== "string") continue;
		sections.push({ key: section.key, text: section.text });
	}
	return { renderedAtMs: record.renderedAtMs, sections };
}

export type LiveRunSnapshot = {
	readonly conversationId: string;
	/**
	 * `true` when the run ended. The WebUI clears its activity view on this, which is why the
	 * end is explicit rather than inferred from empty fields: a run that has not streamed text
	 * yet looks identical to one that settled.
	 */
	readonly settled: boolean;
	readonly failure: string | undefined;
	/** Current generation attempt, starting at 1 and growing across retries. */
	readonly attempt: number | undefined;
	/** Provider timestamp of the generation's partial, which is when the request started. */
	readonly generationStartedAtMs: number | undefined;
	/** Selected provider and model, once the provider has named them in a partial. */
	readonly model: { readonly modelId: string; readonly providerId: string } | undefined;
	/** Durable backoff while the run waits to retry a failed model attempt. */
	readonly retry: { readonly at: number; readonly error: string } | undefined;
	/**
	 * Stable identity of the in-flight run. A run can be observed by a newer watcher while it
	 * continues (for example when an input steers the current run), so consumers must not use
	 * the watcher start time as a run identity. Absent for snapshots that carry no run.
	 */
	readonly runId?: string;
	/** Streamed answer text so far. */
	readonly partialText: string | undefined;
	/** Streamed reasoning so far, when the provider reports it. */
	readonly partialThinking: string | undefined;
	/** Tool calls the model is still emitting, before they start executing. */
	readonly draftTools: readonly {
		readonly argumentsText: string | undefined;
		readonly callId: string;
		readonly toolName: string;
	}[];
	readonly startedAtMs: number;
	readonly tools: readonly {
		readonly argumentsText: string | undefined;
		readonly callId: string;
		readonly output: string | undefined;
		readonly status: "pending" | "running" | "done";
		readonly toolName: string;
	}[];
	readonly turns: number;
};

export interface InspectConversationContextOptions {
	/**
	 * Tool names excluded by domain policy when `pi.agent.modelTools` has not been synced yet
	 * (for example, coding tools on a session that has not received a routed turn yet).
	 */
	readonly omittedTools?: readonly string[];
}

export interface ConversationContextInspection {
	readonly autocompact: {
		readonly backgroundTokens: number;
		readonly bufferTokens: number;
		readonly enabled: boolean;
		readonly keepRecentTokens: number;
	};
	readonly categories: {
		readonly memoriesTokens: number;
		readonly messagesTokens: number;
		readonly otherSystemTokens: number;
		readonly personaTokens: number;
		readonly policyTokens: number;
		readonly toolsTokens: number;
		/** Ephemeral per-request turn context other than recalled memories. */
		readonly turnContextTokens: number;
	};
	readonly compacted: boolean;
	readonly contextWindow: number;
	readonly deferredToolsTokens: number;
	readonly freeSpaceTokens: number;
	readonly measuredUsageTokens: number | null;
	readonly messageCount: number;
	readonly model: {
		readonly modelId: string;
		readonly providerId: string;
	};
	readonly sections: readonly {
		readonly key: string;
		readonly text: string;
		readonly tokens: number;
	}[];
	readonly tokenSource: "usage" | "estimated";
	readonly tools: readonly {
		readonly deferred: boolean;
		readonly description: string;
		readonly name: string;
		readonly tokens: number;
	}[];
	readonly usedPercent: number;
	readonly usedTokens: number;
}

export interface CompactConversationResult {
	readonly compacted: boolean;
	readonly entryId: string | null;
	readonly submissionId: string | null;
}

/**
 * Text of an assistant entry, mirroring what a channel reply needs. `undefined` for other
 * entry kinds or an answer with no text blocks.
 */
function assistantEntryText(entry: EntryRecord): string | undefined {
	if (entry.kind !== "pi.assistant" || entry.model === undefined) return undefined;
	const texts: string[] = [];
	for (const message of entry.model as readonly unknown[]) {
		if (typeof message !== "object" || message === null) continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content as readonly unknown[]) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "text") continue;
			if (!("text" in block) || typeof block.text !== "string") continue;
			texts.push(block.text);
		}
	}
	const text = texts.join("\n").trim();
	return text.length === 0 ? undefined : text;
}

/** Stop reason of the last assistant message an entry holds. */
function assistantEntryStopReason(entry: EntryRecord): string | undefined {
	if (entry.kind !== "pi.assistant" || entry.model === undefined) return undefined;
	const last = entry.model.findLast((message) => message.role === "assistant");
	return last?.role === "assistant" ? last.stopReason : undefined;
}

/** Text of the user message an input entry placed, when the entry carries one. */
function userEntryText(entry: EntryRecord): string | undefined {
	if (entry.model === undefined) return undefined;
	for (const message of entry.model) {
		if (message.role !== "user") continue;
		const text = stripTriggerContext(contentText(message.content)).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

/** Drop the routing contract the host prepends to an input; it is not conversation content. */
function stripTriggerContext(text: string): string {
	return text.replace(/^Conversation trigger:[\s\S]*?\n\n/u, "");
}

/** Bound a library call that has no timeout of its own. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), Math.max(1, timeoutMs));
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** A settled run: nothing to show, and the client clears its activity view. */
function emptyLiveRun(conversationId: string, startedAtMs: number): LiveRunSnapshot {
	return {
		attempt: undefined,
		conversationId,
		draftTools: [],
		failure: undefined,
		generationStartedAtMs: undefined,
		model: undefined,
		partialText: undefined,
		partialThinking: undefined,
		retry: undefined,
		settled: true,
		startedAtMs,
		tools: [],
		turns: 0,
	};
}

/**
 * Text of a streamed assistant partial. Durable stores the provider's `AssistantMessage`, whose
 * text lives in `content` blocks; tool-only partials yield `undefined` rather than an empty
 * string so the UI can tell "no text yet" from "an empty answer".
 */
function partialTextOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("content" in message) || !Array.isArray(message.content)) return undefined;
	const texts: string[] = [];
	for (const block of message.content as readonly unknown[]) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		texts.push(block.text);
	}
	const text = texts.join("");
	return text.length === 0 ? undefined : text;
}

/**
 * Streamed reasoning text of an assistant partial. Providers report it as `thinking` blocks
 * alongside the answer, and it is what makes an in-flight run readable: the tool calls alone
 * leave the reader guessing what the model is working out.
 */
function partialThinkingOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("content" in message) || !Array.isArray(message.content)) return undefined;
	const texts: string[] = [];
	for (const block of message.content as readonly unknown[]) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "thinking") continue;
		if (!("thinking" in block) || typeof block.thinking !== "string") continue;
		if (block.thinking.length === 0) continue;
		texts.push(block.thinking);
	}
	const text = texts.join("\n");
	return text.length === 0 ? undefined : text;
}

/** Short, log-safe description of why a run ended without an answer. */
function runFailureText(failure: RunFailure): string {
	const detail = failure.detail;
	return detail === undefined || detail.length === 0
		? failure.reason
		: `${failure.reason}: ${detail}`;
}

/** Compact single-line JSON of a tool call's arguments, bounded for the live view. */
function argumentsTextOf(argumentsValue: unknown): string | undefined {
	if (argumentsValue === undefined || argumentsValue === null) return undefined;
	let text: string;
	try {
		text = JSON.stringify(argumentsValue);
	} catch {
		return undefined;
	}
	if (text.length === 0 || text === "{}") return undefined;
	return text.length <= 400 ? text : `${text.slice(0, 400)}…`;
}

/** Tool calls already present in a streamed assistant partial, in model order. */
function draftToolsOf(message: unknown): LiveRunSnapshot["draftTools"] {
	if (typeof message !== "object" || message === null) return [];
	if (!("content" in message) || !Array.isArray(message.content)) return [];
	const tools: LiveRunSnapshot["draftTools"][number][] = [];
	for (const block of message.content as readonly unknown[]) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("id" in block) || typeof block.id !== "string") continue;
		if (!("name" in block) || typeof block.name !== "string" || block.name.length === 0) continue;
		const argumentsText = "arguments" in block ? argumentsTextOf(block.arguments) : undefined;
		tools.push({
			argumentsText,
			callId: block.id,
			toolName: block.name,
		});
	}
	return tools;
}

/** Provider/model named by a streamed assistant partial, or `undefined` before the first token. */
function modelOf(
	message: unknown,
): { readonly modelId: string; readonly providerId: string } | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("provider" in message) || typeof message.provider !== "string") return undefined;
	if (!("model" in message) || typeof message.model !== "string") return undefined;
	if (message.provider.length === 0 || message.model.length === 0) return undefined;
	return { modelId: message.model, providerId: message.provider };
}

/** When the provider started the in-flight request, from the partial's timestamp. */
function generationStartedAtOf(message: unknown): number | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("timestamp" in message) || typeof message.timestamp !== "number") return undefined;
	return Number.isFinite(message.timestamp)
		? Math.max(0, Math.floor(message.timestamp))
		: undefined;
}

/** Flatten durable live state into the snapshot the WebUI renders. */
function toLiveRunSnapshot(
	conversationId: string,
	startedAtMs: number,
	live: LiveState,
	knownArguments: ReadonlyMap<string, string>,
): LiveRunSnapshot {
	const message = live.generation?.message;
	const draftTools = draftToolsOf(message);
	const argumentByCall = new Map(knownArguments);
	for (const tool of draftTools) {
		if (tool.argumentsText !== undefined) argumentByCall.set(tool.callId, tool.argumentsText);
	}
	const tools = (live.tools ?? []).map((slot) => ({
		argumentsText: argumentByCall.get(slot.callId),
		callId: slot.callId,
		output: typeof slot.output === "string" ? slot.output : undefined,
		status: slot.status,
		toolName: slot.name,
	}));
	const retry = live.generation?.retry;
	const runId = live.run?.first === undefined ? undefined : String(live.run.first);
	return {
		attempt: live.generation?.attempt,
		conversationId,
		draftTools,
		failure: live.runFailure === undefined ? undefined : runFailureText(live.runFailure),
		generationStartedAtMs: generationStartedAtOf(message),
		model: modelOf(message),
		partialText: partialTextOf(message),
		partialThinking: partialThinkingOf(message),
		retry: retry === undefined ? undefined : { at: retry.at, error: retry.error },
		...(runId === undefined ? {} : { runId }),
		settled: false,
		startedAtMs,
		tools,
		turns: live.run?.turns ?? 0,
	};
}

export class PiDurableConversationHost {
	private harness?: DurableHarness;
	private model: ModelPort;
	private readonly logger: CoreLogger;
	private readonly policy: ConversationPolicy;
	private readonly executionLock: ConversationExecutionLock;
	private readonly steerGraceMs: number;
	private readonly activeRuns = new Map<string, Map<string, { startedAtMs: number }>>();
	private readonly activityTimers = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
	private readonly activityFlushes = new Set<string>();
	/**
	 * Pending windows held because a run is working. One entry per conversation; new messages
	 * extend the same hold instead of creating parallel waiters.
	 */
	private readonly busyHolds = new Map<
		string,
		{
			envelopeCount: number;
			since: number;
			timer?: ReturnType<typeof setTimeout>;
			updatedAt: number;
		}
	>();
	/** Recent interrupt timestamps for the per-minute ceiling. */
	private readonly interruptTimes = new Map<string, number[]>();
	/** One ephemeral snapshot per live run, shared across tool-round generation handovers. */
	private readonly turnContextSnapshots = new Map<string, TurnContextSnapshot>();
	private readonly contextExtension: Extension | undefined;
	private readonly toolSearchExtension: Extension;
	private readonly extensions = new Map<string, Extension>();
	private readonly dynamicExtensions = new Set<string>();
	private readonly extensionsEnsured = new Set<string>();
	private readonly modelsEnsured = new Set<string>();
	private readonly modelToolsSignatures = new Map<string, string>();
	/** In-flight activity flushes, so `close()` can wait for them before storage goes away. */
	private readonly pendingFlushes = new Set<Promise<void>>();
	/** Live-run pollers by conversation, so a settle or a close can stop them. */
	private readonly liveRuns = new Map<
		string,
		{ startedAtMs: number; timer: ReturnType<typeof setInterval> }
	>();
	/** Reads already dispatched by a poller, so `close()` waits instead of closing storage under them. */
	private readonly pendingPolls = new Set<Promise<void>>();
	private closed = false;
	readonly registry = createRegistry();

	constructor(private readonly options: DurableConversationHostOptions) {
		this.logger = options.logger ?? createFallbackCoreLogger();
		this.model =
			options.model ??
			createFakeModel(options.responses === undefined ? {} : { responses: options.responses });
		this.policy =
			options.policy === undefined
				? defaultConversationPolicy
				: conversationPolicyFromActivityAggregation(options.policy);
		this.executionLock = options.executionLock ?? defaultConversationExecutionLock;
		this.steerGraceMs = options.steerGraceMs ?? 3_000;
		this.contextExtension =
			options.contextProvider === undefined
				? undefined
				: createContextExtension(options.contextProvider, {
						resolveModel: (agentModel) => {
							const ref = this.effectiveModelRef(agentModel);
							return { modelId: ref.modelId, providerId: ref.provider };
						},
						turnContextCache: this.turnContextSnapshots,
					});
		if (this.contextExtension !== undefined) {
			this.extensions.set(this.contextExtension.name, this.contextExtension);
			this.registry.install(this.contextExtension);
		}
		// Deferred tools are invisible until the model loads them. Install the search tool for
		// every conversation so chat and coding share one discovery path.
		const toolSearchExtension = createToolSearchExtension();
		this.toolSearchExtension = toolSearchExtension;
		this.extensions.set(toolSearchExtension.name, toolSearchExtension);
		this.registry.install(toolSearchExtension);
		const chatRunExtension = createChatRunExtension({
			logger: this.logger,
			readPolicy: (conversationId) => this.readPolicy(Number(conversationId) as ConversationId),
			...(options.onNarration === undefined ? {} : { onNarration: options.onNarration }),
			...(options.isDirectSendTool === undefined
				? {}
				: { isDirectSendTool: options.isDirectSendTool }),
			...(options.hasDirectSend === undefined ? {} : { hasDirectSend: options.hasDirectSend }),
			...(options.checkRepetitionRewrite === undefined
				? {}
				: { checkRepetitionRewrite: options.checkRepetitionRewrite }),
		});
		this.extensions.set(chatRunExtension.name, chatRunExtension);
		this.registry.install(chatRunExtension);
		if (options.extensions !== undefined) this.installExtensions(options.extensions);
	}

	/** Replace the active model port at runtime and mark existing conversations for model sync. */
	setModel(model: ModelPort): void {
		this.model = model;
		this.modelsEnsured.clear();
	}

	/** Model that runs a conversation when no per-conversation or surface default is set. */
	get defaultModelRef(): { readonly modelId: string; readonly providerId: string } {
		return { modelId: this.model.modelId, providerId: this.model.providerId };
	}

	/** Resolve a provider-scoped model against the active port, or `undefined` when unavailable. */
	resolveModelRef(ref: {
		readonly modelId: string;
		readonly providerId?: string;
	}): { readonly modelId: string; readonly providerId: string } | undefined {
		const providerId = ref.providerId ?? this.model.providerId;
		const model = this.model.models.getModel(providerId, ref.modelId);
		return model === undefined ? undefined : { modelId: model.id, providerId: model.provider };
	}

	async createConversation(): Promise<string> {
		const harness = await this.openHarness();
		const extensions = [...this.extensions.values()];
		const agent: AgentChange = {
			model: { modelId: this.model.modelId, provider: this.model.providerId },
			...(extensions.length === 0 ? {} : { extensions: { add: extensions } }),
		};
		const conversation = await harness.createConversation(
			{
				agent,
				ownership: { kind: "ownerless" },
			},
			BACKGROUND_CONTEXT,
		);
		this.modelsEnsured.add(String(conversation.id));
		return String(conversation.id);
	}

	async append(input: AppendConversationInput): Promise<AppendConversationResult> {
		return withConversationLock(
			input.conversationId,
			() => this.appendLocked(input),
			this.executionLock,
		);
	}

	private async appendLocked(input: AppendConversationInput): Promise<AppendConversationResult> {
		const harness = await this.openHarness();
		const conversationId = Number(input.conversationId) as ConversationId;
		const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`Conversation not found: ${input.conversationId}`);
		await this.ensureExtensions(conversation, input.conversationId);
		await this.ensureAgentModel(conversation, input.conversationId);
		const existingReceipt = await harness.snapshot(
			messageReceiptDoc,
			conversationId,
			input.envelope.id,
			BACKGROUND_CONTEXT,
		);
		if (existingReceipt) {
			this.logger.debug("Conversation message deduplicated", {
				activityId: existingReceipt.activityId,
				conversationId: input.conversationId,
				messageId: existingReceipt.messageId,
			});
			return {
				activityId: existingReceipt.activityId,
				deduplicated: true,
				messageId: existingReceipt.messageId,
				status: "duplicate",
			};
		}
		const policy = await this.readPolicy(conversationId);
		if (!policy.enabled) throw new Error(`Conversation disabled: ${input.conversationId}`);
		const pacing = policy.pacing;
		const activityId = `${conversationId}:activity`;
		const window = await harness.snapshot(
			activityWindowDoc,
			conversationId,
			activityId,
			BACKGROUND_CONTEXT,
		);
		const envelopes: StoredEnvelope[] = window?.envelopes ?? [];
		const shouldOpen = !window || window.status !== "collecting";
		const storedEnvelope = this.toStoredEnvelope(input.envelope, input);
		const nextEnvelopes = shouldOpen ? [storedEnvelope] : [...envelopes, storedEnvelope];
		// Pacing compares against `submittedAtMs`, which is local. Envelope timestamps come from
		// the remote platform's clock, so using them here made the settle window unreachable
		// whenever the platform clock ran ahead. Prefer the locally observed time.
		const firstMessageAtMs = envelopeObservedAtMs(nextEnvelopes[0]) ?? input.submittedAtMs;
		const latestMessageAtMs = envelopeObservedAtMs(nextEnvelopes.at(-1)) ?? input.submittedAtMs;
		const messageText = messagePartsText(input.envelope.parts);
		// With the direct-flush heuristic enabled, length only shortcuts a direct address that is
		// not part of an active burst. Disabling it restores the legacy rule where any long
		// message submits at once.
		const directFlush = directFlushDecision({
			// Unclassified appends come from local surfaces (WebUI, tasks), which are always direct.
			classification: input.classification ?? "direct",
			pacing,
			previousMessageAtMs: shouldOpen ? undefined : envelopeObservedAtMs(envelopes.at(-1)),
			submittedAtMs: input.submittedAtMs,
			text: messageText,
		});
		const longMessage =
			!pacing.directFlushEnabled && messageText.length >= pacing.burstLongMessageThreshold;
		const windowClosed = shouldCloseActivityWindow(
			firstMessageAtMs,
			input.submittedAtMs,
			pacing,
			latestMessageAtMs,
		);
		const burstWantsSubmit =
			input.collectOnly !== true &&
			(nextEnvelopes.length >= pacing.burstMaxMessages ||
				directFlush.flush ||
				longMessage ||
				windowClosed);
		const arbitrationEnabled = policy.sidechat.enabled && this.options.busyArbiter !== undefined;
		let shouldSubmit = input.forceSubmit === true || burstWantsSubmit;
		// Optional fail-open burst-completion gate: hold the window when the gate says `WAIT` and
		// `burstMaxWaitMs` has not elapsed yet; errors/timeouts fall back to deterministic submit.
		if (
			shouldSubmit &&
			input.forceSubmit !== true &&
			!windowClosed &&
			nextEnvelopes.length < pacing.burstMaxMessages &&
			policy.gate.enabled &&
			policy.gate.burstCompletion &&
			this.options.conversationGate !== undefined &&
			input.submittedAtMs - firstMessageAtMs < pacing.burstMaxWaitMs
		) {
			const gateDecision = await this.options.conversationGate.decideBurstCompletion({
				conversationId: input.conversationId,
				elapsedMs: Math.max(0, input.submittedAtMs - firstMessageAtMs),
				envelopeCount: nextEnvelopes.length,
				messages: nextEnvelopes.map((env) => this.envelopeToText(env as MessageEnvelope)),
				policy: policy.gate,
			});
			if (gateDecision.decision === "WAIT") {
				shouldSubmit = false;
			}
		}
		let deferredWhileWorking = false;
		if (
			shouldSubmit &&
			input.forceSubmit !== true &&
			arbitrationEnabled &&
			// The in-process map avoids a live-document read on the hot path; after a restart it is
			// empty, so fall back to the durable run state before letting a long message through.
			(this.activeRunSince(input.conversationId) !== undefined ||
				(await this.runIsWorking(harness, conversationId)))
		) {
			shouldSubmit = false;
			deferredWhileWorking = true;
		}
		const activeSinceMs = this.activeRunSince(input.conversationId);
		// The run this submission joins is already working, so its per-turn presentation state
		// belongs to that run and must not be reset when this admission is observed.
		const midRun = activeSinceMs !== undefined;
		const disposition = busyDisposition(activeSinceMs, input.submittedAtMs, this.steerGraceMs);
		const whenBusy =
			input.whenBusy ??
			(disposition === "steer"
				? policy.steerWhenBusy === "reject"
					? "follow-up"
					: policy.steerWhenBusy === "follow-up"
						? "follow-up"
						: "steer"
				: policy.followUpWhenBusy === "reject"
					? "follow-up"
					: "follow-up");
		if (shouldSubmit) this.clearActivityTimer(input.conversationId);
		this.logger.debug("Conversation message appended", {
			burstSettleMs: pacing.burstSettleMs,
			busyDisposition: disposition,
			classification: input.classification,
			collectOnly: input.collectOnly === true,
			conversationId: input.conversationId,
			deferredWhileWorking,
			directFlush: directFlush.reason,
			envelopeCount: nextEnvelopes.length,
			messageId: input.envelope.id,
			shouldSubmit,
			whenBusy,
		});
		this.logger.debug(shouldOpen ? "Activity window opened" : "Activity window appended", {
			activityId,
			burstSettleMs: pacing.burstSettleMs,
			classification: input.classification,
			conversationId: input.conversationId,
			envelopeCount: nextEnvelopes.length,
		});
		this.logger.trace("Conversation envelope appended", {
			conversationId: input.conversationId,
			envelopePreview: previewText(this.envelopeToText(input.envelope)),
			messageId: input.envelope.id,
		});
		// The request id is deterministic, so it can be hoisted out of the commit closure: the
		// settlement hook needs the exact id even when the commit itself throws.
		const requestId = input.requestId ?? activitySubmissionRequestId(activityId, input.envelope.id);
		const triggerSenderId = shouldSubmit ? triggerSenderExternalId(nextEnvelopes) : undefined;
		let admitted = false;
		let submissionId: SubmissionId;
		try {
			submissionId = await conversation.commit(async (tx) => {
				const receipt = await tx.doc(messageReceiptDoc, conversationId, input.envelope.id, {
					activityId,
					acceptedAtMs: input.submittedAtMs,
					messageId: input.envelope.id,
				});
				receipt.activityId = activityId;
				receipt.acceptedAtMs = input.submittedAtMs;
				receipt.messageId = input.envelope.id;
				const document = await tx.doc(activityWindowDoc, conversationId, activityId, {
					conversationId,
					envelopes: nextEnvelopes,
					openedAtMs: input.submittedAtMs,
				});
				document.envelopes = nextEnvelopes;
				document.openedAtMs = shouldOpen ? input.submittedAtMs : window.openedAtMs;
				document.status = shouldSubmit ? "submitted" : "collecting";
				const entry = {
					kind: durableDocumentKinds.activityWindow,
					data: {
						activityId,
						envelopes: nextEnvelopes,
					},
				};
				if (shouldSubmit) {
					// Persist the reply expectation before the durable submission exists. A crash after
					// the answer commits but before any observer runs is then still recoverable, and a
					// turn can never start without a durable record that its reply is owed.
					admitted = true;
					await this.options.onTurnAdmitted?.({
						activityId,
						conversationId: input.conversationId,
						...(triggerSenderId === undefined ? {} : { senderExternalId: triggerSenderId }),
						...(midRun ? { midRun } : {}),
						submissionRequestId: requestId,
						whenBusy,
					});
				}
				return conversation.submit(
					tx,
					shouldSubmit
						? {
								type: "input",
								content: await this.envelopesToInput(nextEnvelopes, conversation),
								entry,
								requestId,
								whenBusy: whenBusy === "follow-up" ? "followUp" : whenBusy,
							}
						: {
								type: "write",
								entry,
								requestId: `${activityId}:${input.envelope.id}`,
							},
				);
			}, BACKGROUND_CONTEXT);
		} catch (error) {
			// The turn was announced before the durable submission existed. A refused submit must
			// never leave the announced binding (or its reply expectation) behind.
			if (admitted) this.settleAdmittedSubmission(input.conversationId, requestId);
			throw error;
		}
		if (shouldOpen) {
			this.emitActivityEvent({
				activityId,
				conversationId: input.conversationId,
				envelopeCount: nextEnvelopes.length,
				type: "opened",
			});
		}
		if (shouldSubmit) {
			this.emitActivityEvent({
				activityId,
				conversationId: input.conversationId,
				envelopeCount: nextEnvelopes.length,
				type: "closed",
			});
		}
		const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
		const record = await submission?.status(BACKGROUND_CONTEXT);
		if (!shouldSubmit) {
			this.scheduleActivityFlush(input.conversationId, pacing.burstSettleMs);
		} else {
			this.trackSubmission(input.conversationId, String(submissionId));
			this.observeAnswer(
				harness,
				input.conversationId,
				submission,
				String(submissionId),
				requestId,
			);
		}
		return {
			activityId,
			deduplicated: false,
			messageId: input.envelope.id,
			status: record?.status ?? "unknown",
		};
	}

	/**
	 * Watch one input submission to settlement and forward the assistant answer. Runs
	 * detached: `append()` and the activity flush return without waiting for the model run.
	 */
	private observeAnswer(
		harness: DurableHarness,
		conversationId: string,
		submission: Submission | undefined,
		submissionId?: string,
		submissionRequestId?: string,
	): void {
		const onAnswer = this.options.onAnswer;
		if (submission === undefined) {
			if (submissionId !== undefined) this.untrackSubmission(conversationId, submissionId);
			this.settleAdmittedSubmission(conversationId, submissionRequestId);
			this.logger.debug("Conversation answer observation skipped", {
				conversationId,
				reason: "no-submission",
				submissionId,
			});
			return;
		}
		const startedAt = performance.now();
		this.watchLiveRun(harness, conversationId);
		void (async () => {
			let settledNotified = false;
			const notifySettled = (preserveReplyState?: boolean) => {
				if (settledNotified) return;
				settledNotified = true;
				this.settleAdmittedSubmission(conversationId, submissionRequestId, preserveReplyState);
			};
			try {
				const settled = await submission.wait(BACKGROUND_CONTEXT);
				if (onAnswer === undefined || settled.type !== "input" || settled.status !== "done") {
					notifySettled();
					return;
				}
				const answerId = settled.answer;
				const entry = await harness.commit((tx) => tx.entry(answerId), BACKGROUND_CONTEXT);
				if (entry === undefined) {
					notifySettled();
					return;
				}
				const text = assistantEntryText(entry);
				if (text === undefined) {
					notifySettled();
					return;
				}
				// Release the submission's sender binding before `await onAnswer(...)` runs slow
				// channel pacing/sends, so a queued follow-up run that starts immediately cannot
				// inherit the previous turn's authorization. Preserve per-turn reply dedup state so
				// `handleAnswer` can consume it synchronously before its first await.
				notifySettled(true);
				const truncated = assistantEntryStopReason(entry) === "length";
				const activityId = activityIdFromSubmissionRequestId(settled.requestId ?? "");
				const answerSubmissionRequestId = settled.requestId;
				const entryId = String(answerId);
				this.logger.debug("Conversation answer observed", {
					activityId,
					conversationId,
					durationMs: Math.round(performance.now() - startedAt),
					entryId,
					textLength: text.length,
				});
				this.logger.trace("Conversation answer preview", {
					answerPreview: previewText(text),
					conversationId,
					entryId,
				});
				await onAnswer({
					activityId,
					conversationId,
					entryId,
					...(answerSubmissionRequestId === undefined
						? {}
						: { submissionRequestId: answerSubmissionRequestId }),
					text,
					...(truncated ? { truncated } : {}),
				});
			} catch (error) {
				if (this.closed) return;
				this.logger.error("Failed to observe conversation answer", {
					conversationId,
					error,
					submissionId,
				});
			} finally {
				// Safety net for throws before `notifySettled`: every outcome must release the
				// submission's per-turn state.
				notifySettled();
				if (submissionId !== undefined) this.untrackSubmission(conversationId, submissionId);
			}
		})();
	}

	/** Announce that an admitted submission reached a terminal state; listener errors never throw. */
	private settleAdmittedSubmission(
		conversationId: string,
		submissionRequestId: string | undefined,
		preserveReplyState?: boolean,
	): void {
		if (submissionRequestId === undefined) return;
		try {
			this.options.onSubmissionSettled?.({
				conversationId,
				...(preserveReplyState === true ? { preserveReplyState: true } : {}),
				submissionRequestId,
			});
		} catch (error) {
			if (this.closed) return;
			this.logger.error("Failed to settle admitted submission", {
				conversationId,
				error,
				submissionRequestId,
			});
		}
	}

	/**
	 * Watch the `pi.live` document of a conversation and forward each committed change as a
	 * `LiveRunSnapshot`. Durable already throttles partial answers (`progress.partialIntervalMs`,
	 * 100ms by default), so this is the same cadence the WebUI needs to render streaming text.
	 *
	 * The watch is per conversation and replaced when a new run starts, so a burst of messages
	 * that produces several runs never accumulates watchers. Failures are swallowed: live state
	 * is a presentation nicety and must never affect ingestion or the answer path.
	 */
	private watchLiveRun(harness: DurableHarness, conversationId: string): void {
		const onLiveRun = this.options.onLiveRun;
		if (onLiveRun === undefined) return;
		// A steered input or a follow-up window starts another observer for the same
		// conversation. Let the newest observer own the watch; otherwise the old timer keeps
		// publishing snapshots with an older start time and the cache resets its timeline.
		this.stopLiveRun(conversationId);
		// Poll `pi.live` instead of attaching a document watch. `watchDoc` mounts an observer on
		// the Session line, whose document load can still be queued when the host closes, and
		// then reaches storage after the caller closed the handle. A snapshot poll is a plain
		// request/response read: it never leaves a background mount behind, and stopping it is
		// just clearing a timer.
		const numericId = Number(conversationId) as ConversationId;
		// A later window can replace this watcher while the run it submitted into is still
		// active. Start from the earliest active submission so the elapsed time and the live
		// timeline do not jump back to the newer watcher's wall clock.
		const startedAtMs = this.activeRunSince(conversationId) ?? Date.now();
		// Tool-call arguments are committed while the model streams, then `live.tools` takes over
		// and only carries the task's output. Remember the last arguments by call id so the
		// running row still shows what the model asked for.
		const knownArguments = new Map<string, string>();
		// The run is admitted by the same commit that flushes the activity window, but the
		// scheduler may not have started it yet when the first polls land. Seeing no run is only
		// "settled" once a run was actually observed, or after this grace period, otherwise the
		// poller would stop before the first token and report nothing.
		let sawRun = false;
		let stopped = false;
		const timer = setInterval(() => {
			if (this.closed || stopped || this.liveRuns.get(conversationId)?.timer !== timer) {
				this.stopLiveRun(conversationId, timer);
				return;
			}
			const polling = (async () => {
				try {
					const live = await harness.snapshot(LiveDoc, numericId, BACKGROUND_CONTEXT);
					if (this.closed || stopped || this.liveRuns.get(conversationId)?.timer !== timer) {
						return;
					}
					const running = live?.run !== undefined;
					if (!running && !sawRun && Date.now() - startedAtMs < LIVE_RUN_START_GRACE_MS) {
						return;
					}
					if (!running && !sawRun) {
						this.logger.trace("Live run grace period expired without a run", {
							conversationId,
							waitedMs: Math.round(Date.now() - startedAtMs),
						});
					}
					if (!running) {
						// The run settled. Report a failure first so a client can show it, then clear.
						stopped = true;
						if (live?.runFailure !== undefined) {
							onLiveRun({
								...emptyLiveRun(conversationId, startedAtMs),
								failure: runFailureText(live.runFailure),
							});
						}
						this.stopLiveRun(conversationId, timer);
						if (live?.runFailure === undefined) {
							onLiveRun(emptyLiveRun(conversationId, startedAtMs));
						}
						return;
					}
					sawRun = true;
					const snapshot = toLiveRunSnapshot(conversationId, startedAtMs, live, knownArguments);
					for (const tool of snapshot.draftTools) {
						if (tool.argumentsText !== undefined) {
							knownArguments.set(tool.callId, tool.argumentsText);
						}
					}
					onLiveRun(snapshot);
				} catch (error) {
					// Live presentation is optional; ingestion and answers must not depend on it.
					this.logger.trace("Live run poll failed", { conversationId, error });
					stopped = true;
					this.stopLiveRun(conversationId, timer);
				}
			})();
			this.pendingPolls.add(polling);
			void polling.finally(() => this.pendingPolls.delete(polling));
		}, LIVE_RUN_POLL_MS);
		timer.unref?.();
		this.liveRuns.set(conversationId, { startedAtMs, timer });
	}

	/** Stop polling one conversation's live run. Safe to call when nothing is polling. */
	private stopLiveRun(conversationId: string, timer?: ReturnType<typeof setInterval>): void {
		const poll = this.liveRuns.get(conversationId);
		if (poll === undefined) {
			if (timer !== undefined) clearInterval(timer);
			return;
		}
		if (timer !== undefined && poll.timer !== timer) {
			// A newer watcher owns the conversation. Stop only the caller's timer.
			clearInterval(timer);
			return;
		}
		this.liveRuns.delete(conversationId);
		clearInterval(poll.timer);
	}

	private trackSubmission(conversationId: string, submissionId: string): void {
		const runs = this.activeRuns.get(conversationId) ?? new Map();
		runs.set(submissionId, { startedAtMs: Date.now() });
		this.activeRuns.set(conversationId, runs);
	}

	private untrackSubmission(conversationId: string, submissionId: string): void {
		const runs = this.activeRuns.get(conversationId);
		if (runs === undefined) return;
		runs.delete(submissionId);
		if (runs.size === 0) this.activeRuns.delete(conversationId);
	}

	private activeRunSince(conversationId: string): number | undefined {
		const runs = this.activeRuns.get(conversationId);
		if (runs === undefined || runs.size === 0) return undefined;
		let earliest: number | undefined;
		for (const run of runs.values()) {
			if (earliest === undefined || run.startedAtMs < earliest) earliest = run.startedAtMs;
		}
		return earliest;
	}

	private scheduleActivityFlush(
		conversationId: string,
		delayMs = this.policy.pacing.burstSettleMs,
	): void {
		this.clearActivityTimer(conversationId);
		const timer = setTimeout(() => {
			this.activityTimers.delete(conversationId);
			// A close during the delay clears the timer, but a flush already dispatched would
			// still reach storage after it closed.
			if (this.closed) return;
			const flushing = this.flushActivity(conversationId).catch((error: unknown) => {
				// A flush racing `close()` is expected: the host stops, then storage closes under
				// it. That race is not a defect worth a log line.
				if (this.closed) return;
				if (error instanceof Error && error.message === "SqliteStorage is closed") return;
				this.logger.error("Failed to flush activity window", { conversationId, error });
			});
			this.pendingFlushes.add(flushing);
			void flushing.finally(() => this.pendingFlushes.delete(flushing));
		}, delayMs);
		this.activityTimers.set(conversationId, { timer });
	}

	private clearActivityTimer(conversationId: string): void {
		const scheduled = this.activityTimers.get(conversationId);
		if (scheduled === undefined) return;
		clearTimeout(scheduled.timer);
		this.activityTimers.delete(conversationId);
	}

	/** Let the router defer a collected window until a cooldown or rate limit expires. */
	scheduleActivityFlushAfter(conversationId: string, delayMs: number): void {
		this.scheduleActivityFlush(conversationId, Math.max(0, delayMs));
	}

	private async flushActivity(conversationId: string): Promise<void> {
		// A flush queued behind the execution lock can still start after `close()`. Reading the
		// harness then would reach a closed storage handle.
		if (this.closed) return;
		if (this.activityFlushes.has(conversationId)) return;
		this.activityFlushes.add(conversationId);
		try {
			await withConversationLock(
				conversationId,
				() => this.flushActivityLocked(conversationId),
				this.executionLock,
			);
		} finally {
			this.activityFlushes.delete(conversationId);
		}
	}

	private async flushActivityLocked(conversationId: string): Promise<void> {
		const startedAt = performance.now();
		{
			if (this.closed) {
				this.logger.debug("Activity flush skipped", { conversationId, reason: "host-closed" });
				return;
			}
			const harness = await this.openHarness();
			const numericId = Number(conversationId) as ConversationId;
			const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
			if (!conversation) {
				this.logger.debug("Activity flush skipped", {
					conversationId,
					reason: "conversation-not-found",
				});
				return;
			}
			await this.ensureExtensions(conversation, conversationId);
			await this.ensureAgentModel(conversation, conversationId);
			const activityId = `${numericId}:activity`;
			const window = await harness.snapshot(
				activityWindowDoc,
				numericId,
				activityId,
				BACKGROUND_CONTEXT,
			);
			if (!window || window.status !== "collecting" || window.envelopes.length === 0) {
				this.logger.debug("Activity flush skipped", {
					activityId,
					conversationId,
					status: window?.status,
					reason: "no-open-window",
				});
				return;
			}
			const policy = await this.readPolicy(numericId);
			if (!policy.enabled) {
				this.logger.debug("Activity flush skipped", {
					activityId,
					conversationId,
					reason: "conversation-disabled",
				});
				return;
			}
			const envelopes = window.envelopes;
			const now = Date.now();
			const arbitrationEnabled = policy.sidechat.enabled && this.options.busyArbiter !== undefined;
			const interjectEnabled =
				policy.sidechat.interjectEnabled && this.options.fastLaneInterjector !== undefined;
			const live =
				arbitrationEnabled || interjectEnabled
					? await harness.snapshot(LiveDoc, numericId, BACKGROUND_CONTEXT)
					: undefined;
			const working = live?.run !== undefined && live.run.inputs.length > 0;
			// A steer or follow-up admitted into a run that is already working must not reset the
			// presentation state that run still owns.
			const midRun = this.activeRunSince(conversationId) !== undefined || working;
			let whenBusy: "steer" | "follow-up" =
				busyDisposition(this.activeRunSince(conversationId), now, this.steerGraceMs) === "steer" &&
				policy.steerWhenBusy === "steer"
					? "steer"
					: "follow-up";
			let interrupted = false;

			// Optional fail-open burst-completion gate when idle and still under `burstMaxWaitMs`.
			if (
				!working &&
				policy.gate.enabled &&
				policy.gate.burstCompletion &&
				this.options.conversationGate !== undefined &&
				envelopes.length < policy.pacing.burstMaxMessages &&
				now - window.openedAtMs < policy.pacing.burstMaxWaitMs
			) {
				const gateDecision = await this.options.conversationGate.decideBurstCompletion({
					conversationId,
					elapsedMs: Math.max(0, now - window.openedAtMs),
					envelopeCount: envelopes.length,
					messages: envelopes.map((env) => this.envelopeToText(env as MessageEnvelope)),
					policy: policy.gate,
				});
				if (gateDecision.decision === "WAIT") {
					const remainingMaxWait = Math.max(
						1,
						policy.pacing.burstMaxWaitMs - (now - window.openedAtMs),
					);
					this.scheduleActivityFlush(
						conversationId,
						Math.min(policy.pacing.burstSettleMs, remainingMaxWait),
					);
					return;
				}
			}

			// Optional fast-lane busy interjection: answer one direct urgent message out-of-band
			// without aborting or mutating the active main turn. Identity probes and trailing
			// follow-ups are strictly excluded by `shouldInterject` and fall through to normal
			// main-turn handling. A multi-envelope window stays on the main conversation so the
			// earlier inputs are never dropped, and `maxInterruptsPerMinute` caps the lane per chat.
			if (working && interjectEnabled && live !== undefined && envelopes.length === 1) {
				const latest = envelopes.at(-1);
				const latestText =
					latest === undefined
						? ""
						: messagePartsText((latest as unknown as MessageEnvelope).parts);
				const runAgeMs = now - (this.activeRunSince(conversationId) ?? now);
				const eligibility = shouldInterject({
					classification: latest?.turnContext?.classification,
					policy,
					runAgeMs,
					text: latestText,
				});
				if (
					eligibility.interject &&
					this.options.fastLaneInterjector !== undefined &&
					this.canInterrupt(conversationId, policy.sidechat.maxInterruptsPerMinute, now)
				) {
					const context = await this.arbitrationContext(conversation);
					const senderName = (latest as unknown as MessageEnvelope | undefined)?.sender
						?.displayName;
					const recentLines = [
						...(context.previousAnswer === undefined
							? []
							: [`assistant: ${context.previousAnswer}`]),
						...envelopes.slice(0, -1).map((env) => this.envelopeToText(env as MessageEnvelope)),
					].slice(-4);
					const fastResult = await withTimeout(
						Promise.resolve(
							this.options.fastLaneInterjector({
								conversationId,
								messageText: latestText,
								policy,
								recentLines,
								runAgeMs,
								runningRequest: context.runningRequest,
								...(senderName === undefined ? {} : { senderName }),
							}),
						).catch((error: unknown) => {
							this.logger.warn("Fast-lane interjection failed; falling back to busy handling", {
								conversationId,
								error,
							});
							return undefined;
						}),
						Math.max(100, policy.sidechat.interjectTimeoutMs) + 250,
						undefined,
					);
					const replyText = fastResult?.text?.trim();
					if (fastResult?.handled === true && replyText !== undefined && replyText.length > 0) {
						// Close the collecting window without touching or aborting the active main run.
						await conversation.commit(async (tx) => {
							const document = await tx.doc(activityWindowDoc, numericId, activityId, {
								conversationId: numericId,
								envelopes,
								openedAtMs: window.openedAtMs,
							});
							document.envelopes = envelopes;
							document.status = "closed";
							document.closedAtMs = Date.now();
						}, BACKGROUND_CONTEXT);
						this.clearBusyHold(conversationId);
						this.recordInterrupt(conversationId, now);
						const interjectId = `interject:${activityId}:${latest?.id ?? String(now)}`;
						void Promise.resolve(
							this.options.onFastLaneReply?.({
								conversationId,
								interjectId,
								text: replyText,
							}),
						).catch((error: unknown) => {
							this.logger.warn("Fast-lane reply delivery failed", {
								conversationId,
								error,
								interjectId,
							});
						});
						this.logger.debug("Fast-lane busy interjection handled", {
							conversationId,
							interjectId,
							reason: eligibility.reason,
						});
						return;
					}
				}
			}

			if (working && arbitrationEnabled && live !== undefined) {
				const hold = this.busyHolds.get(conversationId);
				const holdExpired = hold !== undefined && now - hold.since >= policy.sidechat.maxHoldMs;
				if (holdExpired) {
					this.logger.info("Busy hold expired; submitting a follow-up", {
						activityId,
						conversationId,
						envelopeCount: envelopes.length,
						heldMs: hold === undefined ? 0 : now - hold.since,
					});
					this.clearBusyHold(conversationId);
					whenBusy = "follow-up";
				} else {
					const runAgeMs = now - (this.activeRunSince(conversationId) ?? now);
					const result =
						runAgeMs < policy.sidechat.minRunAgeMs
							? undefined
							: await this.arbitrateBusy(conversation, conversationId, envelopes, live, policy);
					const decision = result?.decision ?? "wait";
					if (decision === "interrupt") {
						if (this.canInterrupt(conversationId, policy.sidechat.maxInterruptsPerMinute, now)) {
							const outcome = await this.abortWorkingRun(
								harness,
								conversation,
								conversationId,
								live,
							);
							if (outcome === "failed") {
								this.holdBusyWindow(conversation, conversationId, envelopes.length, now, policy);
								return;
							}
							if (outcome === "aborted") {
								interrupted = true;
								this.recordInterrupt(conversationId, now);
							}
							this.clearBusyHold(conversationId);
							whenBusy = "follow-up";
						} else {
							this.logger.debug("Busy interrupt limit reached; keeping the window", {
								conversationId,
								envelopeCount: envelopes.length,
								maxInterruptsPerMinute: policy.sidechat.maxInterruptsPerMinute,
							});
							this.holdBusyWindow(conversation, conversationId, envelopes.length, now, policy);
							return;
						}
					} else if (decision === "steer") {
						whenBusy = "steer";
						this.clearBusyHold(conversationId);
					} else {
						this.holdBusyWindow(conversation, conversationId, envelopes.length, now, policy);
						return;
					}
				}
			} else if (!working) {
				this.clearBusyHold(conversationId);
			}

			const requestId = activitySubmissionRequestId(activityId, envelopes[0]?.id ?? "window");
			const triggerSenderId = triggerSenderExternalId(envelopes);
			let admitted = false;
			let submissionId: SubmissionId;
			try {
				submissionId = await conversation.commit(async (tx) => {
					const document = await tx.doc(activityWindowDoc, numericId, activityId, {
						conversationId: numericId,
						envelopes,
						openedAtMs: window.openedAtMs,
					});
					document.envelopes = envelopes;
					document.status = "submitted";
					document.closedAtMs = Date.now();
					const entry = {
						kind: durableDocumentKinds.activityWindow,
						data: {
							activityId,
							envelopes,
						},
					};
					await this.options.onTurnAdmitted?.({
						activityId,
						conversationId,
						...(triggerSenderId === undefined ? {} : { senderExternalId: triggerSenderId }),
						...(midRun ? { midRun } : {}),
						submissionRequestId: requestId,
						whenBusy,
					});
					admitted = true;
					return conversation.submit(tx, {
						content: await this.envelopesToInput(envelopes, conversation),
						entry,
						requestId,
						type: "input",
						whenBusy: whenBusy === "steer" ? "steer" : "followUp",
					});
				}, BACKGROUND_CONTEXT);
			} catch (error) {
				if (admitted) this.settleAdmittedSubmission(conversationId, requestId);
				throw error;
			}
			this.emitActivityEvent({
				activityId,
				conversationId,
				envelopeCount: envelopes.length,
				type: "closed",
			});
			const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
			this.logger.debug("Activity window flushed", {
				activityId,
				conversationId,
				durationMs: Math.round(performance.now() - startedAt),
				envelopeCount: envelopes.length,
				interrupted,
				submitted: true,
				whenBusy,
			});
			this.trackSubmission(conversationId, String(submissionId));
			this.observeAnswer(harness, conversationId, submission, String(submissionId), requestId);
		}
	}

	/** True while a run still owes an answer (afterRun bookkeeping does not count). */
	private async runIsWorking(
		harness: DurableHarness,
		conversationId: ConversationId,
	): Promise<boolean> {
		const live = await harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
		return live?.run !== undefined && live.run.inputs.length > 0;
	}

	/**
	 * Ask the sidechat router what to do with a settled window while the run is working. A
	 * missing, slow, or throwing router always degrades to `wait`: accumulating is recoverable,
	 * interrupting the wrong answer is not.
	 */
	private async arbitrateBusy(
		conversation: Conversation,
		conversationId: string,
		envelopes: readonly StoredEnvelope[],
		live: LiveState,
		policy: ConversationPolicy,
	): Promise<BusyArbitrationResult | undefined> {
		const arbiter = this.options.busyArbiter;
		if (arbiter === undefined) return undefined;
		const startedAt = performance.now();
		const context = await this.arbitrationContext(conversation);
		const partialAnswer = partialTextOf(live.generation?.message);
		const input = {
			conversationId,
			pendingText: this.envelopesForArbitration(envelopes),
			runningRequest: context.runningRequest,
			...(context.previousAnswer === undefined ? {} : { previousAnswer: context.previousAnswer }),
			...(partialAnswer === undefined ? {} : { partialAnswer }),
			policy,
			toolsActive: (live.tools?.length ?? 0) > 0,
			turns: live.run?.turns ?? 0,
			runAgeMs: Date.now() - (this.activeRunSince(conversationId) ?? Date.now()),
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<undefined>((resolve) => {
				timer = setTimeout(
					() => resolve(undefined),
					Math.max(100, policy.sidechat.timeoutMs) + 250,
				);
				timer.unref?.();
			});
			const result = await Promise.race([Promise.resolve(arbiter(input)), timeout]);
			this.logger.debug("Busy arbitration completed", {
				confidence: result?.confidence,
				conversationId,
				decision: result?.decision ?? "wait",
				durationMs: Math.round(performance.now() - startedAt),
				envelopeCount: envelopes.length,
				toolsActive: input.toolsActive,
				turns: input.turns,
			});
			return result;
		} catch (error) {
			this.logger.warn("Busy arbitration failed", { conversationId, error });
			return undefined;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** Recent request and previous answer for the sidechat router, bounded to two entries each. */
	private async arbitrationContext(
		conversation: Conversation,
	): Promise<{ runningRequest: string; previousAnswer?: string }> {
		try {
			const page = await conversation.entries(
				{ order: "descending" },
				12,
				undefined,
				BACKGROUND_CONTEXT,
			);
			let previousAnswer: string | undefined;
			let seenUser = false;
			const requests: string[] = [];
			for (const entry of page.items) {
				const userText = userEntryText(entry);
				if (!seenUser) {
					if (userText === undefined) continue;
					requests.unshift(userText);
					seenUser = true;
					continue;
				}
				// A steer placed during the run is part of the same request. Older user entries are
				// separated by the previous settled assistant answer.
				if (userText !== undefined) {
					if (requests.length < 3) requests.unshift(userText);
					continue;
				}
				if (entry.kind !== "pi.assistant") continue;
				const text = assistantEntryText(entry);
				if (text === undefined) continue;
				previousAnswer = text;
				break;
			}
			return {
				runningRequest: requests.join("\n---\n"),
				...(previousAnswer === undefined ? {} : { previousAnswer }),
			};
		} catch (error) {
			this.logger.trace("Busy arbitration context unavailable", { error });
			return { runningRequest: "" };
		}
	}

	/** Plain labeled text of a pending window; trigger contracts are routing noise here. */
	private envelopesForArbitration(envelopes: readonly StoredEnvelope[]): string {
		return envelopes
			.map((envelope) => {
				const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
				const content = parts
					.map((part) => {
						const parsed = messagePartSchema.safeParse(part);
						return parsed.success ? messagePartText(parsed.data) : "";
					})
					.filter((value) => value.length > 0)
					.join(" ");
				const sender =
					typeof envelope.sender === "object" &&
					envelope.sender !== null &&
					"displayName" in envelope.sender &&
					typeof envelope.sender.displayName === "string"
						? envelope.sender.displayName
						: "Unknown";
				return `${sender}: ${content}`;
			})
			.join("\n");
	}

	private canInterrupt(conversationId: string, limit: number, nowMs: number): boolean {
		if (limit <= 0) return false;
		const recent = (this.interruptTimes.get(conversationId) ?? []).filter(
			(timestamp) => nowMs - timestamp < 60_000,
		);
		this.interruptTimes.set(conversationId, recent);
		return recent.length < limit;
	}

	private recordInterrupt(conversationId: string, nowMs: number): void {
		const recent = (this.interruptTimes.get(conversationId) ?? []).filter(
			(timestamp) => nowMs - timestamp < 60_000,
		);
		recent.push(nowMs);
		this.interruptTimes.set(conversationId, recent);
	}

	/**
	 * Abort only the working generation task, then wait for its abort handler. The conversation's
	 * queued inputs stay in the inbox, unlike `Conversation.abort()`; the pending activity window
	 * is the only input that gets submitted afterwards.
	 */
	private async abortWorkingRun(
		harness: DurableHarness,
		conversation: Conversation,
		conversationId: string,
		live: LiveState,
	): Promise<"aborted" | "ended" | "failed"> {
		const taskId = live.run?.taskId;
		if (taskId === undefined) return "failed";
		const startedAt = performance.now();
		try {
			const marked = await withTimeout(
				harness.abortTask(taskId, BACKGROUND_CONTEXT),
				5_000,
				"timeout" as const,
			);
			if (marked === "timeout") {
				this.logger.warn("Busy run abort timed out", { conversationId });
				return "failed";
			}
			if (marked === "terminal") {
				this.logger.debug("Busy run ended before the interrupt landed", { conversationId });
				return "ended";
			}
			const idle = await withTimeout(
				conversation.waitForIdle(BACKGROUND_CONTEXT).then(() => true),
				5_000,
				false,
			);
			if (!idle) {
				this.logger.warn("Busy run abort did not become idle", { conversationId });
				return "failed";
			}
			this.logger.debug("Busy run interrupted", {
				conversationId,
				durationMs: Math.round(performance.now() - startedAt),
				taskId: String(taskId),
			});
			return "aborted";
		} catch (error) {
			this.logger.warn("Busy run interrupt failed", { conversationId, error });
			return "failed";
		}
	}

	/**
	 * Keep the collecting window open until the working run is idle. A new message re-arms the
	 * normal settle timer, so an urgent follow-up can be classified again before the run ends.
	 */
	private holdBusyWindow(
		conversation: Conversation,
		conversationId: string,
		envelopeCount: number,
		nowMs: number,
		policy: ConversationPolicy,
	): void {
		const existing = this.busyHolds.get(conversationId);
		if (existing !== undefined) {
			existing.envelopeCount = envelopeCount;
			existing.updatedAt = nowMs;
			this.logger.debug("Activity window hold extended", {
				conversationId,
				envelopeCount,
				heldMs: nowMs - existing.since,
			});
			return;
		}
		const hold: {
			envelopeCount: number;
			since: number;
			timer?: ReturnType<typeof setTimeout>;
			updatedAt: number;
		} = { envelopeCount, since: nowMs, updatedAt: nowMs };
		this.busyHolds.set(conversationId, hold);
		const timer = setTimeout(() => {
			if (this.closed) return;
			if (this.busyHolds.get(conversationId) !== hold) return;
			this.scheduleActivityFlush(conversationId, 0);
		}, policy.sidechat.maxHoldMs);
		timer.unref?.();
		hold.timer = timer;
		this.logger.debug("Activity window held while a run is working", {
			conversationId,
			envelopeCount,
			maxHoldMs: policy.sidechat.maxHoldMs,
		});
		void conversation
			.waitForIdle(BACKGROUND_CONTEXT)
			.then(() => {
				if (this.closed) return;
				if (this.busyHolds.get(conversationId) !== hold) return;
				this.busyHolds.delete(conversationId);
				this.scheduleActivityFlush(conversationId, 0);
			})
			.catch((error: unknown) => {
				if (this.closed) return;
				if (this.busyHolds.get(conversationId) !== hold) return;
				this.busyHolds.delete(conversationId);
				this.logger.warn("Busy hold wait failed", { conversationId, error });
				this.scheduleActivityFlush(conversationId, policy.pacing.burstSettleMs);
			});
	}

	private clearBusyHold(conversationId: string): void {
		const hold = this.busyHolds.get(conversationId);
		if (hold?.timer !== undefined) clearTimeout(hold.timer);
		this.busyHolds.delete(conversationId);
	}

	async submitBackgroundTurn(input: BackgroundTurnInput): Promise<BackgroundTurnResult> {
		return withConversationLock(
			input.conversationId,
			() => this.submitBackgroundTurnLocked(input),
			this.executionLock,
		);
	}

	private async submitBackgroundTurnLocked(
		input: BackgroundTurnInput,
	): Promise<BackgroundTurnResult> {
		const startedAt = performance.now();
		const harness = await this.openHarness();
		const numericId = Number(input.conversationId) as ConversationId;
		const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`Conversation not found: ${input.conversationId}`);
		await this.ensureExtensions(conversation, input.conversationId);
		await this.ensureAgentModel(conversation, input.conversationId);
		const policy = await this.readPolicy(numericId);
		if (!policy.enabled) throw new Error(`Conversation disabled: ${input.conversationId}`);
		const activityId = `${numericId}:background`;
		const requestId = input.requestId ?? `${activityId}:${randomUUID()}`;
		this.logger.debug("Background turn started", {
			conversationId: input.conversationId,
			kind: input.kind,
			requestId,
		});
		const content = [input.context?.trim(), input.prompt.trim()]
			.filter((value): value is string => value !== undefined && value.length > 0)
			.join("\n\n");
		if (content.length === 0) {
			this.logger.warn("Background turn skipped", {
				conversationId: input.conversationId,
				reason: "empty-prompt",
				requestId,
			});
			throw new Error("Background turn prompt must not be empty");
		}
		const midRun =
			this.activeRunSince(input.conversationId) !== undefined ||
			(await this.runIsWorking(harness, numericId));
		let admitted = false;
		let submissionId: SubmissionId;
		try {
			submissionId = await conversation.commit(async (tx) => {
				// Record the reply expectation before admitting the turn, so a crash after the answer
				// commits but before this caller sees it is recoverable. A rejected expectation aborts
				// the turn: a reply must never be produced without a durable record that it is owed.
				admitted = true;
				await this.options.onBackgroundTurnAdmitted?.({
					activityId,
					conversationId: input.conversationId,
					...(midRun ? { midRun } : {}),
					...(input.origin === undefined ? {} : { origin: input.origin }),
					submissionRequestId: requestId,
				});
				return conversation.submit(tx, {
					content,
					entry: {
						kind: durableDocumentKinds.activityWindow,
						data: {
							activityId,
							backgroundKind: input.kind,
							requestId,
						},
					},
					requestId,
					type: "input",
				});
			}, BACKGROUND_CONTEXT);
		} catch (error) {
			// A refused submit must not leave the announced background binding behind.
			if (admitted) this.settleAdmittedSubmission(input.conversationId, requestId);
			throw error;
		}
		try {
			const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
			const settled = await submission?.wait(BACKGROUND_CONTEXT);
			if (settled === undefined || settled.type !== "input" || settled.status !== "done") {
				this.logger.warn("Background turn did not settle", {
					conversationId: input.conversationId,
					durationMs: Math.round(performance.now() - startedAt),
					requestId,
					status: settled?.status,
				});
				throw new Error("Background turn did not settle successfully");
			}
			const entry = await harness.commit((tx) => tx.entry(settled.answer), BACKGROUND_CONTEXT);
			const text = entry === undefined ? "" : (assistantEntryText(entry) ?? "");
			const entryId = String(settled.answer);
			this.logger.debug("Background turn done", {
				conversationId: input.conversationId,
				durationMs: Math.round(performance.now() - startedAt),
				entryId,
				requestId,
				status: settled.status,
			});
			this.logger.trace("Background turn answer preview", {
				answerPreview: previewText(text),
				conversationId: input.conversationId,
				entryId,
			});
			return {
				activityId,
				entryId,
				requestId,
				submissionRequestId: requestId,
				text,
			};
		} finally {
			// The turn is settled (answered, empty, or failed); its background binding must not
			// authorize anything in a later turn.
			this.settleAdmittedSubmission(input.conversationId, requestId);
		}
	}

	async listEntries(conversationId: string, limit = 500): Promise<EntryRecord[]> {
		const harness = await this.openHarness();
		const conversation = await harness.conversation(
			Number(conversationId) as ConversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return [];
		const page = await conversation.entries(
			{ order: "descending" },
			Math.min(Math.max(limit, 1), 1_000),
			undefined,
			BACKGROUND_CONTEXT,
		);
		return [...page.items].toReversed();
	}

	/**
	 * Resolve the terminal state of one admitted submission by its durable request id.
	 *
	 * Recovery must never infer "this assistant entry needs a reply" from the transcript: an
	 * entry may be an intermediate step, a suppressed marker, or an answer whose turn was already
	 * handled. A reply is only owed for a submission the server explicitly expected, and only
	 * that submission's own `answer` entry is dispatchable.
	 */
	async resolveSubmissionAnswer(
		conversationId: string,
		submissionRequestId: string,
	): Promise<SubmissionAnswerResolution> {
		const numericId = Number(conversationId) as ConversationId;
		if (!Number.isSafeInteger(numericId)) return { status: "missing" };
		const record = await this.options.storage.submissionByRequest(
			numericId,
			submissionRequestId,
			BACKGROUND_CONTEXT,
		);
		if (record === undefined) return { status: "missing" };
		if (record.type !== "input") return { status: "missing" };
		if (record.status === "queued" || record.status === "placed") {
			return { status: "pending" };
		}
		if (record.status === "unanswered") {
			return { reason: record.reason, status: "unanswered" };
		}
		const answer = await this.options.storage.entry(record.answer, BACKGROUND_CONTEXT);
		if (answer === undefined) {
			// The submission settled but its answer entry is not visible yet. Treat it as pending
			// so a later sweep retries instead of dropping the reply.
			return { status: "pending" };
		}
		const text = assistantEntryText(answer.entry);
		if (text === undefined) return { reason: "answer_has_no_text", status: "unanswered" };
		const truncated = assistantEntryStopReason(answer.entry) === "length";
		return {
			entryId: String(record.answer),
			status: "answered",
			text,
			...(truncated ? { truncated } : {}),
		};
	}

	async compactConversation(
		conversationId: string,
		instructions?: string,
	): Promise<CompactConversationResult> {
		const startedAt = performance.now();
		const parsedNumeric = Number(conversationId);
		if (!Number.isSafeInteger(parsedNumeric)) {
			throw new Error(`Conversation not found: ${conversationId}`);
		}
		const harness = await this.openHarness();
		const numericId = parsedNumeric as ConversationId;
		const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			throw new Error(`Conversation not found: ${conversationId}`);
		}
		await this.ensureExtensions(conversation, conversationId);
		await this.ensureAgentModel(conversation, conversationId);
		const trimmed = instructions?.trim();
		this.logger.debug("Conversation compaction started", {
			conversationId,
			hasInstructions: trimmed !== undefined && trimmed.length > 0,
		});
		const taskId = await conversation.compact(
			trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined,
			BACKGROUND_CONTEXT,
		);
		const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
		const outcome = settled.state.outcome;
		if (outcome.status !== "completed") {
			this.logger.debug("Conversation compaction finished", {
				conversationId,
				durationMs: Math.round(performance.now() - startedAt),
				status: outcome.status,
			});
			if (outcome.status === "failed" || outcome.status === "faulted") {
				throw new Error(outcome.error.message);
			}
			throw new Error(outcome.reason ?? `Compaction ${outcome.status}`);
		}
		const { entryId, submissionId } = outcome.result;
		if (submissionId !== undefined) {
			const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
			await submission?.wait(BACKGROUND_CONTEXT);
		}
		const result = {
			compacted: entryId !== undefined || submissionId !== undefined,
			entryId: entryId === undefined ? null : String(entryId),
			submissionId: submissionId === undefined ? null : String(submissionId),
		};
		this.logger.debug("Conversation compaction finished", {
			compacted: result.compacted,
			conversationId,
			durationMs: Math.round(performance.now() - startedAt),
			entryId: result.entryId,
			status: outcome.status,
			submissionId: result.submissionId,
		});
		return result;
	}

	async resetConversation(conversationId: string, handoff?: string): Promise<void> {
		const parsedNumeric = Number(conversationId);
		if (!Number.isSafeInteger(parsedNumeric)) {
			throw new Error(`Conversation not found: ${conversationId}`);
		}
		const harness = await this.openHarness();
		const numericId = parsedNumeric as ConversationId;
		const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			throw new Error(`Conversation not found: ${conversationId}`);
		}
		await this.ensureExtensions(conversation, conversationId);
		await this.ensureAgentModel(conversation, conversationId);
		const trimmed = handoff?.trim();
		await conversation.reset(
			trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined,
			BACKGROUND_CONTEXT,
		);
	}

	async abortConversation(conversationId: string): Promise<void> {
		const parsedNumeric = Number(conversationId);
		if (!Number.isSafeInteger(parsedNumeric)) {
			throw new Error(`Conversation not found: ${conversationId}`);
		}
		const harness = await this.openHarness();
		const numericId = parsedNumeric as ConversationId;
		const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			throw new Error(`Conversation not found: ${conversationId}`);
		}
		this.clearActivityTimer(conversationId);
		const activityId = `${numericId}:activity`;
		const window = await harness.snapshot(
			activityWindowDoc,
			numericId,
			activityId,
			BACKGROUND_CONTEXT,
		);
		if (window?.status === "collecting") {
			await conversation.commit(async (tx) => {
				const document = await tx.doc(activityWindowDoc, numericId, activityId, {
					conversationId: numericId,
					envelopes: window.envelopes,
					openedAtMs: window.openedAtMs,
				});
				document.status = "closed";
				document.closedAtMs = Date.now();
			}, BACKGROUND_CONTEXT);
		}
		await conversation.abort(BACKGROUND_CONTEXT);
		this.logger.debug("Conversation run aborted", {
			activityId,
			closedCollectingWindow: window?.status === "collecting",
			conversationId,
		});
	}

	/**
	 * Inspect the active model context breakdown of one durable conversation without mutating
	 * durable state. Uses pi-durable's active context view (post-compaction/reset head),
	 * resolved agent tools/sections, compaction reserve policy, and pi-ai token accounting.
	 */
	async inspectConversationContext(
		conversationId: string,
		options: InspectConversationContextOptions = {},
	): Promise<ConversationContextInspection | undefined> {
		const parsedNumeric = Number(conversationId);
		if (!Number.isSafeInteger(parsedNumeric)) return undefined;
		const harness = await this.openHarness();
		const numericId = parsedNumeric as ConversationId;
		const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return undefined;

		const [agent, agentState, view, inspection, liveState] = await Promise.all([
			conversation.agent(BACKGROUND_CONTEXT),
			harness.snapshot(AgentDoc, numericId, BACKGROUND_CONTEXT),
			conversation.context(BACKGROUND_CONTEXT),
			harness.inspect(BACKGROUND_CONTEXT),
			harness.snapshot(LiveDoc, numericId, BACKGROUND_CONTEXT),
		]);

		const modelRef = this.effectiveModelRef(agent.model);
		const resolvedModel = this.model.models.getModel(modelRef.provider, modelRef.modelId);
		const contextWindow = resolvedModel?.contextWindow ?? 0;

		const modelKey = `${modelRef.provider}/${modelRef.modelId}`;
		const compactionSettings = agent.compaction;
		const modelOverride = compactionSettings?.modelOverrides?.[modelKey];
		const autocompactEnabled =
			modelOverride?.enabled ??
			(compactionSettings?.enabled === false ? false : DEFAULT_COMPACTION_POLICY.enabled);
		const reserveTokens =
			modelOverride?.reserveTokens ??
			compactionSettings?.reserveTokens ??
			DEFAULT_COMPACTION_POLICY.reserveTokens;
		const keepRecentTokens =
			modelOverride?.keepRecentTokens ??
			compactionSettings?.keepRecentTokens ??
			DEFAULT_COMPACTION_POLICY.keepRecentTokens;
		const backgroundTokens =
			modelOverride?.backgroundTokens ??
			compactionSettings?.backgroundTokens ??
			DEFAULT_COMPACTION_POLICY.backgroundTokens;
		const bufferTokens = autocompactEnabled
			? Math.min(reserveTokens, contextWindow > 0 ? contextWindow : reserveTokens)
			: 0;

		const { offeredTools, deferredTools } = this.resolveInspectTools(
			agent.extensions,
			agent.tools,
			agent.deferred,
			agentState,
			options.omittedTools,
		);
		const offeredDecls: Tool[] = offeredTools.map((tool) => toToolDeclaration(tool));
		const deferredDecls: Tool[] = deferredTools.map((tool) => toToolDeclaration(tool));
		const toolsTokens =
			offeredDecls.length === 0 ? 0 : estimateTextTokens(JSON.stringify(offeredDecls));
		const deferredToolsTokens =
			deferredDecls.length === 0 ? 0 : estimateTextTokens(JSON.stringify(deferredDecls));
		const toolItems = [
			...offeredDecls.map((decl) => ({
				deferred: false,
				description: decl.description,
				name: decl.name,
				tokens: estimateTextTokens(JSON.stringify(decl)),
			})),
			...deferredDecls.map((decl) => ({
				deferred: true,
				description: decl.description,
				name: decl.name,
				tokens: estimateTextTokens(JSON.stringify(decl)),
			})),
		];

		const shownSections = new Map<string, string>();
		const rawSystemParts: string[] = [];
		for (const message of view.messages) {
			if (message.role !== "system") continue;
			const raw = contentText(message.content).trim();
			if (raw.length > 0) rawSystemParts.push(raw);
			if (message.sections !== undefined) {
				for (const [key, value] of Object.entries(message.sections)) {
					if (value === null) shownSections.delete(key);
					else shownSections.set(key, value);
				}
			}
		}

		const resolvedSections = new Map<string, string>(shownSections);
		/** Ephemeral turn sections, keyed `turn-context/<key>`, as the next request would see them. */
		const turnSections = new Map<string, string>();
		const contextProvider = this.options.contextProvider;
		if (contextProvider !== undefined) {
			// A live run reuses the snapshot pinned on its generation task; rendering a fresh one
			// would show context the model is not actually seeing. Otherwise this is the next run.
			const liveRunFirst = liveState?.run?.first;
			const cachedPinned =
				liveRunFirst === undefined
					? undefined
					: this.turnContextSnapshots.get(turnContextCacheKey(numericId, liveRunFirst));
			const taskPinned = inspection.tasks
				.filter(
					(task) =>
						task.record.kind === "pi.generation" &&
						task.record.conversationId === numericId &&
						task.record.memos !== undefined,
				)
				.toSorted((left, right) => (right.record.startedAt ?? 0) - (left.record.startedAt ?? 0))
				.map((task) => pinnedTurnContext(task.record.memos))
				.find((snapshot) => snapshot !== undefined);
			const pinned = cachedPinned ?? taskPinned;
			const turnRequest = {
				conversationId,
				inputs: collectRunInputs(view.entries.toReversed()),
				nowMs: Date.now(),
				triggers: collectRunTriggers(view.entries.toReversed()),
			};
			const [systemRaw, personaRaw, policyRaw, turnRaw] = await Promise.all([
				contextProvider.renderSystem?.(conversationId).catch(() => undefined),
				contextProvider.renderPersona(conversationId).catch(() => undefined),
				contextProvider.renderPolicy?.(conversationId).catch(() => undefined),
				pinned === undefined
					? contextProvider.renderTurnContext?.(turnRequest).catch(() => undefined)
					: Promise.resolve(pinned.sections),
			]);
			const applyProviderSection = (key: string, value: string | undefined) => {
				if (value === undefined || value.trim().length === 0) {
					resolvedSections.delete(key);
				} else {
					resolvedSections.set(key, `<${key}>\n${value}\n</${key}>`);
				}
			};
			if (contextProvider.renderSystem !== undefined) {
				applyProviderSection(SYSTEM_SECTION_KEY, systemRaw);
			}
			applyProviderSection(PERSONA_SECTION_KEY, personaRaw);
			if (contextProvider.renderPolicy !== undefined) {
				applyProviderSection(POLICY_SECTION_KEY, policyRaw);
			}
			for (const entry of turnRaw ?? []) {
				const block = renderTurnContextBlock([entry]);
				if (block === undefined) continue;
				turnSections.set(`${TURN_CONTEXT_SECTION_PREFIX}${entry.key}`, block);
			}
		}
		if (agent.instructions !== undefined && agent.instructions.trim().length > 0) {
			resolvedSections.set(
				"instructions",
				`<instructions>\n${agent.instructions}\n</instructions>`,
			);
		}

		let personaTokens = 0;
		let policyTokens = 0;
		let memoriesTokens = 0;
		let turnContextTokens = 0;
		let otherSystemTokens =
			rawSystemParts.length === 0 ? 0 : estimateTextTokens(rawSystemParts.join("\n\n"));
		const sectionItems: { key: string; text: string; tokens: number }[] = [];
		for (const [key, text] of resolvedSections) {
			const tokens = estimateTextTokens(text);
			if (tokens <= 0) continue;
			sectionItems.push({ key, text, tokens });
			if (key === PERSONA_SECTION_KEY) personaTokens += tokens;
			else if (key === POLICY_SECTION_KEY) policyTokens += tokens;
			else otherSystemTokens += tokens;
		}
		if (turnSections.size > 0) {
			// The wrapper tags cost a few tokens of their own; attribute them to turn context.
			const wrapperTokens = estimateTextTokens(`<${TURN_CONTEXT_TAG}>\n</${TURN_CONTEXT_TAG}>`);
			turnContextTokens += wrapperTokens;
			for (const [key, text] of turnSections) {
				const tokens = estimateTextTokens(text);
				if (tokens <= 0) continue;
				sectionItems.push({ key, text, tokens });
				if (key === `${TURN_CONTEXT_SECTION_PREFIX}${TURN_MEMORIES_KEY}`) memoriesTokens += tokens;
				else turnContextTokens += tokens;
			}
		}
		if (rawSystemParts.length > 0) {
			const rawTokens = estimateTextTokens(rawSystemParts.join("\n\n"));
			if (rawTokens > 0)
				sectionItems.unshift({
					key: "system",
					text: rawSystemParts.join("\n\n"),
					tokens: rawTokens,
				});
		}

		const nonSystemMessages = view.messages.filter((message) => message.role !== "system");
		const estimatedMessagesTokens = nonSystemMessages.reduce(
			(sum, message) => sum + estimateMessageTokens(message),
			0,
		);
		const afterHead = view.head?.id;
		let measuredAssistant:
			| Extract<(typeof view.messages)[number], { role: "assistant" }>
			| undefined;
		for (
			let index = view.entries.length - 1;
			index >= 0 && measuredAssistant === undefined;
			index--
		) {
			const entry = view.entries[index];
			if (entry === undefined) continue;
			if (afterHead !== undefined && entry.id <= afterHead) continue;
			const contribution = view.contributions[index] ?? [];
			for (let msgIndex = contribution.length - 1; msgIndex >= 0; msgIndex--) {
				const candidate = contribution[msgIndex];
				if (candidate?.role === "assistant" && calculateContextTokens(candidate.usage) > 0) {
					measuredAssistant = candidate;
					break;
				}
			}
		}

		const measuredUsageTokens =
			measuredAssistant === undefined ? null : calculateContextTokens(measuredAssistant.usage);
		const estimatedSystemTotal =
			toolsTokens +
			personaTokens +
			policyTokens +
			memoriesTokens +
			turnContextTokens +
			otherSystemTokens;

		let messagesTokens = estimatedMessagesTokens;
		let usedTokens = estimatedSystemTotal + messagesTokens;
		let tokenSource: "usage" | "estimated" = "estimated";

		if (measuredAssistant !== undefined && measuredUsageTokens !== null) {
			const measuredIndex = view.messages.lastIndexOf(measuredAssistant);
			const trailingTokens =
				measuredIndex < 0
					? 0
					: view.messages
							.slice(measuredIndex + 1)
							.filter((message) => message.role !== "system")
							.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
			const measuredTotal = measuredUsageTokens + trailingTokens;
			if (measuredTotal >= estimatedSystemTotal) {
				messagesTokens = measuredTotal - estimatedSystemTotal;
				usedTokens = measuredTotal;
				tokenSource = "usage";
			}
		}

		const freeSpaceTokens =
			contextWindow > 0 ? Math.max(0, contextWindow - usedTokens - bufferTokens) : 0;
		const usedPercent = contextWindow > 0 ? Math.min(100, (usedTokens / contextWindow) * 100) : 0;

		return {
			autocompact: {
				backgroundTokens,
				bufferTokens,
				enabled: autocompactEnabled,
				keepRecentTokens,
			},
			categories: {
				memoriesTokens,
				messagesTokens,
				otherSystemTokens,
				personaTokens,
				policyTokens,
				toolsTokens,
				turnContextTokens,
			},
			compacted: view.head?.kind === CompactionEntry.kind,
			contextWindow,
			deferredToolsTokens,
			freeSpaceTokens,
			measuredUsageTokens,
			messageCount: nonSystemMessages.length,
			model: {
				modelId: modelRef.modelId,
				providerId: modelRef.provider,
			},
			sections: sectionItems,
			tokenSource,
			tools: toolItems,
			usedPercent,
			usedTokens,
		};
	}

	private resolveInspectTools(
		agentExtensions: readonly Extension[],
		agentOffered: readonly ToolRegistration[],
		agentDeferred: readonly ToolRegistration[],
		agentState:
			| {
					tools?: string[] | { remove: string[] };
					modelTools?: string[] | { remove?: string[]; add?: string[] };
			  }
			| undefined,
		omittedTools?: readonly string[],
	): { offeredTools: ToolRegistration[]; deferredTools: ToolRegistration[] } {
		const selectedNames = new Set(agentExtensions.map((extension) => extension.name));
		const omittedWhenUnsynced =
			agentState?.modelTools === undefined ? new Set(omittedTools ?? []) : new Set<string>();

		const offeredMap = new Map<string, ToolRegistration>();
		const deferredMap = new Map<string, ToolRegistration>();
		for (const tool of agentOffered) {
			if (!omittedWhenUnsynced.has(tool.name)) offeredMap.set(tool.name, tool);
		}
		for (const tool of agentDeferred) {
			if (!omittedWhenUnsynced.has(tool.name)) deferredMap.set(tool.name, tool);
		}

		for (const extension of this.extensions.values()) {
			if (selectedNames.has(extension.name)) continue;
			for (const tool of extension.tools ?? []) {
				if (tool.callers !== undefined && !tool.callers.includes("model")) continue;
				if (Array.isArray(agentState?.tools)) {
					if (!agentState.tools.includes(tool.name)) continue;
				} else if (agentState?.tools?.remove.includes(tool.name)) {
					continue;
				}
				const modelTools = agentState?.modelTools;
				if (Array.isArray(modelTools)) {
					if (!modelTools.includes(tool.name)) continue;
					offeredMap.set(tool.name, tool);
					continue;
				}
				if (modelTools?.remove?.includes(tool.name) || omittedWhenUnsynced.has(tool.name)) {
					continue;
				}
				if (tool.deferred === true && !modelTools?.add?.includes(tool.name)) {
					deferredMap.set(tool.name, tool);
				} else {
					offeredMap.set(tool.name, tool);
				}
			}
		}

		return {
			deferredTools: [...deferredMap.values()],
			offeredTools: [...offeredMap.values()],
		};
	}

	/**
	 * Point-in-time activity fence for one conversation: whether a run is working on it and how
	 * many submissions are queued or placed. Read-only; used by admin flows that must not mutate
	 * a conversation while delivery or a run is in flight.
	 */
	async conversationActivity(
		conversationId: string,
	): Promise<{ busy: boolean; pendingSubmissions: number } | undefined> {
		const parsedNumeric = Number(conversationId);
		if (!Number.isSafeInteger(parsedNumeric)) return undefined;
		const harness = await this.openHarness();
		const numericId = parsedNumeric as ConversationId;
		// An idle conversation has no live document; the in-process run map and the live-run
		// snapshot are the same source `appendLocked` fences against, so both are consulted.
		if (this.activeRunSince(String(numericId)) !== undefined) {
			return { busy: true, pendingSubmissions: 0 };
		}
		const live = await harness.snapshot(LiveDoc, numericId, BACKGROUND_CONTEXT);
		const working = live?.run !== undefined && live.run.inputs.length > 0;
		const inspection = await harness.inspect(BACKGROUND_CONTEXT);
		const conversationIdText = String(numericId);
		let pendingSubmissions = 0;
		for (const submission of inspection.submissions) {
			if (String(submission.conversationId) !== conversationIdText) continue;
			if (submission.status === "queued" || submission.status === "placed") {
				pendingSubmissions += 1;
			}
		}
		return { busy: working || pendingSubmissions > 0, pendingSubmissions };
	}

	async resumeActivityWindow(conversationId: string): Promise<void> {
		const harness = await this.openHarness();
		const numericId = Number(conversationId) as ConversationId;
		const window = await harness.snapshot(
			activityWindowDoc,
			numericId,
			`${numericId}:activity`,
			BACKGROUND_CONTEXT,
		);
		if (!window || window.status !== "collecting" || window.envelopes.length === 0) return;
		const policy = await this.readPolicy(numericId);
		const latest = envelopeObservedAtMs(window.envelopes.at(-1)) ?? window.openedAtMs;
		const remainingMs = policy.pacing.burstSettleMs - (Date.now() - latest);
		this.scheduleActivityFlush(conversationId, Math.max(0, remainingMs));
	}

	/**
	 * Persist the effective domain policy into the durable conversation document. The server
	 * policy service owns resolution and revision history; this method only syncs the active
	 * document so activity aggregation and pacing read from one durable source.
	 */
	async updatePolicy(
		conversationId: string,
		policy: ConversationPolicy,
		agentSettings?: ConversationAgentSettings,
	): Promise<void> {
		const parsed = conversationPolicySchema.parse(policy);
		await withConversationLock(
			conversationId,
			async () => {
				const harness = await this.openHarness();
				const numericId = Number(conversationId) as ConversationId;
				const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
				if (conversation === undefined)
					throw new Error(`Conversation not found: ${conversationId}`);
				await conversation.commit(async (tx) => {
					const seed = JSON.parse(JSON.stringify(parsed)) as JsonObject;
					const document = await tx.doc(conversationPolicyDoc, numericId, "policy", seed);
					document.policyJson = JSON.stringify(parsed);
				}, BACKGROUND_CONTEXT);
				// Compaction thresholds and the selected model/effort live in the conversation's
				// agent document, not in the policy document the host reads for ping/pacing. Keep
				// them aligned here so a default saved in Settings also covers sessions that never
				// open their inspector.
				const agent = await conversation.agent(BACKGROUND_CONTEXT);
				const hostModelRef = {
					modelId: this.model.modelId,
					providerId: this.model.providerId,
				};
				const currentModel =
					agent.model === undefined
						? undefined
						: this.resolveModelRef({
								modelId: agent.model.modelId,
								providerId: agent.model.provider,
							});
				const requestedModel =
					agentSettings?.model === undefined
						? undefined
						: agentSettings.model === null
							? null
							: this.resolveModelRef({
									modelId: agentSettings.model.modelId,
									providerId: agentSettings.model.providerId,
								});
				if (
					agentSettings?.model !== undefined &&
					agentSettings.model !== null &&
					requestedModel === undefined
				) {
					this.logger.warn("Conversation model is unavailable; using host default", {
						conversationId,
						modelId: agentSettings.model.modelId,
						providerId: agentSettings.model.providerId,
					});
				}
				const targetModel =
					agentSettings?.model === undefined
						? (currentModel ?? hostModelRef)
						: (requestedModel ?? hostModelRef);
				const agentModel = this.model.models.getModel(targetModel.providerId, targetModel.modelId);
				const contextWindow =
					agentModel?.contextWindow ??
					this.model.models.getModel(hostModelRef.providerId, hostModelRef.modelId)
						?.contextWindow ??
					0;
				await conversation.configure(
					{
						compaction: this.compactionSettings(parsed.compaction, contextWindow),
						model: {
							modelId: targetModel.modelId,
							provider: targetModel.providerId,
						},
						...(agentSettings?.thinkingLevel === undefined
							? {}
							: { thinkingLevel: agentSettings.thinkingLevel }),
					},
					BACKGROUND_CONTEXT,
				);
			},
			this.executionLock,
		);
	}

	/**
	 * Per-conversation model-tool filter. Used to remove coding tools from normal IM
	 * conversations without weakening the plugin-level policy decision.
	 */
	async updateModelTools(
		conversationId: string,
		options: { readonly remove: readonly string[] },
	): Promise<void> {
		await this.updateToolAccess(conversationId, options);
	}

	/**
	 * Per-conversation tool access. Removing from `tools` keeps a tool out of the request and
	 * out of `tool_search` candidates; removing from `modelTools` also unloads a deferred tool
	 * that an earlier turn had loaded.
	 */
	async updateToolAccess(
		conversationId: string,
		options: { readonly remove: readonly string[] },
	): Promise<void> {
		const signature = [...options.remove].toSorted().join("\0");
		if (this.modelToolsSignatures.get(conversationId) === signature) return;
		await withConversationLock(
			conversationId,
			async () => {
				const harness = await this.openHarness();
				const numericId = Number(conversationId) as ConversationId;
				const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
				if (conversation === undefined) {
					throw new Error(`Conversation not found: ${conversationId}`);
				}
				const removeNames = new Set(options.remove);
				const snapshotTools = this.registry.snapshot().tools();
				const byName = new Map(snapshotTools.map(({ tool }) => [tool.name, tool]));
				const registrations = snapshotTools
					.filter(({ tool }) => removeNames.has(tool.name))
					.map(({ tool }) => tool);
				// `tool_search` records loaded tools in `modelTools.add`; rewriting the filter
				// must keep them, or every turn would unload what the model already discovered.
				const state = await harness.snapshot(AgentDoc, numericId, BACKGROUND_CONTEXT);
				const storedModelTools = state?.modelTools;
				const storedFilter = Array.isArray(storedModelTools) ? undefined : storedModelTools;
				const modelTools =
					Array.isArray(storedModelTools) && storedModelTools.length > 0
						? storedModelTools.flatMap((name) => {
								const tool = removeNames.has(name) ? undefined : byName.get(name);
								return tool === undefined ? [] : [tool];
							})
						: {
								remove: registrations,
								...(storedFilter?.add === undefined || storedFilter.add.length === 0
									? {}
									: {
											add: storedFilter.add.flatMap((name) => {
												const tool = byName.get(name);
												return tool === undefined ? [] : [tool];
											}),
										}),
							};
				await conversation.configure(
					{
						modelTools,
						tools: { remove: registrations },
					},
					BACKGROUND_CONTEXT,
				);
				this.modelToolsSignatures.set(conversationId, signature);
			},
			this.executionLock,
		);
	}

	/** Registered tools whose declared surface excludes the given one. */
	modelToolNamesNotForSurface(surface: "chat" | "coding"): readonly string[] {
		return this.registry
			.snapshot()
			.tools()
			.filter(({ tool }) => {
				const declared = (tool as ToolRegistration & { readonly surface?: string }).surface;
				return declared !== undefined && declared !== "both" && declared !== surface;
			})
			.map(({ tool }) => tool.name);
	}

	/**
	 * Replace a conversation's model-tool filter with an explicit allowlist. An empty list offers
	 * the model no tools at all, which is the fail-closed fallback when the domain policy cannot
	 * be read: a turn may still answer, but it cannot reach a privileged tool.
	 */
	async setModelToolAllowlist(
		conversationId: string,
		allowedNames: readonly string[],
	): Promise<void> {
		const signature = `allow:${[...allowedNames].toSorted().join("\0")}`;
		if (this.modelToolsSignatures.get(conversationId) === signature) return;
		await withConversationLock(
			conversationId,
			async () => {
				const harness = await this.openHarness();
				const numericId = Number(conversationId) as ConversationId;
				const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
				if (conversation === undefined) {
					throw new Error(`Conversation not found: ${conversationId}`);
				}
				const allow = new Set(allowedNames);
				const registrations = this.registry
					.snapshot()
					.tools()
					.filter(({ tool }) => allow.has(tool.name))
					.map(({ tool }) => tool);
				await conversation.configure(
					{ modelTools: registrations, tools: registrations },
					BACKGROUND_CONTEXT,
				);
				this.modelToolsSignatures.set(conversationId, signature);
			},
			this.executionLock,
		);
	}

	private async readPolicy(conversationId: ConversationId): Promise<ConversationPolicy> {
		const harness = await this.openHarness();
		const document = await harness.snapshot(
			conversationPolicyDoc,
			conversationId,
			"policy",
			BACKGROUND_CONTEXT,
		);
		if (!document) return this.policy;
		try {
			const legacy = document as unknown as JsonObject;
			const source =
				typeof legacy.policyJson === "string" ? (JSON.parse(legacy.policyJson) as unknown) : legacy;
			const parsed = conversationPolicySchema.safeParse(source);
			return parsed.success ? parsed.data : this.policy;
		} catch {
			return this.policy;
		}
	}

	/**
	 * Replace the host-installed dynamic extensions, leaving the context extension in place.
	 * Idempotent by extension name; existing conversations are checked again on their next
	 * append so an explicitly stored extension list gains the new extension.
	 */
	installExtensions(next: readonly Extension[]): void {
		const incoming = new Map(next.map((extension) => [extension.name, extension]));
		for (const name of this.dynamicExtensions) {
			if (incoming.has(name)) continue;
			if (name === this.toolSearchExtension.name) continue;
			const installed = this.extensions.get(name);
			if (installed !== undefined) {
				this.registry.uninstall(installed);
				this.extensions.delete(name);
				this.clearExtensionChecks(name);
			}
		}
		for (const [name, extension] of incoming) {
			if (name === this.contextExtension?.name) {
				throw new Error(`Extension ${name} is reserved by the conversation context`);
			}
			if (name === this.toolSearchExtension.name) {
				throw new Error(`Extension ${name} is reserved by the tool search surface`);
			}
			this.extensions.set(name, extension);
			this.registry.install(extension);
			this.clearExtensionChecks(name);
		}
		this.dynamicExtensions.clear();
		for (const name of incoming.keys()) this.dynamicExtensions.add(name);
	}

	/**
	 * Make sure every installed extension is selected by this conversation. New and default
	 * conversations resolve every installed extension automatically; this covers conversations
	 * whose stored selection explicitly lists extensions. Each extension is checked once per
	 * conversation per process, and failures only log: extensions must never block messages.
	 */
	private async ensureExtensions(conversation: Conversation, durableId: string): Promise<void> {
		for (const extension of this.extensions.values()) {
			const key = `${durableId}\0${extension.name}`;
			if (this.extensionsEnsured.has(key)) continue;
			try {
				const agent = await conversation.agent(BACKGROUND_CONTEXT);
				if (!agent.extensions.some((candidate) => candidate.name === extension.name)) {
					await conversation.configure({ extensions: { add: [extension] } }, BACKGROUND_CONTEXT);
				}
				this.extensionsEnsured.add(key);
			} catch (error) {
				this.logger.error("Failed to ensure conversation extension", {
					conversationId: durableId,
					error,
					extension: extension.name,
				});
			}
		}
	}

	private clearExtensionChecks(name: string): void {
		const suffix = `\0${name}`;
		for (const key of this.extensionsEnsured) {
			if (key.endsWith(suffix)) this.extensionsEnsured.delete(key);
		}
	}

	/**
	 * Map the user-facing compaction policy onto pi-durable's reserve-based thresholds. A
	 * positive `triggerTokens` is an absolute threshold, so the reserve is derived from the
	 * active model window while still leaving enough output budget for the summary.
	 */
	private compactionSettings(
		policy: ConversationPolicy["compaction"],
		contextWindow: number,
	): {
		backgroundTokens: number;
		enabled: boolean;
		keepRecentTokens: number;
		reserveTokens: number;
	} {
		const triggerReserve =
			policy.triggerTokens > 0 && contextWindow > 0
				? Math.max(MIN_COMPACTION_RESERVE_TOKENS, contextWindow - policy.triggerTokens)
				: undefined;
		return {
			backgroundTokens: policy.backgroundTokens,
			enabled: policy.enabled,
			keepRecentTokens: policy.keepRecentTokens,
			reserveTokens: triggerReserve ?? policy.reserveTokens,
		};
	}

	/**
	 * Keep existing durable conversations aligned with the active model provider. Conversations
	 * created while the server was unconfigured (using `fake-deterministic`) or before a
	 * provider/model change would otherwise fail `GenerationTask` with `failNoModel` or keep
	 * replying with the deterministic fake model.
	 */
	private async ensureAgentModel(conversation: Conversation, durableId: string): Promise<void> {
		if (this.modelsEnsured.has(durableId)) return;
		try {
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			const current = agent.model;
			const resolved =
				current === undefined
					? undefined
					: this.model.models.getModel(current.provider, current.modelId);
			if (
				current === undefined ||
				current.provider !== this.model.providerId ||
				resolved === undefined
			) {
				const nextModel = {
					modelId: this.model.modelId,
					provider: this.model.providerId,
				};
				const policy = await this.readPolicy(Number(durableId) as ConversationId);
				const contextWindow =
					this.model.models.getModel(nextModel.provider, nextModel.modelId)?.contextWindow ?? 0;
				await conversation.configure(
					{
						compaction: this.compactionSettings(policy.compaction, contextWindow),
						model: nextModel,
					},
					BACKGROUND_CONTEXT,
				);
			}
			this.modelsEnsured.add(durableId);
		} catch (error) {
			this.logger.error("Failed to ensure conversation model", {
				conversationId: durableId,
				error,
			});
		}
	}

	private emitActivityEvent(event: ActivityWindowEvent): void {
		const callback = this.options.onActivityEvent;
		if (callback === undefined) return;
		try {
			callback(event);
		} catch (error) {
			this.logger.error("Activity event callback failed", {
				activityId: event.activityId,
				conversationId: event.conversationId,
				error,
				type: event.type,
			});
		}
	}

	private envelopeToText(envelope: MessageEnvelope): string {
		return messagePartsText(envelope.parts);
	}

	/**
	 * Resolve a stored agent model reference against the host catalog. The same fallback the
	 * inspector uses applies here: an unset, foreign-provider, or unknown model means the host
	 * model is what actually runs the turn.
	 */
	private effectiveModelRef(agentModelRef: ModelRef | undefined): ModelRef {
		const useHostModel =
			agentModelRef === undefined ||
			agentModelRef.provider !== this.model.providerId ||
			this.model.models.getModel(agentModelRef.provider, agentModelRef.modelId) === undefined;
		return useHostModel
			? { modelId: this.model.modelId, provider: this.model.providerId }
			: agentModelRef;
	}

	/**
	 * Model input for a batch of envelopes.
	 *
	 * Text-only input is the common case and stays a plain string. For a vision model each
	 * envelope keeps its own text/image order: a caption stays beside its picture, and a burst
	 * cannot reorder one speaker's image after another speaker's text. Media the host cannot
	 * resolve stays an explicit placeholder instead of disappearing from the text.
	 */
	private async envelopesToInput(
		envelopes: readonly StoredEnvelope[],
		conversation: Conversation,
	): Promise<UserInput> {
		const resolve = this.options.resolveImage;
		if (resolve === undefined) return this.envelopesToText(envelopes);
		// A text-only model must not receive image blocks: the provider either rejects the
		// request or silently drops them, and the placeholder text is the honest description of
		// what that model can actually use.
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		if (!this.modelAcceptsImages(this.effectiveModelRef(agent.model))) {
			return this.envelopesToText(envelopes);
		}

		const blocks: Exclude<UserInput, string> = [];
		const attached = this.attachedContexts(envelopes);
		if (attached.length > 0) {
			blocks.push({ text: attached.join("\n\n"), type: "text" });
		}
		let sawMedia = false;
		for (const envelope of envelopes) {
			let textParts: string[] = [`${envelopeHeader(envelope, this.turnFormat)}:`];
			const flushText = () => {
				const text = applyMentionLabels(
					textParts.join(" ").trim(),
					(envelope as RenderableEnvelope).mentions,
				);
				if (text.length > 0) blocks.push({ text, type: "text" });
				textParts = [];
			};
			const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
			for (const part of parts) {
				const parsed = messagePartSchema.safeParse(part);
				if (!parsed.success) {
					if (typeof part === "object" && part !== null && "type" in part) {
						textParts.push(`[${String(part.type)}]`);
					}
					continue;
				}
				const messagePart = parsed.data;
				if (messagePart.type !== "image" && messagePart.type !== "sticker") {
					textParts.push(messagePartText(messagePart));
					continue;
				}
				sawMedia = true;
				let resolved: { data: string; mimeType: string } | undefined;
				try {
					resolved = await resolve(messagePart);
				} catch {
					// An unreadable blob stays a placeholder; it must not fail the turn.
				}
				if (resolved === undefined) {
					textParts.push(`[${messagePart.type} unavailable]`);
					continue;
				}
				flushText();
				blocks.push({
					data: resolved.data,
					mimeType: resolved.mimeType,
					type: "image",
				});
			}
			flushText();
		}
		return sawMedia ? blocks : this.envelopesToText(envelopes);
	}

	/** Whether the model that runs the turn declares image input. */
	private modelAcceptsImages(modelRef: ModelRef): boolean {
		const model = this.model.models.getModel(modelRef.provider, modelRef.modelId);
		return model?.input.includes("image") === true;
	}

	/** Durable caller-attached context, deduplicated in arrival order. */
	private attachedContexts(envelopes: readonly StoredEnvelope[]): string[] {
		return [
			...new Set(
				envelopes
					.map((envelope) => envelope.attachedContext)
					.filter((value): value is string => typeof value === "string" && value.length > 0),
			),
		];
	}

	/** Clock zone for durable turn lines. */
	private get turnFormat(): TurnFormatOptions {
		return this.options.timeZone === undefined ? {} : { timeZone: this.options.timeZone };
	}

	/**
	 * Durable user message text: one `[HH:mm] Speaker [reply to …]: content` line per envelope,
	 * preceded only by explicitly attached context. Trigger telemetry stays out of the
	 * transcript; the turn-context hook delivers it ephemerally.
	 */
	private envelopesToText(envelopes: readonly StoredEnvelope[]): string {
		const attached = this.attachedContexts(envelopes);
		const text = envelopes
			.map((envelope) => {
				const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
				const content = parts
					.map((part) => {
						const parsed = messagePartSchema.safeParse(part);
						if (parsed.success) return messagePartText(parsed.data);
						return typeof part === "object" && part !== null && "type" in part
							? `[${String(part.type)}]`
							: "";
					})
					.filter(Boolean)
					.join(" ");
				return formatEnvelopeLine(envelope, content, this.turnFormat);
			})
			.join("\n");
		return attached.length === 0 ? text : `${attached.join("\n\n")}\n\n${text}`;
	}

	private toStoredEnvelope(
		envelope: MessageEnvelope,
		input: Pick<AppendConversationInput, "attachedContext" | "turnContext">,
	): StoredEnvelope {
		const stored = JSON.parse(JSON.stringify(envelope)) as StoredEnvelope;
		const turn = input.turnContext;
		if (turn !== undefined) {
			const turnContext: NonNullable<StoredEnvelope["turnContext"]> = {};
			if (turn.classification !== undefined) turnContext.classification = turn.classification;
			if (turn.cue !== undefined && turn.cue.trim().length > 0) turnContext.cue = turn.cue;
			if (turn.promptHooks !== undefined && turn.promptHooks.trim().length > 0) {
				turnContext.promptHooks = turn.promptHooks;
			}
			if (Object.keys(turnContext).length > 0) stored.turnContext = turnContext;
		}
		if (input.attachedContext !== undefined && input.attachedContext.trim().length > 0) {
			stored.attachedContext = input.attachedContext;
		}
		return stored;
	}

	private async openHarness(): Promise<DurableHarness> {
		if (this.harness) return this.harness;
		this.harness = await Harness.open(
			this.options.storage,
			{ models: () => this.model.models, registry: this.registry },
			BACKGROUND_CONTEXT,
		);
		return this.harness;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const scheduled of this.activityTimers.values()) clearTimeout(scheduled.timer);
		this.activityTimers.clear();
		for (const hold of this.busyHolds.values()) {
			if (hold.timer !== undefined) clearTimeout(hold.timer);
		}
		this.busyHolds.clear();
		// Close the Session before the watchers. Ending the Session line makes any document load
		// still queued on it fail inside the library instead of reaching storage after the caller
		// closes the handle, which would surface as a spurious "SqliteStorage is closed" error.
		// Copy the keys: `stopLiveRun` deletes from the map it is iterating.
		for (const conversationId of Array.from(this.liveRuns.keys())) this.stopLiveRun(conversationId);
		await Promise.allSettled(Array.from(this.pendingPolls));
		await Promise.allSettled(Array.from(this.pendingFlushes));
		if (this.harness) await this.harness.close(BACKGROUND_CONTEXT);
	}
}
