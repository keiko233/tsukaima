import { MODEL_CAPABILITIES } from "@tsukaima/sdk/model-capabilities";
import type {
	PluginModelDescriptor,
	PluginModelInputModality,
	PluginModelOutputModality,
	PluginModelReasoningLevel,
} from "@tsukaima/sdk";
import { z } from "zod";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./manifest.ts";

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
	supportsImageGeneration: z.boolean().default(false),
	/** Whether the busy-run classifier may use this model; untick slow or costly models. */
	supportsSidechat: z.boolean().default(true),
	capabilities: z.array(z.string().trim().min(1)).default([]),
	contextWindow: z.number().int().positive().default(128_000),
	maxOutputTokens: z.number().int().positive().default(4_096),
	/** Sampling defaults sent with every request; unset leaves the provider's own default. */
	temperature: z.number().min(0).max(2).optional(),
	topP: z.number().gt(0).max(1).optional(),
	stop: z.array(z.string().min(1)).max(4).optional(),
	/** Header wait and stream-idle timeout; unset uses the core default (60 s). */
	requestTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export type OpenAiCompatibleModel = z.infer<typeof openAiCompatibleModelSchema>;

export const openAiCompatibleProfileSchema = z.object({
	id: z.string().trim().min(1),
	name: z.string().trim().optional(),
	enabled: z.boolean().default(true),
	baseUrl: z.string().trim().url(),
	models: z.array(openAiCompatibleModelSchema),
});

export type OpenAiCompatibleProfile = z.infer<typeof openAiCompatibleProfileSchema>;

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

export interface ReadOpenAiCompatibleProfile {
	readonly id: string;
	readonly name?: string;
	readonly enabled: boolean;
	readonly baseUrl: string;
	readonly models: OpenAiCompatibleModel[];
	readonly apiKey?: string;
	readonly providerId: string;
}

export interface ResolvedOpenAiCompatibleProfile extends ReadOpenAiCompatibleProfile {
	readonly apiKey: string;
	readonly enabledModels: readonly OpenAiCompatibleModel[];
}

export function openAiCompatibleProviderIdForProfile(profileId: string): string {
	const normalized = profileId.trim();
	return normalized === "default"
		? OPENAI_COMPATIBLE_PROVIDER_ID
		: `${OPENAI_COMPATIBLE_PROVIDER_ID}:${normalized}`;
}

