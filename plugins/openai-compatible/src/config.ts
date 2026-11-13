import type {
	PluginModelDescriptor,
	PluginModelInputModality,
	PluginModelReasoningLevel,
} from "@elaina/sdk";
import { z } from "zod";

export const openAiCompatibleReasoningLevelSchema = z.enum([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export type OpenAiCompatibleReasoningLevel = z.infer<typeof openAiCompatibleReasoningLevelSchema>;

const DEFAULT_REASONING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly OpenAiCompatibleReasoningLevel[];

export const openAiCompatibleModelSchema = z.object({
	id: z.string().trim().min(1),
	name: z.string().trim().optional(),
	enabled: z.boolean().default(false),
	supportsTools: z.boolean().default(true),
	supportsReasoning: z.boolean().default(false),
	reasoningLevels: z
		.array(openAiCompatibleReasoningLevelSchema)
		.min(1)
		.default([...DEFAULT_REASONING_LEVELS]),
	defaultReasoningLevel: openAiCompatibleReasoningLevelSchema.default("medium"),
	supportsImage: z.boolean().default(false),
	supportsAudio: z.boolean().default(false),
	capabilities: z.array(z.string().trim().min(1)).default([]),
	contextWindow: z.number().int().positive().default(128_000),
	maxOutputTokens: z.number().int().positive().default(4_096),
});

export type OpenAiCompatibleModel = z.infer<typeof openAiCompatibleModelSchema>;

const connectionSchema = z.object({
	apiKey: z.string().min(1),
	baseUrl: z.string().url(),
});

export const openAiCompatibleConfigSchema = connectionSchema.extend({
	models: z.array(openAiCompatibleModelSchema),
});

export type OpenAiCompatibleConfig = z.infer<typeof openAiCompatibleConfigSchema>;

export interface ResolvedOpenAiCompatibleConfig extends OpenAiCompatibleConfig {
	readonly enabledModels: readonly OpenAiCompatibleModel[];
}

export function createOpenAiCompatibleModel(
	id: string,
	overrides: Partial<OpenAiCompatibleModel> = {},
): OpenAiCompatibleModel {
	return openAiCompatibleModelSchema.parse({ id, ...overrides });
}

/**
 * Reads both the current `models` array and the former single `modelId` setting. The old shape
 * stays readable so existing installations do not lose their configured provider on upgrade.
 */
export function readOpenAiCompatibleModels(
	raw: Record<string, unknown>,
): readonly OpenAiCompatibleModel[] {
	const parsed = z
		.array(openAiCompatibleModelSchema)
		.safeParse(Array.isArray(raw.models) ? raw.models : []);
	const models = parsed.success ? parsed.data : [];
	const legacyModelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
	if (models.length === 0 && legacyModelId.length > 0) {
		return [createOpenAiCompatibleModel(legacyModelId, { enabled: true })];
	}
	const seen = new Set<string>();
	return models.filter((model) => {
		if (seen.has(model.id)) return false;
		seen.add(model.id);
		return true;
	});
}

export function readOpenAiCompatibleConnection(raw: Record<string, unknown>): {
	readonly apiKey?: string;
	readonly baseUrl?: string;
} {
	return {
		...(typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? { apiKey: raw.apiKey } : {}),
		...(typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? { baseUrl: raw.baseUrl } : {}),
	};
}

export function resolveOpenAiCompatibleConfig(
	raw: Record<string, unknown>,
): ResolvedOpenAiCompatibleConfig | null {
	const connection = connectionSchema.safeParse(raw);
	if (!connection.success) return null;
	const models = readOpenAiCompatibleModels(raw);
	const enabledModels = models.filter((model) => model.enabled);
	if (enabledModels.length === 0) return null;
	return {
		...connection.data,
		enabledModels,
		models: [...models],
	};
}

function customCapabilities(model: OpenAiCompatibleModel): readonly string[] {
	return model.capabilities
		.map((capability) => capability.trim().toLowerCase())
		.filter((capability) => capability.length > 0);
}

export function modelCapabilities(model: OpenAiCompatibleModel): readonly string[] {
	const capabilities = new Set(["basic-chat"]);
	if (model.supportsTools) capabilities.add("tool-use");
	if (model.supportsReasoning) {
		capabilities.add("reasoning");
		capabilities.add("thinking");
	}
	if (model.supportsImage) {
		capabilities.add("vision");
		capabilities.add("image-input");
	}
	if (model.supportsAudio) capabilities.add("audio-input");
	for (const capability of customCapabilities(model)) capabilities.add(capability);
	return [...capabilities];
}

export function modelInputModalities(
	model: OpenAiCompatibleModel,
): readonly PluginModelInputModality[] {
	return [
		"text",
		...(model.supportsImage ? (["image"] as const) : []),
		...(model.supportsAudio ? (["audio"] as const) : []),
	];
}

export function toPluginModelDescriptor(model: OpenAiCompatibleModel): PluginModelDescriptor {
	return {
		capabilities: modelCapabilities(model),
		contextWindow: model.contextWindow,
		id: model.id,
		input: modelInputModalities(model),
		maxOutputTokens: model.maxOutputTokens,
		...(model.name === undefined ? {} : { name: model.name }),
		...(model.supportsReasoning
			? {
					reasoning: {
						default: model.defaultReasoningLevel,
						levels: model.reasoningLevels as readonly PluginModelReasoningLevel[],
					},
				}
			: {}),
	};
}
