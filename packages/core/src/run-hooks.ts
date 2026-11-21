import type { Context } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	defineExtension,
	GenerationTask,
	hook,
	LiveDoc,
	type EntryId,
	type EntryRecord,
	type Extension,
	type HookApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	durableDocumentKinds,
	type ConversationGenerationPolicy,
	type ConversationPolicy,
} from "@tsukaima/contracts";
import { LENGTH_CONTINUATION_PROMPT } from "./context.ts";
import { REPETITION_REWRITE_PROMPT, sanitizeOutboundMetaLeaks } from "./humanize.ts";
import type { CoreLogger } from "./logger.ts";
import { extractLurkMarker } from "./trigger.ts";

export { LENGTH_CONTINUATION_PROMPT };

export const CHAT_RUN_EXTENSION_NAME = "tsukaima-chat-run";
/** Task memo that pins one narration per generation task and tool round. */
export const NARRATION_MEMO = "tsukaima.narration";
/** Entries scanned backwards to classify the live run's inputs and count its rounds. */
const RUN_KIND_SCAN_LIMIT = 200;

/**
 * One mid-turn message the model wrote before calling tools, or the delivered prefix of an
 * answer that stopped on its output limit. Delivery is at-most-once per `narrationId`.
 */
export interface ConversationNarration {
	readonly conversationId: string;
	/**
	 * Stable dedupe key, unique per generation task and tool round. The dispatcher stores it as
	 * the outbound row's durable entry id, so a crash replay can never send the same narration
	 * twice.
	 */
	readonly narrationId: string;
	readonly kind: "tool-preamble" | "length-prefix";
	readonly text: string;
	/** Tools called by the same assistant message (`tool-preamble` only). */
	readonly toolNames: readonly string[];
	/** `pi.live.run.first` of the run, so the dispatcher can group narrations per turn. */
	readonly runFirstEntryId?: number;
}

/** Who a run is answering; only `chat` runs narrate or continue automatically. */
export type ChatRunKind = "chat" | "background";

export interface ChatRunExtensionOptions {
	readonly readPolicy: (conversationId: string) => Promise<ConversationPolicy>;
	readonly onNarration?: (narration: ConversationNarration) => Promise<void> | void;
	/**
	 * True for tools that already post to the chat (for example a channel `send` tool). Text in
	 * the same message is then a duplicate of what the tool sends and is not narrated.
	 */
	readonly isDirectSendTool?: (toolName: string) => boolean;
	/**
	 * True when the current turn already delivered chat text through a direct send tool. A
	 * later tool round must not narrate a preamble after the tool already spoke.
	 */
	readonly hasDirectSend?: (conversationId: string) => boolean;
	/**
	 * Optional bounded single-retry check when `policy.humanization.repetitionRewriteEnabled` is
	 * enabled. Returning `{ rewrite: true }` triggers at most one rewrite continuation per run.
	 */
	readonly checkRepetitionRewrite?: (
		conversationId: string,
		replyText: string,
	) => Promise<{ readonly matched: readonly string[]; readonly rewrite: boolean } | undefined>;
	readonly logger?: CoreLogger;
}

/** Concatenated, trimmed text blocks of one assistant message. */
export function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
}

/** Tool names one assistant message calls, in call order. */
export function assistantToolNames(message: AssistantMessage): string[] {
	return message.content
		.filter((block) => block.type === "toolCall")
		.map((block) => (block.type === "toolCall" ? block.name : ""));
}

/**
 * Whether the run whose entries are given (newest first, already bounded to the run) answers a
 * background/proactive turn. Background turns stamp `backgroundKind` on their input entry.
 */
export function runKindFromEntries(entriesDescending: readonly EntryRecord[]): ChatRunKind {
	for (const entry of entriesDescending) {
		if (entry.kind !== durableDocumentKinds.activityWindow) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
		if (typeof (data as { backgroundKind?: unknown }).backgroundKind === "string") {
			return "background";
		}
	}
	return "chat";
}

/** Meaningful characters: whitespace, punctuation, and symbols such as emoji do not count. */
const NARRATION_IGNORABLE = /[\s\p{P}\p{S}]/gu;

/** A preamble needs at least two meaningful characters, so "…" or a lone emoji is silent. */
export function isSubstantiveNarration(text: string): boolean {
	return [...text.replace(NARRATION_IGNORABLE, "")].length >= 2;
}

/**
 * Pure narration gate: decides whether one terminal provider message should be narrated.
 * Kept separate from the hook so the acceptance tests can cover every branch directly.
 */
