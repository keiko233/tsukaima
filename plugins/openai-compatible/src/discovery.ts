import { createOpenAiCompatibleModel, type OpenAiCompatibleModel } from "./config.ts";

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
	readonly id?: string;
	readonly max_completion_tokens?: number;
	readonly max_context_tokens?: number;
	readonly max_output_tokens?: number;
	readonly name?: string;
	readonly owned_by?: string;
	readonly supported_parameters?: readonly string[];
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

function inferCapabilities(
	record: ModelRecord,
	id: string,
): {
	readonly supportsAudio: boolean;
	readonly supportsImage: boolean;
	readonly supportsReasoning: boolean;
	readonly supportsTools: boolean;
} {
	const supported = stringSet(record.supported_parameters);
	const modalities = new Set(
		[
			...stringArray(record.architecture?.input_modalities),
			...(typeof record.architecture?.modality === "string"
				? record.architecture.modality.split("+")
				: []),
		].map((value) => value.toLowerCase()),
	);
	const supportsReasoning =
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
		supported.size === 0 ||
		[...supported].some(
			(parameter) =>
				parameter === "tools" || parameter === "tool_choice" || parameter === "function_calling",
		);
	return { supportsAudio, supportsImage, supportsReasoning, supportsTools };
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/u, "");
}

function parseModel(record: ModelRecord): OpenAiCompatibleModel | undefined {
	if (typeof record.id !== "string" || record.id.trim().length === 0) return undefined;
	const id = record.id.trim();
	const inferred = inferCapabilities(record, id);
	return createOpenAiCompatibleModel(id, {
		contextWindow:
			positiveInteger(
				record.context_length,
				record.context_window,
				record.max_context_tokens,
				record.top_provider?.context_length,
			) ?? 128_000,
		defaultReasoningLevel: "medium",
		enabled: false,
		maxOutputTokens:
			positiveInteger(
				record.max_completion_tokens,
				record.max_output_tokens,
				record.top_provider?.max_completion_tokens,
			) ?? 4_096,
		...(typeof record.name === "string" && record.name.trim().length > 0
			? { name: record.name.trim() }
			: {}),
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
