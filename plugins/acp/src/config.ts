import { MODEL_CAPABILITIES } from "@tsukaima/sdk/model-capabilities";
import type {
	PluginModelDescriptor,
	PluginModelInputModality,
	PluginModelOutputModality,
} from "@tsukaima/sdk";
import { z } from "zod";
import { ACP_PROVIDER_PREFIX } from "./manifest.ts";

export const acpPresetSchema = z.enum(["antigravity", "codex", "claude-code", "custom"]);
export type AcpPreset = z.infer<typeof acpPresetSchema>;

export const acpToolBridgeModeSchema = z.enum(["disabled", "mcp-bridge", "prompt-json"]);
export type AcpToolBridgeMode = z.infer<typeof acpToolBridgeModeSchema>;

export const acpReasoningLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type AcpReasoningLevel = z.infer<typeof acpReasoningLevelSchema>;

const DEFAULT_REASONING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly AcpReasoningLevel[];

export const acpModelSchema = z.object({
	id: z.string().trim().min(1),
	name: z.string().trim().optional(),
	enabled: z.boolean().default(false),
	supportsTools: z.boolean().default(true),
	supportsReasoning: z.boolean().default(false),
	reasoningLevels: z
		.array(acpReasoningLevelSchema)
		.min(1)
		.default([...DEFAULT_REASONING_LEVELS]),
	defaultReasoningLevel: acpReasoningLevelSchema.default("medium"),
	supportsImage: z.boolean().default(false),
	supportsAudio: z.boolean().default(false),
	supportsImageGeneration: z.boolean().default(false),
	supportsVideoGeneration: z.boolean().default(false),
	supportsSidechat: z.boolean().default(false),
	capabilities: z.array(z.string().trim().min(1)).default([]),
	contextWindow: z.number().int().positive().default(128_000),
	maxOutputTokens: z.number().int().positive().default(8_192),
});

export type AcpModelConfig = z.infer<typeof acpModelSchema>;

export const acpProfileSchema = z.object({
	id: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9._-]*$/iu, "Profile id must be alphanumeric/slug"),
	name: z.string().trim().optional(),
	preset: acpPresetSchema.default("custom"),
	enabled: z.boolean().default(true),
	command: z.string().trim().min(1),
	args: z.array(z.string()).default([]),
	cwd: z.string().trim().optional(),
	idleTtlMs: z.number().int().min(5_000).max(3_600_000).default(300_000),
	requestTimeoutMs: z.number().int().min(1_000).max(900_000).default(180_000),
	enableAsModelProvider: z.boolean().default(true),
	toolBridgeMode: acpToolBridgeModeSchema.default("disabled"),
	supportsImageGeneration: z.boolean().default(false),
	supportsVideoGeneration: z.boolean().default(false),
	supportsCapabilityTool: z.boolean().default(false),
	allowedCapabilityChat: z.boolean().default(false),
	env: z.record(z.string(), z.string()).default({}),
	models: z.array(acpModelSchema).default([]),
});

export type AcpProfileConfig = z.infer<typeof acpProfileSchema>;

export interface AcpPresetTemplate {
	readonly preset: AcpPreset;
	readonly defaultId: string;
	readonly displayName: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly supportsImageGeneration: boolean;
	readonly supportsVideoGeneration: boolean;
	readonly defaultModels: readonly AcpModelConfig[];
}

export const ACP_PRESET_TEMPLATES: Readonly<Record<AcpPreset, AcpPresetTemplate>> = {
	antigravity: {
		args: ["acp", "--stdio"],
		command: "agy",
		defaultId: "antigravity",
		defaultModels: [
			createAcpModel("gemini-3-pro", {
				enabled: true,
				name: "Antigravity (Default)",
				supportsImage: true,
				supportsImageGeneration: true,
				supportsReasoning: true,
				supportsTools: true,
				supportsVideoGeneration: true,
			}),
		],
		displayName: "Antigravity (agy)",
		preset: "antigravity",
		supportsImageGeneration: true,
		supportsVideoGeneration: true,
	},
	"claude-code": {
		args: [],
		command: "claude-agent-acp",
		defaultId: "claude-code",
		defaultModels: [
			createAcpModel("claude-sonnet-4-5", {
				enabled: true,
				name: "Claude Code (Default)",
				supportsImage: true,
				supportsReasoning: true,
				supportsTools: true,
			}),
		],
		displayName: "Claude Code (claude-agent-acp)",
		preset: "claude-code",
		supportsImageGeneration: false,
		supportsVideoGeneration: false,
	},
	codex: {
		args: [],
		command: "codex-acp",
		defaultId: "codex",
		defaultModels: [
			createAcpModel("gpt-5.4", {
				enabled: true,
				name: "Codex (Default)",
				supportsImage: true,
				supportsImageGeneration: true,
				supportsReasoning: true,
				supportsTools: true,
			}),
		],
		displayName: "Codex (codex-acp)",
		preset: "codex",
		supportsImageGeneration: true,
		supportsVideoGeneration: false,
	},
	custom: {
		args: [],
		command: "",
		defaultId: "custom",
		defaultModels: [],
		displayName: "Custom ACP CLI",
		preset: "custom",
		supportsImageGeneration: false,
		supportsVideoGeneration: false,
	},
};

