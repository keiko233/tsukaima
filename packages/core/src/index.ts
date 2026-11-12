import type { MessageEnvelope } from "@elaina/contracts";

export interface ConversationInput {
	readonly envelope: MessageEnvelope;
	readonly submittedAtMs: number;
}

export interface ConversationIngestionService {
	ingest(
		input: ConversationInput,
	): Promise<{ readonly conversationId: string; readonly messageId: string }>;
}

export interface ActivityAggregationPolicy {
	readonly windowMs: number;
	readonly maxMessages: number;
}

export const defaultActivityPolicy: ActivityAggregationPolicy = {
	maxMessages: 20,
	windowMs: 6_000,
};

export function shouldCloseActivityWindow(
	firstMessageAtMs: number,
	candidateAtMs: number,
	policy: ActivityAggregationPolicy = defaultActivityPolicy,
): boolean {
	return candidateAtMs - firstMessageAtMs > policy.windowMs;
}