export function narrationCandidate(input: {
	readonly message: AssistantMessage;
	readonly policy: ConversationPolicy;
	readonly runKind: ChatRunKind;
	readonly isDirectSendTool?: (toolName: string) => boolean;
	readonly directSendEarlier?: boolean;
}):
	| { readonly narrate: true; readonly text: string; readonly toolNames: string[] }
	| { readonly narrate: false; readonly reason: string } {
	if (!input.policy.pacing.narrationEnabled) return { narrate: false, reason: "disabled" };
	if (input.message.stopReason !== "toolUse") return { narrate: false, reason: "not-tool-use" };
	if (input.runKind !== "chat") return { narrate: false, reason: "background-run" };
	const toolNames = assistantToolNames(input.message);
	if (toolNames.some((name) => input.isDirectSendTool?.(name) === true)) {
		return { narrate: false, reason: "direct-send-tool" };
	}
	if (input.directSendEarlier === true) return { narrate: false, reason: "direct-send-earlier" };
	const raw = sanitizeOutboundMetaLeaks(assistantMessageText(input.message)).text;
	const lurk = extractLurkMarker(raw);
	if (lurk.lurk) return { narrate: false, reason: "lurk" };
	if (lurk.text.length === 0) return { narrate: false, reason: "empty" };
	if (!isSubstantiveNarration(lurk.text)) return { narrate: false, reason: "trivial" };
	return { narrate: true, text: lurk.text, toolNames };
}

/** Sampling overrides from the conversation policy, as OpenAI chat-completions fields. */
export function samplingOverrides(
	generation: ConversationGenerationPolicy,
): Record<string, unknown> | undefined {
	const fields: Record<string, unknown> = {};
	if (generation.temperature !== undefined) fields.temperature = generation.temperature;
	if (generation.topP !== undefined) fields.top_p = generation.topP;
	if (generation.stop !== undefined && generation.stop.length > 0) fields.stop = generation.stop;
	return Object.keys(fields).length === 0 ? undefined : fields;
}

async function liveRunFirst(api: HookApi, context: Context): Promise<EntryId | undefined> {
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	return live?.run?.first;
}

async function runEntries(api: HookApi, context: Context, runFirst: EntryId | undefined) {
	return api.entries(
		{ order: "descending", ...(runFirst === undefined ? {} : { minEntryId: runFirst }) },
		RUN_KIND_SCAN_LIMIT,
		undefined,
		context,
	);
}

async function runKind(api: HookApi, context: Context, runFirst: EntryId | undefined) {
	const page = await runEntries(api, context, runFirst);
	return runKindFromEntries(page.items);
}

/**
 * One-based provider response index of the current round within its run. `afterResponse` runs
 * before the answer entry commits, so already committed assistant entries count the rounds
 * behind this one. Tool rounds share one generation task; the index keeps their narration
 * dedupe keys distinct and survives a crash replay unchanged.
 */
export async function narrationRoundIndex(
	api: HookApi,
	context: Context,
	runFirst: EntryId | undefined,
): Promise<number> {
	const page = await runEntries(api, context, runFirst);
	let committed = 0;
	for (const entry of page.items) {
		if (entry.kind === "pi.assistant") committed += 1;
	}
	return committed + 1;
}

/**
 * Automatic continuations already taken by this run. A continuation starts a new generation
 * task, so counting the durable continuation messages (not a task memo) is the only counter
 * that advances past one and survives recovery.
 */
async function continuationCount(
	api: HookApi,
	context: Context,
	runFirst: EntryId | undefined,
): Promise<number> {
	const page = await runEntries(api, context, runFirst);
	return page.items.filter((entry) =>
		entry.model?.some(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.trim() === LENGTH_CONTINUATION_PROMPT,
		),
	).length;
}

async function repetitionRewriteCount(
	api: HookApi,
	context: Context,
	runFirst: EntryId | undefined,
): Promise<number> {
	const page = await runEntries(api, context, runFirst);
	return page.items.filter((entry) =>
		entry.model?.some(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.trim() === REPETITION_REWRITE_PROMPT,
		),
	).length;
}

/**
 * Chat-run behavior that needs pi-durable generation hooks:
 *
 * - `afterResponse`: mid-turn narration of assistant text written before a tool call.
 * - `onYield`: one bounded automatic continuation after a `length` stop.
 * - `beforeProviderRequest`: per-conversation sampling overrides for OpenAI-compatible APIs.
 *
 * Every hook fails open: a policy read or callback error never fails the run.
 */
