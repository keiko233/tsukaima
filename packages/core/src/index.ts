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

export { PiDurableConversationHost } from "./conversation-host.ts";
export { createFakeModel, type ModelPort } from "./model.ts";
