/**
 * Capability tags a model provider advertises on its descriptors. They are the contract between
 * plugins and the host: the host selects models by tag instead of assuming that every chat model
 * fits every role. A plugin may still publish arbitrary tags; these are the ones the host
 * understands.
 */
export const MODEL_CAPABILITIES = {
	audioInput: "audio-input",
	basicChat: "basic-chat",
	imageInput: "image-input",
	reasoning: "reasoning",
	/** The model may run the busy-run sidechat classifier. */
	sidechat: "chat.sidechat",
	thinking: "thinking",
	toolUse: "tool-use",
	vision: "vision",
} as const;

export type KnownModelCapability = (typeof MODEL_CAPABILITIES)[keyof typeof MODEL_CAPABILITIES];

/** True when a model descriptor carries `capability`; unknown tags are compared verbatim. */
export function hasModelCapability(
	model: { readonly capabilities: readonly string[] },
	capability: string,
): boolean {
	return model.capabilities.includes(capability);
}