export interface AcpRuntimePackageSpec {
	readonly id: string;
	readonly preset: AcpPreset;
	readonly displayName: string;
	readonly binaryName: string;
	readonly packages: readonly string[];
	readonly installMethod: "bun" | "system";
	readonly installHint?: string;
}

export const ACP_RUNTIME_PACKAGES: readonly AcpRuntimePackageSpec[] = [
	{
		binaryName: "codex-acp",
		displayName: "Codex ACP Adapter (@agentclientprotocol/codex-acp)",
		id: "codex-acp",
		installMethod: "bun",
		packages: ["@agentclientprotocol/codex-acp"],
		preset: "codex",
	},
	{
		binaryName: "codex",
		displayName: "OpenAI Codex CLI (@openai/codex)",
		id: "codex-cli",
		installMethod: "bun",
		packages: ["@openai/codex"],
		preset: "codex",
	},
	{
		binaryName: "claude-agent-acp",
		displayName: "Claude Code ACP Adapter (@agentclientprotocol/claude-agent-acp)",
		id: "claude-agent-acp",
		installMethod: "bun",
		packages: ["@agentclientprotocol/claude-agent-acp"],
		preset: "claude-code",
	},
	{
		binaryName: "claude",
		displayName: "Claude Code CLI (@anthropic-ai/claude-code)",
		id: "claude-cli",
		installMethod: "bun",
		packages: ["@anthropic-ai/claude-code"],
		preset: "claude-code",
	},
	{
		binaryName: "agy",
		displayName: "Antigravity CLI (agy)",
		id: "antigravity-cli",
		installHint: "Install the Antigravity desktop/CLI package so `agy` is available on PATH.",
		installMethod: "system",
		packages: [],
		preset: "antigravity",
	},
];

export interface ReadAcpProfile {
	readonly allowedCapabilityChat: boolean;
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd?: string;
	readonly enableAsModelProvider: boolean;
	readonly enabled: boolean;
	readonly env: Readonly<Record<string, string>>;
	readonly id: string;
	readonly idleTtlMs: number;
	readonly models: readonly AcpModelConfig[];
	readonly name?: string;
	readonly preset: AcpPreset;
	readonly providerId: string;
	readonly requestTimeoutMs: number;
	readonly supportsCapabilityTool: boolean;
	readonly supportsImageGeneration: boolean;
	readonly supportsVideoGeneration: boolean;
	readonly toolBridgeMode: AcpToolBridgeMode;
}

export interface ResolvedAcpProfile extends ReadAcpProfile {
	readonly enabledModels: readonly AcpModelConfig[];
}

export function createAcpModel(
	id: string,
	overrides: Partial<AcpModelConfig> = {},
): AcpModelConfig {
	return acpModelSchema.parse({ id, ...overrides });
}

export function acpProviderIdForProfile(profileId: string): string {
	const normalized = profileId.trim();
	return `${ACP_PROVIDER_PREFIX}:${normalized}`;
}

