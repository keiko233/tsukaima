import type { ConversationPolicy, ConversationPolicyPatch } from "@tsukaima/contracts";

/**
 * Serialize an edited draft into a policy patch.
 *
 * Clearing an override in the form deletes the key from the draft, and `undefined` disappears
 * from the JSON wire payload, so the server would keep the old value. The nullable patch fields
 * must be sent as explicit `null` so `mergeConversationPolicy` clears them.
 */
export function toPolicyPatch(draft: ConversationPolicy): ConversationPolicyPatch {
	return {
		...draft,
		gate: {
			...draft.gate,
			model: draft.gate.model ?? null,
		},
		generation: {
			...draft.generation,
			stop: draft.generation.stop ?? null,
			temperature: draft.generation.temperature ?? null,
			topP: draft.generation.topP ?? null,
		},
		pacing: {
			...draft.pacing,
			allowedTools: draft.pacing.allowedTools ?? null,
		},
		sidechat: {
			...draft.sidechat,
			model: draft.sidechat.model ?? null,
		},
	};
}
