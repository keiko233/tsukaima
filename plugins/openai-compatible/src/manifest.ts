import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const OPENAI_COMPATIBLE_PLUGIN_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_DISCOVER_RPC = "openai-compatible.models.discover";

export const openAiCompatibleManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		apiKey: "TSUKAIMA_OPENAI_API_KEY",
		baseUrl: "TSUKAIMA_OPENAI_BASE_URL",
		modelId: "TSUKAIMA_OPENAI_MODEL_ID",
	},
	configSchema: {
		properties: {
			apiKey: { type: "string" },
			baseUrl: { type: "string" },
			modelId: {
				description: "Legacy single-model configuration; migrated when models are saved.",
				type: "string",
			},
			models: {
				items: {
					properties: {
						capabilities: { items: { type: "string" }, type: "array" },
						contextWindow: { type: "integer" },
						defaultReasoningLevel: { type: "string" },
						enabled: { type: "boolean" },
						id: { type: "string" },
						maxOutputTokens: { type: "integer" },
						name: { type: "string" },
						reasoningLevels: { items: { type: "string" }, type: "array" },
						supportsAudio: { type: "boolean" },
						supportsImage: { type: "boolean" },
						supportsImageGeneration: { type: "boolean" },
						supportsReasoning: { type: "boolean" },
						supportsSidechat: { type: "boolean" },
						supportsTools: { type: "boolean" },
						supportsVideoGeneration: { type: "boolean" },
					},
					type: "object",
				},
				type: "array",
			},
			profiles: {
				items: {
					properties: {
						baseUrl: { type: "string" },
						enabled: { type: "boolean" },
						id: { type: "string" },
						models: {
							items: {
								properties: {
									capabilities: { items: { type: "string" }, type: "array" },
									contextWindow: { type: "integer" },
									defaultReasoningLevel: { type: "string" },
									enabled: { type: "boolean" },
									id: { type: "string" },
									maxOutputTokens: { type: "integer" },
									name: { type: "string" },
									reasoningLevels: { items: { type: "string" }, type: "array" },
									supportsAudio: { type: "boolean" },
									supportsImage: { type: "boolean" },
									supportsImageGeneration: { type: "boolean" },
									supportsReasoning: { type: "boolean" },
									supportsSidechat: { type: "boolean" },
									supportsTools: { type: "boolean" },
									supportsVideoGeneration: { type: "boolean" },
								},
								type: "object",
							},
							type: "array",
						},
						name: { type: "string" },
					},
					type: "object",
				},
				type: "array",
			},
			profileApiKeys: {
				additionalProperties: { type: "string" },
				type: "object",
			},
		},
		type: "object",
	},
	kind: "builtin",
	name: OPENAI_COMPATIBLE_PLUGIN_ID,
	permissions: ["ui.panel", "model.call", "settings"],
	secretKeys: ["apiKey", "profileApiKeys"],
	version: "0.1.0",
});