export function createPresetProfile(
	preset: AcpPreset,
	overrides: Partial<AcpProfileConfig> = {},
): AcpProfileConfig {
	const template = ACP_PRESET_TEMPLATES[preset];
	return acpProfileSchema.parse({
		args: [...template.args],
		command: template.command || "acp-agent",
		id: template.defaultId,
		models: template.defaultModels,
		name: template.displayName,
		preset,
		supportsImageGeneration: template.supportsImageGeneration,
		supportsVideoGeneration: template.supportsVideoGeneration,
		...overrides,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringMap(raw: unknown): Record<string, string> {
	if (!isRecord(raw)) return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key.trim().length > 0 && typeof value === "string") {
			result[key.trim()] = value;
		}
	}
	return result;
}

function readProfileEnvSecrets(
	raw: Record<string, unknown>,
): Record<string, Record<string, string>> {
	if (!isRecord(raw.profileEnvSecrets)) return {};
	const map: Record<string, Record<string, string>> = {};
	for (const [profileId, envRecord] of Object.entries(raw.profileEnvSecrets)) {
		const trimmed = profileId.trim();
		if (trimmed.length === 0) continue;
		map[trimmed] = readStringMap(envRecord);
	}
	return map;
}

export function readAcpProfiles(raw: Record<string, unknown>): readonly ReadAcpProfile[] {
	const secrets = readProfileEnvSecrets(raw);
	const profiles: ReadAcpProfile[] = [];
	const seen = new Set<string>();
	for (const candidate of Array.isArray(raw.profiles) ? raw.profiles : []) {
		if (!isRecord(candidate)) continue;
		const parsed = acpProfileSchema.safeParse(candidate);
		if (!parsed.success) continue;
		const data = parsed.data;
		if (seen.has(data.id)) continue;
		seen.add(data.id);
		const mergedEnv = {
			...data.env,
			...secrets[data.id],
		};
		profiles.push({
			allowedCapabilityChat: data.allowedCapabilityChat,
			args: data.args,
			command: data.command,
			...(data.cwd === undefined || data.cwd.length === 0 ? {} : { cwd: data.cwd }),
			enableAsModelProvider: data.enableAsModelProvider,
			enabled: data.enabled,
			env: mergedEnv,
			id: data.id,
			idleTtlMs: data.idleTtlMs,
			models: data.models,
			...(data.name === undefined || data.name.length === 0 ? {} : { name: data.name }),
			preset: data.preset,
			providerId: acpProviderIdForProfile(data.id),
			requestTimeoutMs: data.requestTimeoutMs,
			supportsCapabilityTool: data.supportsCapabilityTool,
			supportsImageGeneration: data.supportsImageGeneration,
			supportsVideoGeneration: data.supportsVideoGeneration,
			toolBridgeMode: data.toolBridgeMode,
		});
	}
	return profiles;
}

export function resolveAcpProfiles(raw: Record<string, unknown>): readonly ResolvedAcpProfile[] {
	const resolved: ResolvedAcpProfile[] = [];
	const seen = new Set<string>();
	for (const profile of readAcpProfiles(raw)) {
		if (!profile.enabled || seen.has(profile.providerId)) continue;
		if (profile.command.trim().length === 0) continue;
		const enabledModels = profile.models.filter((model) => model.enabled);
		if (
			enabledModels.length === 0 &&
			!profile.supportsImageGeneration &&
			!profile.supportsVideoGeneration &&
			!profile.supportsCapabilityTool
		) {
			continue;
		}
		seen.add(profile.providerId);
		resolved.push({
			...profile,
			enabledModels,
		});
	}
	return resolved;
}

export function acpModelCapabilities(
	model: AcpModelConfig,
	profile?: Pick<
		ReadAcpProfile,
		"enableAsModelProvider" | "supportsImageGeneration" | "supportsVideoGeneration"
	>,
): readonly string[] {
	const capabilities = new Set<string>();
	if (profile?.enableAsModelProvider !== false) {
		capabilities.add(MODEL_CAPABILITIES.basicChat);
	}
	if (model.supportsTools && profile?.enableAsModelProvider !== false) {
		capabilities.add(MODEL_CAPABILITIES.toolUse);
	}
	if (model.supportsReasoning) {
		capabilities.add(MODEL_CAPABILITIES.reasoning);
		capabilities.add(MODEL_CAPABILITIES.thinking);
	}
	if (model.supportsImage) {
		capabilities.add(MODEL_CAPABILITIES.vision);
		capabilities.add(MODEL_CAPABILITIES.imageInput);
	}
	if (model.supportsImageGeneration || profile?.supportsImageGeneration === true) {
		capabilities.add(MODEL_CAPABILITIES.imageGenerate);
		capabilities.add(MODEL_CAPABILITIES.imageEdit);
	}
	if (model.supportsVideoGeneration || profile?.supportsVideoGeneration === true) {
		capabilities.add(MODEL_CAPABILITIES.videoGenerate);
		if (model.supportsImage) {
			capabilities.add(MODEL_CAPABILITIES.videoImageToVideo);
		}
	}
	if (model.supportsAudio) capabilities.add(MODEL_CAPABILITIES.audioInput);
	if (model.supportsSidechat) {
		capabilities.add(MODEL_CAPABILITIES.sidechat);
		capabilities.add(MODEL_CAPABILITIES.decisionChoice);
	}
	for (const tag of model.capabilities) {
		const normalized = tag.trim().toLowerCase();
		if (normalized.length > 0) capabilities.add(normalized);
	}
	return [...capabilities];
}

export function acpModelInputModalities(
	model: AcpModelConfig,
): readonly PluginModelInputModality[] {
	return [
		"text",
		...(model.supportsImage ? (["image"] as const) : []),
		...(model.supportsAudio ? (["audio"] as const) : []),
	];
}

export function acpModelOutputModalities(
	model: AcpModelConfig,
	profile?: Pick<ReadAcpProfile, "supportsImageGeneration" | "supportsVideoGeneration">,
): readonly PluginModelOutputModality[] {
	return [
		"text",
		...(model.supportsImageGeneration || profile?.supportsImageGeneration === true
			? (["image"] as const)
			: []),
		...(model.supportsVideoGeneration || profile?.supportsVideoGeneration === true
			? (["video"] as const)
			: []),
	];
}

export function toAcpPluginModelDescriptor(
	model: AcpModelConfig,
	profile?: Pick<
		ReadAcpProfile,
		"enableAsModelProvider" | "supportsImageGeneration" | "supportsVideoGeneration"
	>,
): PluginModelDescriptor {
	return {
		capabilities: acpModelCapabilities(model, profile),
		contextWindow: model.contextWindow,
		id: model.id,
		input: acpModelInputModalities(model),
		maxOutputTokens: model.maxOutputTokens,
		...(model.name === undefined ? {} : { name: model.name }),
		output: acpModelOutputModalities(model, profile),
		...(model.supportsReasoning
			? {
					reasoning: {
						default: model.defaultReasoningLevel,
						levels: [...model.reasoningLevels],
					},
				}
			: {}),
	};
}
