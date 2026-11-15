import type { ConversationPacingPolicy } from "@elaina/contracts";

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
		windowMs: 6_000,
	},
	latestMessageAtMs: number = firstMessageAtMs,
): boolean {
	const settleMs = policy.burstSettleMs ?? policy.windowMs ?? 6_000;
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
	type BackgroundTurnInput,
	type BackgroundTurnResult,
	type CompactConversationResult,
	type ConversationAnswer,
	type ConversationContextInspection,
	type DurableConversationHostOptions,
	type InspectConversationContextOptions,
	type LiveRunSnapshot,
} from "./conversation-host.ts";
export {
	CONTEXT_EXTENSION_NAME,
	MEMORY_SECTION_KEY,
	PERSONA_SECTION_KEY,
	POLICY_SECTION_KEY,
	createContextExtension,
	type ContextExtensionOptions,
	type ContextPromptProvider,
} from "./context.ts";
export {
	ConversationExecutionLock,
	defaultConversationExecutionLock,
	withConversationLock,
} from "./execution-lock.ts";
export { createFakeModel, createSlowStreamingModel, type ModelPort } from "./model.ts";
export { createFallbackCoreLogger, previewText, type CoreLogger } from "./logger.ts";
export {
	ModelPolicyRouter,
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
	buildTriggerContext,
	classifyConversationTrigger,
	extractLurkMarker,
	mediaOnlyKind,
	type LurkDecision,
	type ResolvedReplyTarget,
	type TriggerClassificationInput,
	type TriggerClassificationResult,
	type TriggerContextInput,
} from "./trigger.ts";
export {
	boundedReplyDelayMs,
	busyDisposition,
	prepareOutboundParts,
	prepareOutboundText,
	splitOnNewlines,
	stripMarkdownFormatting,
	type PreparedOutput,
	type PreparedPartsOutput,
} from "./output-pacing.ts";
