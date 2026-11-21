import type { Context } from "@earendil-works/chord/context";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
	AgentDoc,
	CompactionEntry,
	CompactionTask,
	defineExtension,
	GenerationTask,
	hook,
	LiveDoc,
	ResetEntry,
	section,
	type CompactionReason,
	type EntryRecord,
	type Extension,
	type HookApi,
	type ModelRef,
	type PromptSection,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { durableDocumentKinds } from "@tsukaima/contracts";

/**
 * Durable user message pi-durable appends when an answer stopped on its output token limit and
 * the chat run requests an automatic continuation. It stays in the transcript because the model
 * needs it as the instruction it is continuing from; activity-window scans ignore it, and
 * {@link isFinalAnswer} treats the cut answer before it as non-final for turn-context purposes.
 */
export const LENGTH_CONTINUATION_PROMPT =
	"Your previous message was cut off by the output limit. Continue exactly where it stopped, without repeating anything.";

/**
 * Transient per-turn routing information captured when an input is admitted. It is stored on
 * the durable activity envelope (so recovery replays the same turn context) but is never
 * rendered into the durable user message: only the ephemeral turn-context layer reads it.
 */
export interface TurnTrigger {
	readonly classification?: "direct" | "soft" | "ambient";
	/** Compact model-visible cue; only set for `soft` turns. */
	readonly cue?: string;
	/** Prompt-hook text consumed at admission, so a one-shot hook fires exactly once. */
	readonly promptHooks?: string;
}

/** One priority-ordered block of the ephemeral turn context. */
export interface TurnContextSection {
	/** Stable key, e.g. `clock`, `observation`, `memories`, `prompt-hooks`, `cue`. */
	readonly key: string;
	readonly text: string;
}

export interface TurnContextRequest {
	readonly conversationId: string;
	/** Wall clock when the context was rendered. */
	readonly nowMs: number;
	/** Envelope references of the run's own inputs, oldest first. */
	readonly inputs: readonly TurnContextInput[];
	/** Trigger info of the run's inputs, oldest first. */
	readonly triggers: readonly TurnTrigger[];
}

/** One model input the current run submitted, used to keep it out of the ambient window. */
export interface TurnContextInput {
	/** Stored envelope id. */
	readonly envelopeId?: string;
	/** Platform message id, when the channel supplied one. */
	readonly platformMessageId?: string;
	/** Latest input text for recall when the incoming transcript row has not landed yet. */
	readonly text?: string;
}

export interface ChatCompactionRequest {
	readonly conversationId: string;
	readonly reason: CompactionReason;
	/** Chat-readable rendering of the messages being replaced, oldest first. */
	readonly transcript: string;
	/** Summary that headed the context before this compaction, if any. */
	readonly previousSummary?: string;
	readonly instructions?: string;
	/** The model that runs this conversation; summarization should use it. */
	readonly model?: { readonly modelId: string; readonly providerId: string };
	readonly signal?: AbortSignal;
}

/**
 * Domain-agnostic seam for the Tsukaima prompt context. The server implements it over
 * Drizzle; `@tsukaima/core` never imports `@tsukaima/db`. Implementations must degrade to
 * `undefined` on any failure so prompt rendering can never break a model run.
 *
 * Static sections (`renderSystem`, `renderPersona`, `renderPolicy`) go into `pi.system` and
 * must stay byte-stable across ordinary turns so provider prefix caches hit. Anything that
 * changes per turn belongs in {@link renderTurnContext}.
 */
export interface ContextPromptProvider {
	renderSystem?(conversationId: string): Promise<string | undefined>;
	/** Persona text for one durable conversation, or `undefined` when none is bound. */
	renderPersona(conversationId: string): Promise<string | undefined>;
	/** Static, model-actionable behavior rules rendered after the persona. */
	renderPolicy?(conversationId: string): Promise<string | undefined>;
	/**
	 * Ephemeral context (clock, recent chat, recalled memories, prompt hooks, soft cue).
	 * Attached to model requests without adding an entry to the transcript. Must be read-only.
	 */
	renderTurnContext?(request: TurnContextRequest): Promise<readonly TurnContextSection[]>;
	/** Read fresh context before each model request, including tool rounds and retries. */
	readonly refreshTurnContext?: boolean;
	/**
	 * Chat-native compaction summary. Return `undefined` to fall through to pi-durable's default
	 * (coding) summarizer, which workspace conversations rely on.
	 */
	summarizeCompaction?(request: ChatCompactionRequest): Promise<string | undefined>;
	/**
	 * Whether this is an ordinary chat surface (`private`, `group`, `webui`). A failed chat
	 * summary declines compaction instead of falling back to the coding format.
	 */
	isChatConversation?(conversationId: string): Promise<boolean>;
}

