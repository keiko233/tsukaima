import { createOpenAICompatibleModelPort } from "@elaina/core";
import type { ElainaPlugin } from "@elaina/sdk";
import { z } from "zod";
import {
	modelCapabilities,
	readOpenAiCompatibleConnection,
	resolveOpenAiCompatibleConfig,
	toPluginModelDescriptor,
} from "./config.ts";
import { discoverOpenAiCompatibleModels } from "./discovery.ts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, openAiCompatibleManifest } from "./manifest.ts";

export {
	OPENAI_COMPATIBLE_DISCOVER_RPC,
	OPENAI_COMPATIBLE_PLUGIN_ID,
	OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./manifest.ts";
export {
	createOpenAiCompatibleModel,
	modelCapabilities,
	modelInputModalities,
	openAiCompatibleConfigSchema,
	openAiCompatibleModelSchema,
	openAiCompatibleReasoningLevelSchema,
	readOpenAiCompatibleModels,
	resolveOpenAiCompatibleConfig,
	toPluginModelDescriptor,
} from "./config.ts";
export type {
	OpenAiCompatibleConfig,
	OpenAiCompatibleModel,
	OpenAiCompatibleReasoningLevel,
} from "./config.ts";
export { discoverOpenAiCompatibleModels } from "./discovery.ts";

const discoverInputSchema = z
	.object({
		apiKey: z.string().min(1).optional(),
		baseUrl: z.string().url().optional(),
	})
	.optional();

const unsubscribers = new WeakMap<object, () => void>();

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
				const raw = ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
				return resolveOpenAiCompatibleConfig(raw) !== null;
			},
			async listModels() {
				const raw = ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
				const config = resolveOpenAiCompatibleConfig(raw);
				return config?.enabledModels.map(toPluginModelDescriptor) ?? [];
			},
			async createPort(options = {}) {
				const raw = ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
				const config = resolveOpenAiCompatibleConfig(raw);
				if (config === null) throw new Error("OpenAI-compatible provider is not configured");
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
					config.enabledModels.map((model) => ({
						capabilities: modelCapabilities(model),
						contextWindow: model.contextWindow,
						defaultReasoningLevel: model.defaultReasoningLevel,
						inputModalities: model.supportsImage ? ["text", "image"] : ["text"],
						maxOutputTokens: model.maxOutputTokens,
						modelId: model.id,
						...(model.name === undefined ? {} : { name: model.name }),
						reasoningLevels: model.reasoningLevels,
						supportsReasoning: model.supportsReasoning,
						supportsTools: model.supportsTools,
					})),
				);
			},
		});
		context.logger.info("OpenAI-compatible provider registered");
	},
	async setup(context) {
		const report = async (): Promise<void> => {
			const raw = ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
			const config = resolveOpenAiCompatibleConfig(raw);
			if (config === null) {
				context.ui.setStatus({
					code: "status_unconfigured",
					level: "unknown",
					summary: "Provider credentials or enabled models are incomplete",
				});
				return;
			}
			context.ui.setStatus({
				code: "status_configured",
				details: { baseUrl: config.baseUrl },
				level: "ok",
				metrics: {
					enabled: config.enabledModels.length,
					model: config.enabledModels[0]?.id ?? "—",
					total: config.models.length,
				},
				summary: config.enabledModels[0]?.id ?? "Provider configured",
			});
		};
		await report();
		const unsubscribe = context.settings?.onChange(() => {
			void report();
		});
		if (unsubscribe !== undefined) unsubscribers.set(context, unsubscribe);
		context.rpc.register("models.discover", async (input) => {
			const parsed = discoverInputSchema.parse(input);
			const raw = ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
			const stored = readOpenAiCompatibleConnection(raw);
			const baseUrl = parsed?.baseUrl ?? stored.baseUrl;
			const apiKey = parsed?.apiKey ?? stored.apiKey;
			if (baseUrl === undefined || apiKey === undefined) {
				throw new Error("Base URL and API key are required before discovering models");
			}
			return discoverOpenAiCompatibleModels({ apiKey, baseUrl });
		});
	},
	teardown(context) {
		unsubscribers.get(context)?.();
		unsubscribers.delete(context);
		context.ui.setStatus(null);
	},
};

export default openAiCompatiblePlugin;
