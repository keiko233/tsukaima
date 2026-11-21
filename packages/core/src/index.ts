import type { ConversationPacingPolicy } from "@tsukaima/contracts";

type ActivityWindowLikePolicy = {
	readonly maxMessages?: number;
	readonly windowMs?: number;
	readonly burstSettleMs?: number;
	readonly burstMaxWaitMs?: number;
};

/**
 * Decide whether an activity window should submit. Legacy `windowMs` maps to the idle settle
 * window, while `burstMaxWaitMs` bounds the total time since the first message so a continuous
 * stream cannot postpone the model forever. `latestMessageAtMs` defaults to the first message,
 * preserving the legacy two-argument behavior where `windowMs` counted from the window opening.
 */
export function shouldCloseActivityWindow(
	firstMessageAtMs: number,
	candidateAtMs: number,
	policy: ActivityWindowLikePolicy = {
		maxMessages: 20,
		windowMs: 8_000,
	},
	latestMessageAtMs: number = firstMessageAtMs,
): boolean {
	const settleMs = policy.burstSettleMs ?? policy.windowMs ?? 8_000;
	const maxWaitMs = policy.burstMaxWaitMs ?? settleMs;
	const settledForMs = candidateAtMs - latestMessageAtMs;
	const elapsedMs = candidateAtMs - firstMessageAtMs;
	return settledForMs >= settleMs || elapsedMs >= maxWaitMs;
}

/** Convert a pacing policy into the fields consumed by {@link shouldCloseActivityWindow}. */
export function activityWindowPacing(
	pacing: ConversationPacingPolicy,
): Required<Pick<ConversationPacingPolicy, "burstMaxWaitMs" | "burstSettleMs">> {
	return {
		burstMaxWaitMs: pacing.burstMaxWaitMs,
		burstSettleMs: pacing.burstSettleMs,
	};
}