/**
 * Installed extension that carries the Tsukaima context sections. Registry section keys match
 * `/^[a-z][a-z0-9_-]*$/`, so the dotted `tsukaima.persona` form is not available.
 */
export const CONTEXT_EXTENSION_NAME = "tsukaima-context";
export const SYSTEM_SECTION_KEY = "tsukaima-system";
/** Section key for the conversation's persona (rendered before policy). */
export const PERSONA_SECTION_KEY = "tsukaima-persona";
/** Section key for the static behavior rules. */
export const POLICY_SECTION_KEY = "tsukaima-policy";
/** Tag wrapping the ephemeral per-request context block. */
export const TURN_CONTEXT_TAG = "turn-context";
/** Inspector key prefix for ephemeral turn sections (`turn-context/<key>`). */
export const TURN_CONTEXT_SECTION_PREFIX = `${TURN_CONTEXT_TAG}/`;
/** Turn section key that carries recalled memories; the inspector reports it separately. */
export const TURN_MEMORIES_KEY = "memories";
/** Generation-task memo that pins one run's turn context across tool rounds and recovery. */
export const TURN_CONTEXT_MEMO = "tsukaima.turnContext";
/** Bound on how far back the hook scans for the current run's inputs. */
const RUN_INPUT_SCAN_LIMIT = 64;

export interface ContextExtensionOptions {
	/** Section key overrides, mainly for tests and wrapping experiments. */
	readonly keys?: {
		readonly persona?: string;
		readonly policy?: string;
	};
	/** Wall clock; defaults to `Date.now`. */
	readonly now?: () => number;
	/**
	 * Resolve the model that actually runs a conversation from its stored agent model, applying
	 * the host's fallback rules. Without it chat compaction receives no model hint.
	 */
	readonly resolveModel?: (
		agentModel: ModelRef | undefined,
	) => { readonly modelId: string; readonly providerId: string } | undefined;
	/**
	 * Process-local snapshot cache keyed by conversation and the live run's first entry. A run
	 * hands its generation task over between tool rounds, so the task memo alone cannot pin it;
	 * the host also reads this cache from the inspector.
	 */
	readonly turnContextCache?: Map<string, TurnContextSnapshot>;
}

/** Cache key for one live run's ephemeral turn context. */
export function turnContextCacheKey(conversationId: string | number, runFirst: number): string {
	return `${conversationId}:${runFirst}`;
}

/** Keep one snapshot per conversation; older runs can never be inspected as live again. */
function rememberTurnContext(
	cache: Map<string, TurnContextSnapshot>,
	conversationId: string | number,
	key: string,
	snapshot: TurnContextSnapshot,
): TurnContextSnapshot {
	for (const existing of cache.keys()) {
		if (existing.startsWith(`${conversationId}:`)) cache.delete(existing);
	}
	cache.set(key, snapshot);
	return snapshot;
}

export type TurnContextSnapshot = {
	renderedAtMs: number;
	sections: { key: string; text: string }[];
};

/** Turn triggers of one envelope as stored on an activity entry. */
function envelopeTrigger(envelope: unknown): TurnTrigger | undefined {
	if (typeof envelope !== "object" || envelope === null) return undefined;
	const raw = (envelope as { turnContext?: unknown }).turnContext;
	if (typeof raw === "object" && raw !== null) {
		const record = raw as Record<string, unknown>;
		const classification =
			record.classification === "direct" ||
			record.classification === "soft" ||
			record.classification === "ambient"
				? record.classification
				: undefined;
		const cue =
			typeof record.cue === "string" && record.cue.trim().length > 0 ? record.cue : undefined;
		const promptHooks =
			typeof record.promptHooks === "string" && record.promptHooks.trim().length > 0
				? record.promptHooks
				: undefined;
		if (classification !== undefined || cue !== undefined || promptHooks !== undefined) {
			return {
				...(classification === undefined ? {} : { classification }),
				...(cue === undefined ? {} : { cue }),
				...(promptHooks === undefined ? {} : { promptHooks }),
			};
		}
	}
	// Windows admitted before Batch 1 carried the old model-visible preamble. Keep pending
	// windows meaningful across an upgrade, but never render the preamble verbatim.
	const legacy = (envelope as { triggerContext?: unknown }).triggerContext;
	return typeof legacy === "string" ? legacyTrigger(legacy) : undefined;
}

