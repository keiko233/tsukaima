import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Tool } from "@earendil-works/pi-ai";
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
	type RunFailure,
	type Submission,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";
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
} from "@elaina/contracts";
import type { SqliteStorage } from "@elaina/durable";
import {
	createContextExtension,
	MEMORY_SECTION_KEY,
	PERSONA_SECTION_KEY,
	POLICY_SECTION_KEY,
	type ContextPromptProvider,
} from "./context.ts";
import {
	ConversationExecutionLock,
	defaultConversationExecutionLock,
	withConversationLock,
} from "./execution-lock.ts";
import { createFakeModel, type ModelPort } from "./model.ts";
import { busyDisposition } from "./output-pacing.ts";
import { shouldCloseActivityWindow } from "./index.ts";

type StoredEnvelope = JsonObject & {
	readonly id: string;
	readonly source: JsonObject & {
		readonly timestampMs: number;
		readonly receivedAtMs?: number;
	};
	triggerContext?: string;
};

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
	kind: "elaina.messageReceipt",
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
	/** Compact trigger contract appended to the model submission for direct/soft turns. */
	readonly triggerContext?: string;
	readonly classification?: TriggerClassification;
	/** Collect only; the router uses this while a cooldown/rate limit is active. */
	readonly collectOnly?: boolean;
	readonly conversationId: string;
	readonly envelope: MessageEnvelope;
	readonly forceSubmit?: boolean;
	readonly submittedAtMs: number;
	readonly whenBusy?: "steer" | "follow-up";
}

/**
 * One settled assistant answer. Emitted by the host after an input run produced an
 * assistant entry, so the server can deliver it to the origin channel.
 */
export interface ConversationAnswer {
	/** Durable activity (submission request id) the answer belongs to. */
	readonly activityId: string;
	/** Durable conversation the answer was produced in. */
	readonly conversationId: string;
	/** Entry id of the assistant entry holding the answer text. */
	readonly entryId: string;
	/** Concatenated text blocks of the assistant answer. */
	readonly text: string;
}

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
}

export interface BackgroundTurnResult {
	readonly activityId: string;
	readonly entryId: string;
	readonly requestId: string;
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
	readonly model?: ModelPort;
	/** Convenience for tests: deterministic fake-model replies, ignored when `model` is set. */
	readonly responses?: readonly string[];
	/** Observe activity-window opens and closes. Errors never affect message processing. */
	readonly onActivityEvent?: (event: ActivityWindowEvent) => void;
	/**
	 * Observe settled assistant answers. Called detached from `append()`/activity flush so a
	 * slow consumer never blocks ingestion; rejections are caught and logged, never surfaced.
	 */
	readonly onAnswer?: (answer: ConversationAnswer) => Promise<void> | void;
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
	/** How long a busy run may still be steered before a follow-up is queued. */
	readonly steerGraceMs?: number;
	readonly storage: SqliteStorage;
}

/**
 * One observation of a conversation's live run, in the local clock domain. `undefined` means the
 * run settled: the caller clears whatever it was showing.
 */
