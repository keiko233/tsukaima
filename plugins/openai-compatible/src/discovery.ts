import {
	createOpenAiCompatibleModel,
	openAiCompatibleReasoningLevelSchema,
	type OpenAiCompatibleModel,
	type OpenAiCompatibleReasoningLevel,
} from "./config.ts";

export interface DiscoveryOptions {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly fetch?: typeof fetch;
}

export interface DiscoveredModels {
	readonly models: readonly OpenAiCompatibleModel[];
}

interface ModelRecord {
	readonly architecture?: {
		readonly input_modalities?: readonly string[];
		readonly modality?: string;
	};
	readonly context_length?: number;
	readonly context_window?: number;
	readonly created?: number;
	readonly display_name?: string;
	readonly id?: string;
	readonly input_modalities?: readonly string[];
	readonly max_completion_tokens?: number;
	readonly max_context_tokens?: number;
	readonly max_output_tokens?: number;
	readonly modalities?: {
		readonly input?: readonly string[];
	};
	readonly name?: string;
	readonly owned_by?: string;
	readonly reasoning?: boolean;
	readonly reasoning_levels?: readonly string[];
	readonly supported_parameters?: readonly string[];
	readonly supported_reasoning_levels?: readonly string[];
	readonly tool_call?: boolean;
	readonly top_provider?: {
		readonly context_length?: number;
		readonly max_completion_tokens?: number;
	};
}

interface ModelsResponse {
	readonly data?: readonly ModelRecord[];
	readonly models?: readonly ModelRecord[];
}

const REASONING_MODEL_PATTERN =
	/(?:^|[/_-])(?:o[134](?:-|$)|reason|think|deepseek-r1|qwq|qwen3|magistral)/iu;
const IMAGE_MODEL_PATTERN =
	/(?:vision|llava|pixtral|gemma3|qwen(?:2\.5|3)?-vl|vl-|gpt-4o|gpt-4\.1|gemini|claude-(?:3|4)|glm-4(?:\.\d+)?v)/iu;
const AUDIO_MODEL_PATTERN = /(?:audio|whisper|transcribe|speech|realtime)/iu;

function positiveInteger(...values: readonly (number | undefined)[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function stringSet(values: unknown): ReadonlySet<string> {
	return new Set(stringArray(values).map((value) => value.toLowerCase()));
}

function parseReasoningLevels(
	record: ModelRecord,
): readonly OpenAiCompatibleReasoningLevel[] | undefined {
	const raw = [
		...stringArray(record.reasoning_levels),
		...stringArray(record.supported_reasoning_levels),
	];
	const parsed: OpenAiCompatibleReasoningLevel[] = [];
	const seen = new Set<OpenAiCompatibleReasoningLevel>();
	for (const entry of raw) {
		const result = openAiCompatibleReasoningLevelSchema.safeParse(entry.toLowerCase());
		if (!result.success || seen.has(result.data)) continue;
		seen.add(result.data);
		parsed.push(result.data);
	}
	return parsed.length > 0 ? parsed : undefined;
}

function inferCapabilities(
	record: ModelRecord,
	id: string,
): {
	readonly reasoningLevels?: readonly OpenAiCompatibleReasoningLevel[];
	readonly supportsAudio: boolean;
	readonly supportsImage: boolean;
	readonly supportsReasoning: boolean;
	readonly supportsTools: boolean;
} {
	const supported = stringSet(record.supported_parameters);
	const modalities = new Set(
		[
			...stringArray(record.architecture?.input_modalities),
			...stringArray(record.input_modalities),
			...stringArray(record.modalities?.input),
			...(typeof record.architecture?.modality === "string"
				? record.architecture.modality.split("+")
				: []),
		].map((value) => value.toLowerCase()),
	);
	const reasoningLevels = parseReasoningLevels(record);
	const supportsReasoning =
		typeof record.reasoning === "boolean"
			? record.reasoning
			: reasoningLevels !== undefined ||
				REASONING_MODEL_PATTERN.test(id) ||
				[...supported].some(
					(parameter) =>
						parameter.includes("reasoning") ||
						parameter === "thinking" ||
						parameter === "include_reasoning",
				);
	const supportsImage = modalities.has("image") || IMAGE_MODEL_PATTERN.test(id);
	const supportsAudio = modalities.has("audio") || AUDIO_MODEL_PATTERN.test(id);
	const supportsTools =
		typeof record.tool_call === "boolean"
			? record.tool_call
			: supported.size === 0 ||
				[...supported].some(
					(parameter) =>
						parameter === "tools" ||
						parameter === "tool_choice" ||
						parameter === "function_calling",
				);
	return {
		...(reasoningLevels === undefined ? {} : { reasoningLevels }),
		supportsAudio,
		supportsImage,
		supportsReasoning,
		supportsTools,
	};
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/u, "");
}

function parseModel(record: ModelRecord): OpenAiCompatibleModel | undefined {
	if (typeof record.id !== "string" || record.id.trim().length === 0) return undefined;
	const id = record.id.trim();
	const { reasoningLevels, ...inferred } = inferCapabilities(record, id);
	const displayName =
		typeof record.name === "string" && record.name.trim().length > 0
			? record.name.trim()
			: typeof record.display_name === "string" && record.display_name.trim().length > 0
				? record.display_name.trim()
				: undefined;
	const defaultReasoningLevel =
		reasoningLevels !== undefined && !reasoningLevels.includes("medium")
			? reasoningLevels[0]!
			: "medium";
	return createOpenAiCompatibleModel(id, {
		contextWindow:
			positiveInteger(
				record.context_length,
				record.context_window,
				record.max_context_tokens,
				record.top_provider?.context_length,
			) ?? 128_000,
		defaultReasoningLevel,
		enabled: false,
		maxOutputTokens:
			positiveInteger(
				record.max_completion_tokens,
				record.max_output_tokens,
				record.top_provider?.max_completion_tokens,
			) ?? 4_096,
		...(displayName === undefined ? {} : { name: displayName }),
		...(reasoningLevels === undefined ? {} : { reasoningLevels: [...reasoningLevels] }),
		...inferred,
	});
}

export async function discoverOpenAiCompatibleModels(
	options: DiscoveryOptions,
): Promise<DiscoveredModels> {
	const fetchImplementation = options.fetch ?? fetch;
	const response = await fetchImplementation(`${normalizeBaseUrl(options.baseUrl)}/models`, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${options.apiKey}`,
		},
		method: "GET",
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 500);
		throw new Error(
			`Model discovery failed (${response.status})${detail.length === 0 ? "" : `: ${detail}`}`,
		);
	}
	let payload: ModelsResponse;
	try {
		payload = (await response.json()) as ModelsResponse;
	} catch (error) {
		throw new Error(
			`Model discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	const records = Array.isArray(payload.data)
		? payload.data
		: Array.isArray(payload.models)
			? payload.models
			: [];
	const seen = new Set<string>();
	const models: OpenAiCompatibleModel[] = [];
	for (const record of records) {
		if (typeof record !== "object" || record === null) continue;
		const model = parseModel(record);
		if (model === undefined || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return { models };
}