/** Recover routing information from the pre-Batch-1 `Conversation trigger:` preamble. */
function legacyTrigger(triggerContext: string): TurnTrigger | undefined {
	const classification = /^-\s*(direct|soft|ambient)\s*$/mu.exec(triggerContext)?.[1];
	if (classification !== "direct" && classification !== "soft" && classification !== "ambient") {
		return undefined;
	}
	if (classification !== "soft") return { classification };
	const lines = [
		/Bot name used without direct address:\s*yes/iu.test(triggerContext)
			? "Someone mentioned you by name without addressing you directly."
			: "Nobody addressed you directly; you are just following the chat.",
	];
	if (/Another bot is speaking:\s*yes/iu.test(triggerContext)) {
		lines.push("The latest speaker is another bot.");
	}
	const media = /Media\/notice summary:\s*(.+)$/imu.exec(triggerContext)?.[1]?.trim();
	if (media !== undefined && media.length > 0 && media.toLocaleLowerCase() !== "none") {
		lines.push(`The latest message is ${media}.`);
	}
	lines.push("If joining in would be noise, reply with exactly TSUKAIMA_LURK and nothing else.");
	return { classification, cue: lines.join("\n") };
}

/** Envelope identity of one run input, for the observation-window duplicate filter. */
function envelopeInput(envelope: unknown): TurnContextInput | undefined {
	if (typeof envelope !== "object" || envelope === null) return undefined;
	const record = envelope as Record<string, unknown>;
	const envelopeId = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
	const source =
		typeof record.source === "object" && record.source !== null
			? (record.source as Record<string, unknown>)
			: undefined;
	const rawPlatformId = source?.messageId;
	const text = Array.isArray(record.parts)
		? record.parts
				.flatMap((part: unknown) =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string"
						? [part.text]
						: [],
				)
				.join("\n")
				.trim()
		: "";
	const platformMessageId =
		typeof rawPlatformId === "string" || typeof rawPlatformId === "number"
			? String(rawPlatformId)
			: undefined;
	if (envelopeId === undefined && platformMessageId === undefined) return undefined;
	return {
		...(envelopeId === undefined ? {} : { envelopeId }),
		...(platformMessageId === undefined ? {} : { platformMessageId }),
		...(text.length === 0 ? {} : { text }),
	};
}

/** True when an entry is the durable user instruction for a `length` continuation. */
function isContinuationInput(entry: EntryRecord | undefined): boolean {
	if (entry?.model === undefined) return false;
	return entry.model.some(
		(message) =>
			message.role === "user" && contentText(message.content).trim() === LENGTH_CONTINUATION_PROMPT,
	);
}

/**
 * Whether an entry ended its run. A `length` answer followed by the continuation prompt is a cut
 * prefix, not the run's final answer, so the run's original inputs stay visible to turn context.
 * Once continuation is exhausted (no newer continuation prompt), the length answer is final.
 */
function isFinalAnswer(entry: EntryRecord, newerEntry: EntryRecord | undefined): boolean {
	if (entry.kind !== "pi.assistant") return false;
	const answer = (entry.model ?? []).findLast((message) => message.role === "assistant");
	if (answer?.role !== "assistant") return false;
	if (answer.stopReason === "length" && isContinuationInput(newerEntry)) return false;
	return answer.stopReason !== "toolUse";
}

export interface RunInputScanOptions {
	/** First entry of the live run; entries before it belong to an earlier run. */
	readonly minEntryId?: number;
}

/**
 * Envelopes of the current run, oldest first. A run's inputs are the activity-window entries
 * after the previous run's final answer; tool rounds, steers, and follow-ups in between are
 * skipped over. `minEntryId` (pi-durable's `LiveRun.first`) draws the boundary after a run
 * that ended without a final answer, such as a `terminate` round.
 */
function runEnvelopes(
	entriesDescending: readonly EntryRecord[],
	options: RunInputScanOptions = {},
): unknown[] {
	const newestFirst: unknown[] = [];
	for (const [index, entry] of entriesDescending.entries()) {
		if (options.minEntryId !== undefined && entry.id < options.minEntryId) break;
		if (entry.kind === CompactionEntry.kind || entry.kind === ResetEntry.kind) break;
		if (isFinalAnswer(entry, entriesDescending[index - 1])) break;
		if (entry.kind !== durableDocumentKinds.activityWindow) continue;
		if (entry.model === undefined || entry.model.length === 0) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
		const envelopes = (data as { envelopes?: unknown }).envelopes;
		if (!Array.isArray(envelopes)) continue;
		for (const envelope of envelopes.toReversed()) newestFirst.push(envelope);
	}
	return newestFirst.toReversed();
}