export type LiveRunSnapshot = {
	readonly conversationId: string;
	/**
	 * `true` when the run ended. The WebUI clears its activity view on this, which is why the
	 * end is explicit rather than inferred from empty fields: a run that has not streamed text
	 * yet looks identical to one that settled.
	 */
	readonly settled: boolean;
	readonly failure: string | undefined;
	/** Streamed answer text so far. */
	readonly partialText: string | undefined;
	/** Streamed reasoning so far, when the provider reports it. */
	readonly partialThinking: string | undefined;
	readonly startedAtMs: number;
	readonly tools: readonly {
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

/** A settled run: nothing to show, and the client clears its activity view. */
function emptyLiveRun(conversationId: string, startedAtMs: number): LiveRunSnapshot {
	return {
		conversationId,
		failure: undefined,
		partialText: undefined,
		partialThinking: undefined,
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

/** Flatten durable live state into the snapshot the WebUI renders. */
function toLiveRunSnapshot(
	conversationId: string,
	startedAtMs: number,
	live: LiveState,
): LiveRunSnapshot {
	const tools = (live.tools ?? []).map((slot) => ({
		callId: slot.callId,
		output: typeof slot.output === "string" ? slot.output : undefined,
		status: slot.status,
		toolName: slot.name,
	}));
	return {
		conversationId,
		failure: live.runFailure === undefined ? undefined : runFailureText(live.runFailure),
		partialText: partialTextOf(live.generation?.message),
		partialThinking: partialThinkingOf(live.generation?.message),
		settled: false,
		startedAtMs,
		tools,
		turns: live.run?.turns ?? 0,
	};
}

export class PiDurableConversationHost {
	private harness?: DurableHarness;
	private model: ModelPort;
	private readonly policy: ConversationPolicy;
	private readonly executionLock: ConversationExecutionLock;
	private readonly steerGraceMs: number;
	private readonly activeRuns = new Map<string, Map<string, { startedAtMs: number }>>();
	private readonly activityTimers = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
	private readonly activityFlushes = new Set<string>();
	private readonly contextExtension: Extension | undefined;
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
				: createContextExtension(options.contextProvider);
		if (this.contextExtension !== undefined) {
			this.extensions.set(this.contextExtension.name, this.contextExtension);
			this.registry.install(this.contextExtension);
		}
		if (options.extensions !== undefined) this.installExtensions(options.extensions);
	}

	/** Replace the active model port at runtime and mark existing conversations for model sync. */
	setModel(model: ModelPort): void {
		this.model = model;
		this.modelsEnsured.clear();
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
		const storedEnvelope = this.toStoredEnvelope(input.envelope, input.triggerContext);
		const nextEnvelopes = shouldOpen ? [storedEnvelope] : [...envelopes, storedEnvelope];
		// Pacing compares against `submittedAtMs`, which is local. Envelope timestamps come from
		// the remote platform's clock, so using them here made the settle window unreachable
		// whenever the platform clock ran ahead. Prefer the locally observed time.
		const firstMessageAtMs = envelopeObservedAtMs(nextEnvelopes[0]) ?? input.submittedAtMs;
		const latestMessageAtMs = envelopeObservedAtMs(nextEnvelopes.at(-1)) ?? input.submittedAtMs;
		const longMessage =
			messagePartsText(input.envelope.parts).length >= pacing.burstLongMessageThreshold;
		const windowClosed = shouldCloseActivityWindow(
			firstMessageAtMs,
			input.submittedAtMs,
			pacing,
			latestMessageAtMs,
		);
		const shouldSubmit =
			input.forceSubmit === true ||
			(input.collectOnly !== true &&
				(nextEnvelopes.length >= pacing.burstMaxMessages || longMessage || windowClosed));
		const activeSinceMs = this.activeRunSince(input.conversationId);
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
		const submissionId = await conversation.commit(async (tx) => {
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
			return conversation.submit(
				tx,
				shouldSubmit
					? {
							type: "input",
							content: await this.envelopesToInput(nextEnvelopes),
							entry,
							requestId: activitySubmissionRequestId(activityId, input.envelope.id),
							whenBusy: whenBusy === "follow-up" ? "followUp" : whenBusy,
						}
					: {
							type: "write",
							entry,
							requestId: `${activityId}:${input.envelope.id}`,
						},
			);
		}, BACKGROUND_CONTEXT);
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
			this.observeAnswer(harness, input.conversationId, submission, String(submissionId));
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
	): void {
		const onAnswer = this.options.onAnswer;
		if (submission === undefined) {
			if (submissionId !== undefined) this.untrackSubmission(conversationId, submissionId);
			return;
		}
		this.watchLiveRun(harness, conversationId);
		void (async () => {
			try {
				const settled = await submission.wait(BACKGROUND_CONTEXT);
				if (onAnswer === undefined) return;
				if (settled.type !== "input" || settled.status !== "done") return;
				const answerId = settled.answer;
				const entry = await harness.commit((tx) => tx.entry(answerId), BACKGROUND_CONTEXT);
				if (entry === undefined) return;
				const text = assistantEntryText(entry);
				if (text === undefined) return;
				await onAnswer({
					activityId: activityIdFromSubmissionRequestId(settled.requestId ?? ""),
					conversationId,
					entryId: String(answerId),
					text,
				});
			} catch (error) {
				if (this.closed) return;
				console.error("Failed to observe conversation answer", error);
			} finally {
				if (submissionId !== undefined) this.untrackSubmission(conversationId, submissionId);
			}
		})();
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
		// Poll `pi.live` instead of attaching a document watch. `watchDoc` mounts an observer on
		// the Session line, whose document load can still be queued when the host closes, and
		// then reaches storage after the caller closed the handle. A snapshot poll is a plain
		// request/response read: it never leaves a background mount behind, and stopping it is
		// just clearing a timer.
		const numericId = Number(conversationId) as ConversationId;
		const startedAtMs = Date.now();
		// The run is admitted by the same commit that flushes the activity window, but the
		// scheduler may not have started it yet when the first polls land. Seeing no run is only
		// "settled" once a run was actually observed, or after this grace period, otherwise the
		// poller would stop before the first token and report nothing.
		let sawRun = false;
		let stopped = false;
		const timer = setInterval(() => {
			if (this.closed || stopped) {
				this.stopLiveRun(conversationId);
				return;
			}
			const polling = (async () => {
				try {
					const live = await harness.snapshot(LiveDoc, numericId, BACKGROUND_CONTEXT);
					if (this.closed) return;
					const running = live?.run !== undefined;
					if (!running && !sawRun && Date.now() - startedAtMs < LIVE_RUN_START_GRACE_MS) {
						return;
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
						this.stopLiveRun(conversationId);
						if (live?.runFailure === undefined) {
							onLiveRun(emptyLiveRun(conversationId, startedAtMs));
						}
						return;
					}
					sawRun = true;
					onLiveRun(toLiveRunSnapshot(conversationId, startedAtMs, live));
				} catch {
					// Live presentation is optional; ingestion and answers must not depend on it.
					stopped = true;
					this.stopLiveRun(conversationId);
				}
			})();
			this.pendingPolls.add(polling);
			void polling.finally(() => this.pendingPolls.delete(polling));
		}, LIVE_RUN_POLL_MS);
		timer.unref?.();
		this.liveRuns.set(conversationId, { startedAtMs, timer });
	}

	/** Stop polling one conversation's live run. Safe to call when nothing is polling. */
	private stopLiveRun(conversationId: string): void {
		const poll = this.liveRuns.get(conversationId);
		if (poll === undefined) return;
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
				console.error("Failed to flush activity window", error);
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
		{
			if (this.closed) return;
			const harness = await this.openHarness();
			const numericId = Number(conversationId) as ConversationId;
			const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
			if (!conversation) return;
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
				return;
			}
			const policy = await this.readPolicy(numericId);
			if (!policy.enabled) return;
			const envelopes = window.envelopes;
			const disposition = busyDisposition(
				this.activeRunSince(conversationId),
				Date.now(),
				this.steerGraceMs,
			);
			const submissionId = await conversation.commit(async (tx) => {
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
				return conversation.submit(tx, {
					content: await this.envelopesToInput(envelopes),
					entry,
					requestId: activitySubmissionRequestId(activityId, envelopes[0]?.id ?? "window"),
					type: "input",
					whenBusy:
						disposition === "steer" && policy.steerWhenBusy === "steer"
							? "steer"
							: policy.followUpWhenBusy === "reject"
								? "followUp"
								: "followUp",
				});
			}, BACKGROUND_CONTEXT);
			this.emitActivityEvent({
				activityId,
				conversationId,
				envelopeCount: envelopes.length,
				type: "closed",
			});
			const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
			this.trackSubmission(conversationId, String(submissionId));
			this.observeAnswer(harness, conversationId, submission, String(submissionId));
		}
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
		const content = [input.context?.trim(), input.prompt.trim()]
			.filter((value): value is string => value !== undefined && value.length > 0)
			.join("\n\n");
		if (content.length === 0) throw new Error("Background turn prompt must not be empty");
		const submissionId = await conversation.commit(
			(tx) =>
				conversation.submit(tx, {
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
				}),
			BACKGROUND_CONTEXT,
		);
		const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
		const settled = await submission?.wait(BACKGROUND_CONTEXT);
		if (settled === undefined || settled.type !== "input" || settled.status !== "done") {
			throw new Error("Background turn did not settle successfully");
		}
		const entry = await harness.commit((tx) => tx.entry(settled.answer), BACKGROUND_CONTEXT);
		return {
			activityId,
			entryId: String(settled.answer),
			requestId,
			text: entry === undefined ? "" : (assistantEntryText(entry) ?? ""),
		};
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

	async compactConversation(
		conversationId: string,
		instructions?: string,
	): Promise<CompactConversationResult> {
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
		const taskId = await conversation.compact(
			trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined,
			BACKGROUND_CONTEXT,
		);
		const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
		const outcome = settled.state.outcome;
		if (outcome.status !== "completed") {
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
		return {
			compacted: entryId !== undefined || submissionId !== undefined,
			entryId: entryId === undefined ? null : String(entryId),
			submissionId: submissionId === undefined ? null : String(submissionId),
		};
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

		const [agent, agentState, view] = await Promise.all([
			conversation.agent(BACKGROUND_CONTEXT),
			harness.snapshot(AgentDoc, numericId, BACKGROUND_CONTEXT),
			conversation.context(BACKGROUND_CONTEXT),
		]);

		const agentModelRef = agent.model;
		const useHostModel =
			agentModelRef === undefined ||
			agentModelRef.provider !== this.model.providerId ||
			this.model.models.getModel(agentModelRef.provider, agentModelRef.modelId) === undefined;
		const modelRef = useHostModel
			? { modelId: this.model.modelId, provider: this.model.providerId }
			: agentModelRef;
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
		const contextProvider = this.options.contextProvider;
		if (contextProvider !== undefined) {
			const [personaRaw, policyRaw, memoriesRaw] = await Promise.all([
				contextProvider.renderPersona(conversationId).catch(() => undefined),
				contextProvider.renderPolicy?.(conversationId).catch(() => undefined),
				contextProvider.renderMemories(conversationId).catch(() => undefined),
			]);
			const applyProviderSection = (key: string, value: string | undefined) => {
				if (value === undefined || value.trim().length === 0) {
					resolvedSections.delete(key);
				} else {
					resolvedSections.set(key, `<${key}>\n${value}\n</${key}>`);
				}
			};
			applyProviderSection(PERSONA_SECTION_KEY, personaRaw);
			if (contextProvider.renderPolicy !== undefined) {
				applyProviderSection(POLICY_SECTION_KEY, policyRaw);
			}
			applyProviderSection(MEMORY_SECTION_KEY, memoriesRaw);
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
		let otherSystemTokens =
			rawSystemParts.length === 0 ? 0 : estimateTextTokens(rawSystemParts.join("\n\n"));
		const sectionItems: { key: string; tokens: number }[] = [];
		for (const [key, text] of resolvedSections) {
			const tokens = estimateTextTokens(text);
			if (tokens <= 0) continue;
			sectionItems.push({ key, tokens });
			if (key === PERSONA_SECTION_KEY) personaTokens += tokens;
			else if (key === POLICY_SECTION_KEY) policyTokens += tokens;
			else if (key === MEMORY_SECTION_KEY) memoriesTokens += tokens;
			else otherSystemTokens += tokens;
		}
		if (rawSystemParts.length > 0) {
			const rawTokens = estimateTextTokens(rawSystemParts.join("\n\n"));
			if (rawTokens > 0) sectionItems.unshift({ key: "system", tokens: rawTokens });
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
			toolsTokens + personaTokens + policyTokens + memoriesTokens + otherSystemTokens;

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
	async updatePolicy(conversationId: string, policy: ConversationPolicy): Promise<void> {
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
				const registrations = this.registry
					.snapshot()
					.tools()
					.filter(({ tool }) => removeNames.has(tool.name))
					.map(({ tool }) => tool);
				await conversation.configure({ modelTools: { remove: registrations } }, BACKGROUND_CONTEXT);
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
				console.error(`Failed to ensure conversation extension ${extension.name}`, error);
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
				await conversation.configure(
					{ model: { modelId: this.model.modelId, provider: this.model.providerId } },
					BACKGROUND_CONTEXT,
				);
			}
			this.modelsEnsured.add(durableId);
		} catch (error) {
			console.error(`Failed to ensure conversation model for ${durableId}`, error);
		}
	}

	private emitActivityEvent(event: ActivityWindowEvent): void {
		const callback = this.options.onActivityEvent;
		if (callback === undefined) return;
		try {
			callback(event);
		} catch (error) {
			console.error("Activity event callback failed", error);
		}
	}

	private envelopeToText(envelope: MessageEnvelope): string {
		return messagePartsText(envelope.parts);
	}

	/**
	 * Model input for a batch of envelopes.
	 *
	 * Text-only input is the common case and stays a plain string. When the batch carries images
	 * the caller can resolve, they become image blocks the model actually sees; an image it
	 * cannot resolve degrades to its `[image]` placeholder rather than an empty message.
	 */
	private async envelopesToInput(envelopes: readonly StoredEnvelope[]): Promise<UserInput> {
		const resolve = this.options.resolveImage;
		// A text-only model must not receive image blocks: the provider either rejects the
		// request or silently drops them, and the placeholder text is the honest description of
		// what that model can actually use.
		if (resolve === undefined || !this.modelAcceptsImages()) return this.envelopesToText(envelopes);
		const images: { data: string; mimeType: string }[] = [];
		for (const envelope of envelopes) {
			const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
			for (const part of parts) {
				const parsed = messagePartSchema.safeParse(part);
				if (!parsed.success || parsed.data.type !== "image") continue;
				try {
					const resolved = await resolve(parsed.data);
					if (resolved !== undefined) images.push(resolved);
				} catch {
					// An unreadable blob leaves the placeholder in the text; it must not fail the turn.
				}
			}
		}
		const text = this.envelopesToText(envelopes);
		if (images.length === 0) return text;
		return [
			{ text, type: "text" },
			...images.map((image) => ({
				data: image.data,
				mimeType: image.mimeType,
				type: "image" as const,
			})),
		];
	}

	/** Whether the conversation's model declares image input. */
	private modelAcceptsImages(): boolean {
		const models = this.model.models.getModels(this.model.providerId) as readonly {
			id: string;
			input?: readonly string[];
		}[];
		const model = models.find((candidate) => candidate.id === this.model.modelId);
		return model?.input?.includes("image") === true;
	}

	private envelopesToText(envelopes: readonly StoredEnvelope[]): string {
		const triggerContexts = [
			...new Set(
				envelopes
					.map((envelope) => envelope.triggerContext)
					.filter((value): value is string => typeof value === "string" && value.length > 0),
			),
		];
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
		const conversationText = envelopes.length === 1 ? text.replace(/^[^:]+:\s/, "") : text;
		return triggerContexts.length === 0
			? conversationText
			: `${triggerContexts.join("\n\n")}\n\n${conversationText}`;
	}

	private toStoredEnvelope(envelope: MessageEnvelope, triggerContext?: string): StoredEnvelope {
		const stored = JSON.parse(JSON.stringify(envelope)) as StoredEnvelope;
		if (triggerContext !== undefined && triggerContext.trim().length > 0) {
			stored.triggerContext = triggerContext;
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
