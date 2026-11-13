import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import type { TsukaimaPlugin } from "@tsukaima/sdk";
import { z } from "zod";
import { OPENAI_COMPATIBLE_PROVIDER_ID, openAiCompatibleManifest } from "./manifest.ts";

export { OPENAI_COMPATIBLE_PLUGIN_ID, OPENAI_COMPATIBLE_PROVIDER_ID } from "./manifest.ts";

export const openAiCompatibleConfigSchema = z.object({
	apiKey: z.string().min(1),
	baseUrl: z.string().url(),
	modelId: z.string().min(1),
});

export type OpenAiCompatibleConfig = z.infer<typeof openAiCompatibleConfigSchema>;

const unsubscribers = new WeakMap<object, () => void>();

/**
 * A model provider plugin. It registers a factory rather than a live port so the host can
 * decide when to build the model catalog and can inject usage accounting.
 */
export const openAiCompatiblePlugin: TsukaimaPlugin = {
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
	async setup(context) {
		const report = async (): Promise<void> => {
			const raw = (await context.settings?.get()) ?? {};
			const parsed = openAiCompatibleConfigSchema.safeParse(raw);
			if (!parsed.success) {
				context.ui.setStatus({
					code: "status_unconfigured",
					level: "unknown",
					summary: "Provider credentials are incomplete",
				});
				return;
			}
			context.ui.setStatus({
				code: "status_configured",
				details: { baseUrl: parsed.data.baseUrl },
				level: "ok",
				metrics: { model: parsed.data.modelId },
				summary: parsed.data.modelId,
			});
		};
		await report();
		const unsubscribe = context.settings?.onChange(() => {
			void report();
		});
		if (unsubscribe !== undefined) unsubscribers.set(context, unsubscribe);
	},
	teardown(context) {
		unsubscribers.get(context)?.();
		unsubscribers.delete(context);
		context.ui.setStatus(null);
	},
};

export default openAiCompatiblePlugin;