/** Turn triggers of the current run, oldest first. */
export function collectRunTriggers(
	entriesDescending: readonly EntryRecord[],
	options: RunInputScanOptions = {},
): TurnTrigger[] {
	return runEnvelopes(entriesDescending, options)
		.map((envelope) => envelopeTrigger(envelope))
		.filter((trigger): trigger is TurnTrigger => trigger !== undefined);
}

/** Envelope identity of the current run's inputs, oldest first. */
export function collectRunInputs(
	entriesDescending: readonly EntryRecord[],
	options: RunInputScanOptions = {},
): TurnContextInput[] {
	return runEnvelopes(entriesDescending, options)
		.map((envelope) => envelopeInput(envelope))
		.filter((input): input is TurnContextInput => input !== undefined);
}

/** `<turn-context>` block for a set of sections; `undefined` when there is nothing to say. */
export function renderTurnContextBlock(
	sections: readonly TurnContextSection[],
): string | undefined {
	const bodies = sections
		.map((entry) => ({ key: entry.key, text: entry.text.trim() }))
		.filter((entry) => entry.text.length > 0)
		.map((entry) => `<${entry.key}>\n${entry.text}\n</${entry.key}>`);
	if (bodies.length === 0) return undefined;
	return `<${TURN_CONTEXT_TAG}>\n${bodies.join("\n")}\n</${TURN_CONTEXT_TAG}>`;
}

/**
 * Insert the ephemeral block as a user message immediately before the current run's first
 * input, so it reads as "context, then the new messages" and everything before it stays a
 * stable cacheable prefix. Tool rounds of the run follow the inputs and keep their order.
 */
export function injectTurnContext(
	messages: readonly Message[],
	block: string,
	timestamp: number,
): Message[] {
	let index = messages.length;
	while (index > 0) {
		const previous = messages[index - 1];
		if (previous === undefined) break;
		if (previous.role === "system") break;
		if (previous.role === "assistant" && previous.stopReason !== "toolUse") break;
		index -= 1;
	}
	// Skip leading tool traffic so the block lands on the first user input of the run.
	while (index < messages.length && messages[index]?.role !== "user") index += 1;
	if (index >= messages.length) index = messages.length;
	const contextMessage: UserMessage = { content: block, role: "user", timestamp };
	return [...messages.slice(0, index), contextMessage, ...messages.slice(index)];
}

/** Longest tool-result excerpt a chat compaction transcript keeps. */
const COMPACTION_TOOL_RESULT_MAX_CHARS = 600;
/** Longest single chat line a compaction transcript keeps. */
const COMPACTION_MESSAGE_MAX_CHARS = 2_000;
/** Default upper bound for the deterministic baseline fallback when no summarizer is available. */
const FALLBACK_BASELINE_MAX_CHARS = 4_000;
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const INLINE_IMAGE_DATA = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu;
const LONG_BASE64_RUN = /[a-z0-9+/]{200,}={0,2}/giu;

/** Wrap a summary in the standard compaction envelope so future compactions fold it cleanly. */
export function formatCompactionSummary(summary: string): string {
	return `${COMPACTION_SUMMARY_PREFIX}${summary.trim()}${COMPACTION_SUMMARY_SUFFIX}`;
}

/**
 * Deterministic fallback baseline when the LLM compaction summarizer is unavailable or fails.
 * Preserves any prior summary and the most recent transcript lines within a bounded budget.
 */
export function fallbackBaselineSummary(
	previousSummary: string | undefined,
	transcript: string,
	maxChars = FALLBACK_BASELINE_MAX_CHARS,
): string | undefined {
	const prev = previousSummary?.trim() ?? "";
	const body = transcript.trim();
	if (prev.length === 0 && body.length === 0) return undefined;
	if (body.length === 0) return prev.length <= maxChars ? prev : clipCompactionText(prev, maxChars);
	const lines = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const header =
		prev.length > 0
			? `${clipCompactionText(prev, Math.floor(maxChars * 0.45))}\n\nRecent excerpts:\n`
			: "Recent excerpts from previous session:\n";
	const remaining = Math.max(0, maxChars - header.length);
	if (remaining === 0) return clipCompactionText(header.trim(), maxChars);
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!;
		const addition = kept.length === 0 ? line.length : line.length + 1;
		if (used + addition > remaining) {
			if (kept.length === 0) kept.push(clipCompactionText(line, remaining));
			break;
		}
		kept.push(line);
		used += addition;
	}
	return `${header}${kept.toReversed().join("\n")}`.trim();
}

