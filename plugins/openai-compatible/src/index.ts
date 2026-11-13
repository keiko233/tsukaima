import { createOpenAICompatibleModelPort } from "@elaina/core";
import type { ElainaPlugin } from "@elaina/sdk";
import { z } from "zod";
import { OPENAI_COMPATIBLE_PROVIDER_ID, openAiCompatibleManifest } from "./manifest.ts";

export { OPENAI_COMPATIBLE_PLUGIN_ID, OPENAI_COMPATIBLE_PROVIDER_ID } from "./manifest.ts";

export const openAiCompatibleConfigSchema = z.object({
	apiKey: z.string().min(1),
	baseUrl: z.string().url(),
	modelId: z.string().min(1),
});

export type OpenAiCompatibleConfig = z.infer<typeof openAiCompatibleConfigSchema>;

/**
 * A model provider plugin. It registers a factory rather than a live port so the host can
 * decide when to build the model catalog and can inject usage accounting.
 */
export const openAiCompatiblePlugin: ElainaPlugin = {
	manifest: openAiCompatibleManifest,
	prepare(context) {
		context.models.registerProvider({
			id: OPENAI_COMPATIBLE_PROVIDER_ID,
			async isConfigured() {
				const raw = (await context.settings?.get()) ?? {};
				return openAiCompatibleConfigSchema.safeParse(raw).success;
			},
			async createPort(options = {}) {
				const raw = (await context.settings?.get()) ?? {};
				const config = openAiCompatibleConfigSchema.parse(raw);
				return createOpenAICompatibleModelPort(
					{
						apiKey: config.apiKey,
						baseUrl: config.baseUrl,
						...(options.onMessage === undefined
							? {}
							: {
									onMessage: (message) => {
										options.onMessage?.(message);
									},
								}),
						providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
					},
					[{ capabilities: ["basic-chat", "tool-use"], modelId: config.modelId }],
				);
			},
		});
		context.logger.info("OpenAI-compatible provider registered");
	},
	setup() {},
};

export default openAiCompatiblePlugin;
