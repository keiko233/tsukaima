import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk";

export const OPENAI_COMPATIBLE_PLUGIN_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

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
			modelId: { type: "string" },
		},
		type: "object",
	},
	kind: "builtin",
	name: OPENAI_COMPATIBLE_PLUGIN_ID,
	permissions: ["ui.panel", "model.call", "settings"],
	secretKeys: ["apiKey"],
	ui: [
		{
			component: "plugin-config-form",
			data: { restartRequired: true },
			id: "openai-compatible.settings",
			kind: "settings-form",
			title: "OpenAI-compatible provider",
		},
	],
	version: "0.1.0",
});