function clipCompactionText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

/** Drop inline image bytes so a summary prompt never carries raw base64. */
function sanitizeCompactionText(text: string): string {
	return text.replace(INLINE_IMAGE_DATA, "[image]").replace(LONG_BASE64_RUN, "[base64 omitted]");
}

function compactionSummaryOf(message: Message): string | undefined {
	if (message.role !== "user") return undefined;
	const text = contentText(message.content);
	if (!text.startsWith(COMPACTION_SUMMARY_PREFIX)) return undefined;
	const end = text.lastIndexOf(COMPACTION_SUMMARY_SUFFIX);
	if (end < COMPACTION_SUMMARY_PREFIX.length) return undefined;
	const summary = text.slice(COMPACTION_SUMMARY_PREFIX.length, end).trim();
	return summary.length === 0 ? undefined : summary;
}

/** The summary that headed `messages`, when the previous compaction produced one. */
export function previousCompactionSummary(messages: readonly Message[]): string | undefined {
	for (const message of messages) {
		const summary = compactionSummaryOf(message);
		if (summary !== undefined) return summary;
		if (message.role === "user" || message.role === "assistant") return undefined;
	}
	return undefined;
}

/**
 * Chat-readable transcript for the compaction summarizer: speaker-prefixed text, tool traffic
 * reduced to names, oversized tool output clipped, and inline image bytes omitted. A prior
 * compaction summary is carried separately so it can be folded into the new one.
 */
export function chatCompactionTranscript(messages: readonly Message[]): string {
	const lines: string[] = [];
	let headConsumed = false;
	for (const message of messages) {
		if (!headConsumed && compactionSummaryOf(message) !== undefined) {
			headConsumed = true;
			continue;
		}
		switch (message.role) {
			case "system":
				break;
			case "user": {
				const text = sanitizeCompactionText(contentText(message.content)).trim();
				if (text.length > 0) {
					lines.push(clipCompactionText(text, COMPACTION_MESSAGE_MAX_CHARS));
				}
				break;
			}
			case "assistant": {
				const texts: string[] = [];
				const tools: string[] = [];
				for (const block of message.content) {
					if (block.type === "text" && block.text.trim().length > 0) {
						texts.push(sanitizeCompactionText(block.text.trim()));
					} else if (block.type === "toolCall") tools.push(block.name);
				}
				if (texts.length > 0) {
					lines.push(
						clipCompactionText(`(you): ${texts.join("\n")}`, COMPACTION_MESSAGE_MAX_CHARS),
					);
				}
				if (tools.length > 0) lines.push(`(you used: ${tools.join(", ")})`);
				break;
			}
			case "toolResult": {
				const text = sanitizeCompactionText(contentText(message.content)).trim();
				if (text.length === 0) break;
				const label = message.toolName.length > 0 ? message.toolName : "tool";
				lines.push(
					`(result of ${label}): ${clipCompactionText(text, COMPACTION_TOOL_RESULT_MAX_CHARS)}`,
				);
				break;
			}
		}
	}
	return lines.join("\n");
}

async function turnContextForRun(
	provider: ContextPromptProvider,
	api: HookApi,
	context: Context,
	now: () => number,
	cache: Map<string, TurnContextSnapshot> | undefined,
): Promise<TurnContextSnapshot | undefined> {
	if (provider.renderTurnContext === undefined) return undefined;
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	const runFirst = live?.run?.first;
	const cacheKey =
		runFirst === undefined ? undefined : turnContextCacheKey(api.conversationId, runFirst);
	const refresh = provider.refreshTurnContext === true;
	const shared = refresh || cacheKey === undefined ? undefined : cache?.get(cacheKey);
	if (shared !== undefined) {
		return api.memo<TurnContextSnapshot>(TURN_CONTEXT_MEMO, shared, context);
	}
	const memoized = refresh
		? undefined
		: await api.memo<TurnContextSnapshot>(TURN_CONTEXT_MEMO, context);
	if (memoized !== undefined) {
		if (cache !== undefined && cacheKey !== undefined) {
			rememberTurnContext(cache, api.conversationId, cacheKey, memoized);
		}
		return memoized;
	}
	const minEntryId = runFirst;
	const page = await api.entries(
		{ order: "descending", ...(minEntryId === undefined ? {} : { minEntryId }) },
		RUN_INPUT_SCAN_LIMIT,
		undefined,
		context,
	);
	const nowMs = now();
	const sections = await provider.renderTurnContext({
		conversationId: String(api.conversationId),
		nowMs,
		inputs: collectRunInputs(page.items),
		triggers: collectRunTriggers(page.items),
	});
	const candidate: TurnContextSnapshot = {
		renderedAtMs: nowMs,
		sections: sections.map((entry) => ({ key: entry.key, text: entry.text })),
	};
	if (cache !== undefined && cacheKey !== undefined) {
		rememberTurnContext(cache, api.conversationId, cacheKey, candidate);
	}
	if (refresh) return candidate;
	// The first memo wins, so a recovered or concurrent hook reuses the pinned snapshot.
	return api.memo<TurnContextSnapshot>(TURN_CONTEXT_MEMO, candidate, context);
}

