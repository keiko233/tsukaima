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

export { PiDurableConversationHost, type AppendConversationResult } from "./conversation-host.ts";
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