export {
	PiDurableConversationHost,
	activityIdFromSubmissionRequestId,
	activitySubmissionRequestId,
	type ActivityWindowEvent,
	type AppendConversationInput,
	type AppendConversationResult,
	type AdmittedTurn,
	type BackgroundTurnInput,
	type BackgroundTurnOrigin,
	type BackgroundTurnResult,
	type CompactConversationResult,
	type ConversationAgentSettings,
	type ConversationAnswer,
	type SubmissionAnswerResolution,
	type ConversationContextInspection,
	type DurableConversationHostOptions,
	type InspectConversationContextOptions,
	type LiveRunSnapshot,
	type SeedConversationBaselineResult,
} from "./conversation-host.ts";
import type { ToolRegistration } from "@earendil-works/pi-durable";
export type { Extension as DurableExtension } from "@earendil-works/pi-durable";
/** Tool registration plus the Tsukaima surface that may offer it. */
export type DurableToolRegistration = ToolRegistration & {
	readonly surface?: "chat" | "coding" | "both";
};
export {
	type BusyArbiter,
	type BusyArbitrationDecision,
	type BusyArbitrationInput,
	type BusyArbitrationResult,
} from "./busy-arbiter.ts";
export {
	CONTEXT_EXTENSION_NAME,
	PERSONA_SECTION_KEY,
	POLICY_SECTION_KEY,
	SYSTEM_SECTION_KEY,
	TURN_CONTEXT_MEMO,
	TURN_CONTEXT_SECTION_PREFIX,
	TURN_CONTEXT_TAG,
	TURN_MEMORIES_KEY,
	chatCompactionTranscript,
	collectRunInputs,
	collectRunTriggers,
	createContextExtension,
	fallbackBaselineSummary,
	formatCompactionSummary,
	injectTurnContext,
	previousCompactionSummary,
	renderTurnContextBlock,
	turnContextCacheKey,
	type ChatCompactionRequest,
	type ContextExtensionOptions,
	type ContextPromptProvider,
	type RunInputScanOptions,
	type TurnContextInput,
	type TurnContextRequest,
	type TurnContextSection,
	type TurnContextSnapshot,
	type TurnTrigger,
} from "./context.ts";
export {
	applyMentionLabels,
	envelopeHeader,
	envelopeSpeaker,
	envelopeTimeMs,
	formatEnvelopeLine,
	formatLocalClock,
	formatLocalDateTime,
	formatQuote,
	type RenderableEnvelope,
	type TurnFormatOptions,
} from "./turn-format.ts";
export {
	CHAT_RUN_EXTENSION_NAME,
	LENGTH_CONTINUATION_PROMPT,
	assistantMessageText,
	assistantToolNames,
	createChatRunExtension,
	narrationCandidate,
	runKindFromEntries,
	samplingOverrides,
	type ChatRunExtensionOptions,
	type ChatRunKind,
	type ConversationNarration,
} from "./run-hooks.ts";
export {
	ConversationExecutionLock,
	defaultConversationExecutionLock,
	withConversationLock,
} from "./execution-lock.ts";
export { createFakeModel, createSlowStreamingModel, type ModelPort } from "./model.ts";
export { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
export { createFallbackCoreLogger, previewText, type CoreLogger } from "./logger.ts";
export {
	DEFAULT_REQUEST_TIMEOUT_MS,
	ModelPolicyRouter,
	OpenAIRequestTimeoutError,
	ModelUsageLedger,
	createOpenAICompatibleProvider,
	createOpenAICompatibleModelPort,
	createOpenAICompatibleStreams,
	type ModelCapability,
	type ModelPolicy,
	type ModelRef,
	type ModelUsageRecord,
	type OpenAICompatibleConfig,
	type OpenAICompatibleModelConfig,
	type RoutedModel,
	type RouteModelRequest,
} from "./openai.ts";
export {
	LURK_MARKER,
	buildTurnCue,
	classifyConversationTrigger,
	extractLurkMarker,
	mediaOnlyKind,
	type LurkDecision,
	type ResolvedReplyTarget,
	type TriggerClassificationInput,
	type TriggerClassificationResult,
	type TurnCueInput,
} from "./trigger.ts";
export {
	boundedReplyDelayMs,
	busyDisposition,
	directFlushDecision,
	prepareOutboundParts,
	prepareOutboundText,
	splitOnNewlines,
	stripMarkdownFormatting,
	type DirectFlushDecision,
	type DirectFlushInput,
	type PreparedOutput,
	type PreparedPartsOutput,
} from "./output-pacing.ts";
export {
	REPETITION_REWRITE_PROMPT,
	countReplyBubbles,
	detectOverusedPhrases,
	detectRigidRhythm,
	extractPhraseCandidates,
	formatAvoidListNudge,
	needsRepetitionRewrite,
	sanitizeOutboundMetaLeaks,
	shapedReplyDelayMs,
	type DetectOverusedPhrasesOptions,
	type DetectRigidRhythmOptions,
	type MetaLeakSanitizeResult,
	type OverusedPhrase,
	type OverusedPhraseReport,
	type RhythmReport,
	type ShapedReplyDelayInput,
} from "./humanize.ts";
export {
	CONVERSATION_GATE_BINDING,
	FailOpenConversationGate,
	GateCircuitBreaker,
	type BurstCompletionGateDecision,
	type BurstCompletionGateInput,
	type ConversationGateDriver,
	type ConversationGatePort,
	type FailOpenConversationGateOptions,
	type GateCircuitBreakerOptions,
	type GateCircuitState,
	type GateDecisionSource,
	type ProactiveBubbleGateDecision,
	type ProactiveBubbleGateInput,
	type UndirectedGroupGateDecision,
	type UndirectedGroupGateInput,
} from "./gate.ts";
export {
	composeInterjectPrompt,
	isIdentityProbe,
	isTrailingFollowUp,
	shouldInterject,
	type ComposedInterjectPrompt,
	type FastLaneInterjectInput,
	type FastLaneInterjectResult,
	type FastLaneInterjector,
	type FastLaneReply,
	type InterjectDecision,
	type InterjectEvaluationInput,
	type InterjectPromptInput,
} from "./interject.ts";