export function createOpenAiCompatibleModel(
	id: string,
	overrides: Partial<OpenAiCompatibleModel> = {},
): OpenAiCompatibleModel {
	return openAiCompatibleModelSchema.parse({ id, ...overrides });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function readProfileApiKeys(raw: Record<string, unknown>): Record<string, string> {
	const source = raw.profileApiKeys;
	if (!isRecord(source)) return {};
	const keys: Record<string, string> = {};
	for (const [profileId, apiKey] of Object.entries(source)) {
		if (hasText(apiKey)) keys[profileId] = apiKey;
	}
	return keys;
}

function readProfileModels(value: unknown): OpenAiCompatibleModel[] {
	const parsed = z.array(openAiCompatibleModelSchema).safeParse(Array.isArray(value) ? value : []);
	return parsed.success ? parsed.data : [];
}

function profileApiKey(
	profileId: string,
	profileApiKeys: Record<string, string>,
	raw: Record<string, unknown>,
): string | undefined {
	const key = profileApiKeys[profileId];
	if (hasText(key)) return key;
	if (profileId === "default" && hasText(raw.apiKey)) return raw.apiKey;
	return undefined;
}

/**
 * Reads every profile-shaped entry without validating the connection, so an incomplete profile
 * can be shown in the UI while other profiles keep working. Legacy top-level connection fields
 * are exposed as the synthetic `default` profile.
 */
export function readOpenAiCompatibleProfiles(
	raw: Record<string, unknown>,
): readonly ReadOpenAiCompatibleProfile[] {
	const profileApiKeys = readProfileApiKeys(raw);
	const profiles: ReadOpenAiCompatibleProfile[] = [];
	const seen = new Set<string>();
	for (const candidate of Array.isArray(raw.profiles) ? raw.profiles : []) {
		if (!isRecord(candidate)) continue;
		const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
		if (id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
		const apiKey = profileApiKey(id, profileApiKeys, raw);
		profiles.push({
			...(apiKey === undefined ? {} : { apiKey }),
			baseUrl: typeof candidate.baseUrl === "string" ? candidate.baseUrl : "",
			enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
			id,
			models: readProfileModels(candidate.models),
			...(name.length === 0 ? {} : { name }),
			providerId: openAiCompatibleProviderIdForProfile(id),
		});
	}
	const defaultProfile = profiles.find((profile) => profile.id === "default");
	const legacyModels = readOpenAiCompatibleModels(raw);
	const hasLegacyModels =
		Array.isArray(raw.models) || hasText(raw.modelId) || legacyModels.length > 0;
	const hasLegacyConnection = hasText(raw.baseUrl) || hasLegacyModels;
	if (defaultProfile === undefined && hasLegacyConnection) {
		const apiKey = profileApiKey("default", profileApiKeys, raw);
		profiles.unshift({
			...(apiKey === undefined ? {} : { apiKey }),
			baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
			enabled: true,
			id: "default",
			models: [...legacyModels],
			providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
		});
	}
	return profiles;
}

/**
 * Returns every enabled profile that can actually serve requests. An incomplete secondary
 * profile is skipped rather than invalidating the rest of the configuration.
 */
export function resolveOpenAiCompatibleProfiles(
	raw: Record<string, unknown>,
): readonly ResolvedOpenAiCompatibleProfile[] {
	const resolved: ResolvedOpenAiCompatibleProfile[] = [];
	const seenProviderIds = new Set<string>();
	for (const profile of readOpenAiCompatibleProfiles(raw)) {
		if (!profile.enabled || seenProviderIds.has(profile.providerId)) continue;
		if (
			!hasText(profile.baseUrl) ||
			!connectionSchema.shape.baseUrl.safeParse(profile.baseUrl).success
		) {
			continue;
		}
		if (!hasText(profile.apiKey)) continue;
		const enabledModels = profile.models.filter((model) => model.enabled);
		if (enabledModels.length === 0) continue;
		seenProviderIds.add(profile.providerId);
		resolved.push({
			...profile,
			apiKey: profile.apiKey,
			enabled: true,
			enabledModels,
			models: [...profile.models],
		});
	}
	return resolved;
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
): ResolvedOpenAiCompatibleProfile | null {
	const profiles = resolveOpenAiCompatibleProfiles(raw);
	return profiles.find((profile) => profile.id === "default") ?? profiles[0] ?? null;
}

function customCapabilities(model: OpenAiCompatibleModel): readonly string[] {
	return model.capabilities
		.map((capability) => capability.trim().toLowerCase())
		.filter((capability) => capability.length > 0);
}

export function modelCapabilities(model: OpenAiCompatibleModel): readonly string[] {
	const capabilities = new Set<string>([MODEL_CAPABILITIES.basicChat]);
	if (model.supportsTools) capabilities.add(MODEL_CAPABILITIES.toolUse);
	if (model.supportsReasoning) {
		capabilities.add(MODEL_CAPABILITIES.reasoning);
		capabilities.add(MODEL_CAPABILITIES.thinking);
	}
	if (model.supportsImage) {
		capabilities.add(MODEL_CAPABILITIES.vision);
		capabilities.add(MODEL_CAPABILITIES.imageInput);
	}
	if (model.supportsImageGeneration) capabilities.add(MODEL_CAPABILITIES.imageGenerate);
	if (model.supportsAudio) capabilities.add(MODEL_CAPABILITIES.audioInput);
	if (model.supportsSidechat) capabilities.add(MODEL_CAPABILITIES.sidechat);
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

export function modelOutputModalities(
	model: OpenAiCompatibleModel,
): readonly PluginModelOutputModality[] {
	const capabilities = modelCapabilities(model);
	const supportsImageGeneration =
		model.supportsImageGeneration || capabilities.includes(MODEL_CAPABILITIES.imageGenerate);
	if (!supportsImageGeneration) return ["text"];
	// basic-chat is advertised unconditionally, so tools, reasoning, and sidechat are the flags
	// that distinguish a mixed text/image model from an image-only model.
	const supportsTextChat = model.supportsTools || model.supportsReasoning || model.supportsSidechat;
	return supportsTextChat ? ["text", "image"] : ["image"];
}

export function toPluginModelDescriptor(model: OpenAiCompatibleModel): PluginModelDescriptor {
	return {
		capabilities: modelCapabilities(model),
		contextWindow: model.contextWindow,
		id: model.id,
		input: modelInputModalities(model),
		maxOutputTokens: model.maxOutputTokens,
		output: modelOutputModalities(model),
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
