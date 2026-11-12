export function shouldCloseActivityWindow(
	firstMessageAtMs: number,
	candidateAtMs: number,
	policy: { readonly maxMessages: number; readonly windowMs: number } = {
		maxMessages: 20,
		windowMs: 6_000,
	},
): boolean {
	return candidateAtMs - firstMessageAtMs > policy.windowMs;
}

export {
	PiDurableConversationHost,
	activityIdFromSubmissionRequestId,
	activitySubmissionRequestId,
	type ActivityWindowEvent,
	type AppendConversationResult,
	type ConversationAnswer,
	type DurableConversationHostOptions,
} from "./conversation-host.ts";
export {
	CONTEXT_EXTENSION_NAME,
	MEMORY_SECTION_KEY,
	PERSONA_SECTION_KEY,
	createContextExtension,
	type ContextExtensionOptions,
	type ContextPromptProvider,
} from "./context.ts";
export { createFakeModel, type ModelPort } from "./model.ts";
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