/**
 * Turns a {@link ContextPromptProvider} into a pi-durable extension: static system sections,
 * a `beforeRequest` hook that attaches the run's ephemeral turn context to each request only,
 * and a `beforeCompact` hook that routes chat conversations to a chat-native summarizer.
 * Provider failures omit the affected context instead of failing the run.
 */
export function createContextExtension<Tool extends ToolRegistration = ToolRegistration>(
	provider: ContextPromptProvider,
	options: ContextExtensionOptions = {},
): Extension<Tool> {
	const now = options.now ?? Date.now;
	const buildSection = (
		key: string,
		render: (conversationId: string) => Promise<string | undefined>,
	): PromptSection<Tool> =>
		section<Tool>(key, async (input, context) => {
			try {
				const text = await render(String(input.conversationId));
				return text === undefined || text.trim().length === 0 ? undefined : text;
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				return undefined;
			}
		});
	const sections = [
		...(provider.renderSystem === undefined
			? []
			: [
					buildSection(
						SYSTEM_SECTION_KEY,
						(id) => provider.renderSystem?.(id) ?? Promise.resolve(undefined),
					),
				]),
		buildSection(options.keys?.persona ?? PERSONA_SECTION_KEY, (conversationId) =>
			provider.renderPersona(conversationId),
		),
		...(provider.renderPolicy === undefined
			? []
			: [
					buildSection(
						options.keys?.policy ?? POLICY_SECTION_KEY,
						(conversationId) =>
							provider.renderPolicy?.(conversationId) ?? Promise.resolve(undefined),
					),
				]),
	];
	const hooks = [];
	if (provider.renderTurnContext !== undefined) {
		hooks.push(
			hook(GenerationTask, {
				async beforeRequest(request, api, context) {
					try {
						const turn = await turnContextForRun(
							provider,
							api,
							context,
							now,
							options.turnContextCache,
						);
						if (turn === undefined) return undefined;
						const block = renderTurnContextBlock(turn.sections);
						if (block === undefined) return undefined;
						return { messages: injectTurnContext(request.messages, block, turn.renderedAtMs) };
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return undefined;
					}
				},
			}),
		);
	}
	if (provider.summarizeCompaction !== undefined) {
		hooks.push(
			hook(CompactionTask, {
				async beforeCompact(compaction, api, context) {
					try {
						const agent = await api.snapshot(AgentDoc, api.conversationId, context);
						const model = options.resolveModel?.(agent?.model);
						const previousSummary = previousCompactionSummary(compaction.messages);
						const summary = await provider.summarizeCompaction?.({
							conversationId: String(api.conversationId),
							reason: compaction.reason,
							transcript: chatCompactionTranscript(compaction.messages),
							...(previousSummary === undefined ? {} : { previousSummary }),
							...(compaction.instructions === undefined
								? {}
								: { instructions: compaction.instructions }),
							...(model === undefined ? {} : { model }),
							...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
						});
						// `undefined` keeps pi-durable's default summarizer (workspace sessions).
						return summary === undefined || summary.trim().length === 0 ? undefined : { summary };
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						// A chat summary that failed must never be replaced by the coding checklist.
						const chat = await provider
							.isChatConversation?.(String(api.conversationId))
							.catch(() => false);
						return chat === true ? { decline: true } : undefined;
					}
				},
			}),
		);
	}
	return defineExtension<Tool>({
		name: CONTEXT_EXTENSION_NAME,
		sections,
		...(hooks.length === 0 ? {} : { hooks }),
	});
}