export function createChatRunExtension<Tool extends ToolRegistration = ToolRegistration>(
	options: ChatRunExtensionOptions,
): Extension<Tool> {
	const logger = options.logger;
	return defineExtension<Tool>({
		name: CHAT_RUN_EXTENSION_NAME,
		hooks: [
			hook(GenerationTask, {
				async afterResponse(message, api, context) {
					const onNarration = options.onNarration;
					if (onNarration === undefined || message.stopReason !== "toolUse") return;
					try {
						const conversationId = String(api.conversationId);
						const policy = await options.readPolicy(conversationId);
						const runFirst = await liveRunFirst(api, context);
						const decision = narrationCandidate({
							message,
							policy,
							runKind: await runKind(api, context, runFirst),
							directSendEarlier: options.hasDirectSend?.(conversationId) === true,
							...(options.isDirectSendTool === undefined
								? {}
								: { isDirectSendTool: options.isDirectSendTool }),
						});
						if (!decision.narrate) {
							logger?.trace("Narration skipped", { conversationId, reason: decision.reason });
							return;
						}
						// Tool rounds share a generation task, so the committed response index is the round
						// key. The dispatcher also enforces `pacing.narrationMinIntervalMs` on delivery.
						const round = await narrationRoundIndex(api, context, runFirst);
						const narrationId = `narration:${String(api.taskId)}:${round}`;
						// The first memo wins per round: a hook replayed after a crash sees the pinned id
						// and the dispatcher's unique outbound key drops the duplicate.
						await api.memo<string>(`${NARRATION_MEMO}:${round}`, narrationId, context);
						await onNarration({
							conversationId,
							kind: "tool-preamble",
							narrationId,
							text: decision.text,
							toolNames: decision.toolNames,
							...(runFirst === undefined ? {} : { runFirstEntryId: Number(runFirst) }),
						});
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						logger?.warn("Narration hook failed", {
							conversationId: String(api.conversationId),
							error,
						});
					}
				},
				async onYield(answer, api, context) {
					if (answer.stopReason !== "length") {
						// Bounded single-retry rewrite guard for severe catchphrase repetition.
						if (options.checkRepetitionRewrite === undefined) return undefined;
						try {
							const conversationId = String(api.conversationId);
							const policy = await options.readPolicy(conversationId);
							if (!policy.humanization.repetitionRewriteEnabled) return undefined;
							const runFirst = await liveRunFirst(api, context);
							if ((await runKind(api, context, runFirst)) !== "chat") return undefined;
							if ((await repetitionRewriteCount(api, context, runFirst)) >= 1) return undefined;
							const text = extractLurkMarker(
								sanitizeOutboundMetaLeaks(assistantMessageText(answer)).text,
							).text;
							if (text.length === 0) return undefined;
							const check = await options.checkRepetitionRewrite(conversationId, text);
							if (check?.rewrite === true) {
								logger?.debug("Triggering bounded repetition rewrite", {
									conversationId,
									matched: check.matched,
								});
								return { continue: REPETITION_REWRITE_PROMPT };
							}
						} catch (error) {
							if (context.abortSignal?.aborted) throw error;
							logger?.warn("Repetition rewrite check failed", {
								conversationId: String(api.conversationId),
								error,
							});
						}
						return undefined;
					}
					try {
						const conversationId = String(api.conversationId);
						const policy = await options.readPolicy(conversationId);
						const runFirst = await liveRunFirst(api, context);
						if ((await runKind(api, context, runFirst)) !== "chat") return undefined;
						if (policy.generation.lengthTruncation !== "continue") {
							logger?.warn("Answer stopped on the output limit", {
								conversationId,
								mode: "surface",
							});
							return undefined;
						}
						// A continuation starts a new generation task, so count durable continuation
						// messages instead of a first-write-wins task memo. The run's `runFirst` bounds the
						// scan, which makes the counter replay-safe and able to advance past one.
						const used = await continuationCount(api, context, runFirst);
						const budget = policy.generation.maxLengthContinuations;
						if (used >= budget) {
							logger?.warn("Answer stopped on the output limit; continuation budget spent", {
								conversationId,
								used,
								budget,
							});
							return undefined;
						}
						const text = extractLurkMarker(
							sanitizeOutboundMetaLeaks(assistantMessageText(answer)).text,
						).text;
						if (text.length > 0 && options.onNarration !== undefined) {
							// The cut prefix is not the run's final answer, so deliver it now; the
							// continuation's answer carries only the remainder.
							const narrationId = `length:${String(runFirst ?? api.taskId)}:${used}`;
							await api.memo<string>(`${NARRATION_MEMO}:length:${used}`, narrationId, context);
							await options.onNarration({
								conversationId,
								kind: "length-prefix",
								narrationId,
								text,
								toolNames: [],
								...(runFirst === undefined ? {} : { runFirstEntryId: Number(runFirst) }),
							});
						}
						return { continue: LENGTH_CONTINUATION_PROMPT };
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						logger?.warn("Length continuation hook failed", {
							conversationId: String(api.conversationId),
							error,
						});
						return undefined;
					}
				},
				async beforeProviderRequest(request, api, context) {
					if (!isOpenAICompatible(request.model)) return undefined;
					if (typeof request.payload !== "object" || request.payload === null) return undefined;
					try {
						const policy = await options.readPolicy(String(api.conversationId));
						const overrides = samplingOverrides(policy.generation);
						if (overrides === undefined) return undefined;
						return { payload: { ...(request.payload as Record<string, unknown>), ...overrides } };
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return undefined;
					}
				},
			}),
		],
	});
}

function isOpenAICompatible(model: Model<Api>): boolean {
	return model.api === "openai-compatible" || model.api === "openai-completions";
}
