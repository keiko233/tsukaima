import {
	createAssistantMessageEventStream,
	createModels,
	contentText,
	getCurrentTools,
	getSystemMessageText,
	renderSystemMessageUpdate,
	createProvider,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Api,
	type FetchFunction,
	type Model,
	type Provider,
	type ProviderStreams,
	type SimpleStreamOptions,
	type Tool,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ModelPort } from "./model.ts";

export interface OpenAICompatibleConfig {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly providerId?: string;
	readonly fetch?: FetchFunction;
	readonly onMessage?: (message: AssistantMessage) => void;
}

export interface OpenAICompatibleModelConfig {
	readonly modelId: string;
	readonly name?: string;
	readonly capabilities?: readonly ModelCapability[];
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly inputCostPerMillion?: number;
	readonly outputCostPerMillion?: number;
	readonly inputModalities?: readonly OpenAICompatibleInputModality[];
	readonly supportsReasoning?: boolean;
	readonly reasoningLevels?: readonly OpenAICompatibleReasoningLevel[];
	readonly defaultReasoningLevel?: OpenAICompatibleReasoningLevel;
	readonly supportsTools?: boolean;
}

export type OpenAICompatibleInputModality = "text" | "image";

export type OpenAICompatibleReasoningLevel =
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type ModelCapability =
	| "basic-chat"
	| "tool-use"
	| "coding"
	| "chat.persona"
	| "chat.fast"
	| "summarize"
	| "memory.extract"
	| "vision"
	| "tool-heavy"
	| "structured-output"
	| (string & {});

interface OpenAIRequest {
	readonly model: string;
	readonly messages: readonly OpenAIMessage[];
	readonly max_completion_tokens?: number;
	readonly reasoning_effort?: OpenAICompatibleReasoningLevel;
	readonly tools?: readonly OpenAITool[];
	readonly tool_choice?: "auto" | "none";
}

type OpenAIMessage =
	| { readonly role: "system"; readonly content: string }
	| {
			readonly role: "user";
			readonly content: string | readonly OpenAIUserContentPart[];
	  }
	| {
			readonly role: "assistant";
			readonly content: string | null;
			readonly tool_calls?: readonly {
				readonly id: string;
				readonly type: "function";
				readonly function: { readonly name: string; readonly arguments: string };
			}[];
	  }
	| { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

type OpenAIUserContentPart =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image_url"; readonly image_url: { readonly url: string } };

interface OpenAITool {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Tool["parameters"];
	};
}

interface OpenAIResponse {
	readonly choices?: readonly {
		readonly message?: {
			readonly content?: string | null;
			readonly reasoning?: string | null;
			readonly reasoning_content?: string | null;
			readonly tool_calls?: readonly {
				readonly id?: string;
				readonly type?: string;
				readonly function?: { readonly name?: string; readonly arguments?: string };
			}[];
		};
		readonly finish_reason?: string;
	}[];
	readonly id?: string;
	readonly model?: string;
	readonly usage?: {
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
		readonly prompt_tokens_details?: { readonly cached_tokens?: number };
		readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
	};
}

interface OpenAIError {
	readonly error?: { readonly message?: unknown };
	readonly message?: unknown;
}

const usageDefaults: Usage = {
	cacheRead: 0,
	cacheWrite: 0,
	cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
	input: 0,
	output: 0,
	totalTokens: 0,
};

function assertNonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
	return trimmed;
}

function normalizeBaseUrl(value: string): string {
	return assertNonEmpty(value, "Base URL").replace(/\/+$/, "");
}

function usage(input: number, output: number, cacheRead: number): Usage {
	const total = input + output + cacheRead;
	return {
		...usageDefaults,
		cacheRead,
		input,
		output,
		totalTokens: total,
	};
}

function errorAssistantMessage(model: Model<Api>, error: Error): AssistantMessage {
	return {
		api: model.api,
		content: [],
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason: "error",
		timestamp: Date.now(),
		usage: usageDefaults,
		errorMessage: error.message,
	};
}

async function readErrorMessage(response: Response): Promise<string> {
	const fallback = `OpenAI-compatible request failed (${response.status})`;
	const raw = await response.text().catch(() => "");
	if (raw.length === 0) return fallback;
	try {
		const parsed = JSON.parse(raw) as OpenAIError;
		const message = parsed.error?.message ?? parsed.message;
		if (typeof message === "string" && message.trim().length > 0) {
			return `${fallback}: ${message.trim()}`;
		}
	} catch {}
	return `${fallback}: ${raw.slice(0, 500)}`;
}

function parseToolArguments(
	raw: string,
	toolCallId: string,
): {
	arguments: AssistantMessage["content"][number] extends infer Content
		? Content extends { type: "toolCall"; arguments: infer Arguments }
			? Arguments
			: never
		: never;
	argumentsError?: string;
} {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { arguments: {}, argumentsError: "Tool arguments must be a JSON object" };
		}
		return { arguments: parsed as Record<string, never> };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `Invalid tool arguments for ${toolCallId}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function buildAssistantMessage(model: Model<Api>, payload: OpenAIResponse): AssistantMessage {
	const choice = payload.choices?.[0];
	const message = choice?.message;
	const toolCalls: AssistantMessage["content"] = [];
	if (message?.tool_calls) {
		for (const [index, rawCall] of message.tool_calls.entries()) {
			if (rawCall.type !== undefined && rawCall.type !== "function") continue;
			const callId = rawCall.id ?? `tool-call-${index}`;
			const name = rawCall.function?.name ?? "";
			if (name.length === 0) continue;
			const parsed = parseToolArguments(rawCall.function?.arguments ?? "{}", callId);
			toolCalls.push({
				type: "toolCall",
				id: callId,
				name,
				arguments: parsed.arguments,
				...(parsed.argumentsError === undefined ? {} : { argumentsError: parsed.argumentsError }),
			});
		}
	}
	const text = message?.content ?? "";
	const finishReason = choice?.finish_reason;
	const content: AssistantMessage["content"] = [
		...(text.length > 0 ? [{ type: "text", text } as AssistantMessage["content"][number]] : []),
		...toolCalls,
	];
	const promptTokens = payload.usage?.prompt_tokens ?? 0;
	const cacheRead = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
	const outputTokens = payload.usage?.completion_tokens ?? 0;
	const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens;
	const reasoning =
		typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
			? message.reasoning_content
			: typeof message?.reasoning === "string" && message.reasoning.length > 0
				? message.reasoning
				: undefined;
	const messageUsage = usage(promptTokens, outputTokens, cacheRead);
	const stopReason: "toolUse" | "length" | "stop" =
		toolCalls.length > 0 ? "toolUse" : finishReason === "length" ? "length" : "stop";
	return {
		api: model.api,
		content: [
			...(reasoning === undefined ? [] : [{ type: "thinking" as const, thinking: reasoning }]),
			...content,
		],
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason,
		timestamp: Date.now(),
		usage:
			reasoningTokens === undefined
				? messageUsage
				: { ...messageUsage, reasoning: reasoningTokens },
		...(payload.id === undefined ? {} : { responseId: payload.id }),
		...(payload.model === undefined ? {} : { responseModel: payload.model }),
		...(finishReason === undefined ? {} : { rawStopReason: finishReason }),
	};
}

function messageToOpenAI(
	message: TranscriptContext["messages"][number],
	index: number,
): OpenAIMessage | undefined {
	if (message.role === "system") {
		const text = index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message);
		return text.length > 0 ? { role: "system", content: text } : undefined;
	}
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return { role: "user", content: message.content };
		}
		const parts: OpenAIUserContentPart[] = message.content.map((block) =>
			block.type === "text"
				? { type: "text", text: block.text }
				: {
						type: "image_url",
						image_url: { url: `data:${block.mimeType};base64,${block.data}` },
					},
		);
		return {
			role: "user",
			content: parts.every((part) => part.type === "text")
				? parts.map((part) => (part.type === "text" ? part.text : "")).join("")
				: parts,
		};
	}
	if (message.role === "assistant") {
		const text = contentText(
			message.content.filter((block) => block.type !== "toolCall" && block.type !== "thinking"),
		);
		const toolCalls = message.content.flatMap((block) => {
			if (block.type !== "toolCall") return [];
			return [
				{
					id: block.id,
					type: "function" as const,
					function: { name: block.name, arguments: JSON.stringify(block.arguments) },
				},
			];
		});
		return {
			role: "assistant",
			content: text.length > 0 ? text : null,
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		};
	}
	return {
		role: "tool",
		content: contentText(message.content),
		tool_call_id: message.toolCallId,
	};
}

function openAITools(tools: readonly Tool[]): OpenAITool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			description: tool.description,
			name: tool.name,
			parameters: tool.parameters,
		},
	}));
}

export function createOpenAICompatibleStreams(
	config: OpenAICompatibleConfig,
	modelConfigs: readonly OpenAICompatibleModelConfig[] = [],
): ProviderStreams {
	const baseUrl = normalizeBaseUrl(config.baseUrl);
	const apiKey = assertNonEmpty(config.apiKey, "API key");
	const fetchImplementation = config.fetch ?? (fetch as FetchFunction);
	const configs = new Map(modelConfigs.map((modelConfig) => [modelConfig.modelId, modelConfig]));

	const execute = async (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const modelConfig = configs.get(model.id);
		const url = `${baseUrl}/chat/completions`;
		const messages: OpenAIMessage[] = [];
		for (const [index, message] of context.messages.entries()) {
			const converted = messageToOpenAI(message, index);
			if (converted) messages.push(converted);
		}
		const declaredTools = getCurrentTools(context.messages);
		const supportsTools = modelConfig?.supportsTools ?? true;
		const requestedTools = options?.toolChoice === "none" ? [] : declaredTools;
		const tools = supportsTools ? openAITools(requestedTools) : [];
		const maxOutputTokens = Math.min(
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			options?.maxTokens ?? Number.POSITIVE_INFINITY,
		);
		if (!Number.isFinite(maxOutputTokens)) {
			throw new Error(`Model has no output token limit: ${model.id}`);
		}
		const apiKeyFromOptions = options?.apiKey ?? apiKey;
		const reasoningEffort =
			model.reasoning === true
				? (options?.reasoning ?? modelConfig?.defaultReasoningLevel)
				: undefined;
		const request: OpenAIRequest = {
			model: model.id,
			messages,
			max_completion_tokens: maxOutputTokens,
			...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
			...(tools.length > 0 ? { tools, tool_choice: options?.toolChoice ?? "auto" } : {}),
		};
		let response: Response;
		try {
			response = await fetchImplementation(url, {
				body: JSON.stringify(request),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${apiKeyFromOptions}`,
					"content-type": "application/json",
				},
				method: "POST",
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			});
		} catch (error) {
			throw error instanceof Error && error.name === "AbortError"
				? error
				: new Error(
						`OpenAI-compatible request failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
		}
		if (!response.ok) {
			throw new Error(await readErrorMessage(response));
		}
		let payload: OpenAIResponse;
		try {
			payload = (await response.json()) as OpenAIResponse;
		} catch (error) {
			throw new Error(
				`Invalid JSON from OpenAI-compatible provider: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (!payload.choices?.length) {
			throw new Error("OpenAI-compatible response contained no choices");
		}
		return buildAssistantMessage(model, payload);
	};

	const stream = (
		requestModel: Model<Api>,
		requestContext: TranscriptContext,
		requestOptions?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const output = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				const message = await execute(requestModel, requestContext, requestOptions);
				config.onMessage?.(message);
				output.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
				for (const [index, block] of message.content.entries()) {
					if (block.type === "thinking") {
						output.push({
							type: "thinking_start",
							contentIndex: index,
							partial: { ...message, content: [] },
						});
						output.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: block.thinking,
							partial: message,
						});
						output.push({
							type: "thinking_end",
							contentIndex: index,
							content: block.thinking,
							partial: message,
						});
					}
					if (block.type === "text") {
						output.push({
							type: "text_start",
							contentIndex: index,
							partial: { ...message, content: [] },
						});
						output.push({
							type: "text_delta",
							contentIndex: index,
							delta: block.text,
							partial: message,
						});
						output.push({
							type: "text_end",
							contentIndex: index,
							content: block.text,
							partial: message,
						});
					}
				}
				for (const [index, toolCall] of message.content
					.flatMap((block) => (block.type === "toolCall" ? [block] : []))
					.entries()) {
					output.push({
						type: "toolcall_start",
						contentIndex: index,
						partial: { ...message, content: [] },
					});
					output.push({
						type: "toolcall_delta",
						contentIndex: index,
						delta: JSON.stringify(toolCall.arguments),
						partial: message,
					});
					output.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
				}
				output.push({
					type: "done",
					reason:
						message.stopReason === "toolUse" || message.stopReason === "length"
							? message.stopReason
							: "stop",
					message,
				});
				output.end(message);
			} catch (error) {
				const message = errorAssistantMessage(
					requestModel,
					error instanceof Error ? error : new Error(String(error)),
				);
				config.onMessage?.(message);
				output.push({ type: "error", reason: "error", error: message });
				output.end(message);
			}
		});
		return output;
	};

	return {
		stream,
		streamSimple: stream,
	};
}

export function createOpenAICompatibleProvider(
	providerConfig: OpenAICompatibleConfig,
	modelConfigs: readonly OpenAICompatibleModelConfig[],
): Provider<"openai-compatible"> {
	const providerId = providerConfig.providerId ?? "openai-compatible";
	if (modelConfigs.length === 0) throw new Error("At least one model configuration is required");
	const models = modelConfigs.map((modelConfig) => ({
		api: "openai-compatible" as const,
		baseUrl: normalizeBaseUrl(providerConfig.baseUrl),
		contextWindow: modelConfig.contextWindow ?? 128_000,
		cost: {
			cacheRead: 0,
			cacheWrite: 0,
			input: (modelConfig.inputCostPerMillion ?? 0) / 1_000_000,
			output: (modelConfig.outputCostPerMillion ?? 0) / 1_000_000,
		},
		id: assertNonEmpty(modelConfig.modelId, "Model ID"),
		input:
			modelConfig.inputModalities?.includes("image") === true
				? (["text", "image"] satisfies ("text" | "image")[])
				: (["text"] satisfies ("text" | "image")[]),
		maxTokens: modelConfig.maxOutputTokens ?? 4_096,
		name: modelConfig.name ?? modelConfig.modelId,
		provider: providerId,
		reasoning: modelConfig.supportsReasoning ?? false,
	}));
	return createProvider({
		api: createOpenAICompatibleStreams(providerConfig, modelConfigs),
		auth: {
			apiKey: {
				name: "OpenAI-compatible API key",
				resolve: async () => ({
					auth: {
						apiKey: providerConfig.apiKey,
						baseUrl: normalizeBaseUrl(providerConfig.baseUrl),
					},
				}),
			},
		},
		baseUrl: normalizeBaseUrl(providerConfig.baseUrl),
		id: providerId,
		models,
		name: "OpenAI-compatible",
	});
}

export function createOpenAICompatibleModelPort(
	providerConfig: OpenAICompatibleConfig,
	modelConfigs: readonly OpenAICompatibleModelConfig[],
): ModelPort {
	const provider = createOpenAICompatibleProvider(providerConfig, modelConfigs);
	const models = createModels();
	models.setProvider(provider);
	return {
		modelId: modelConfigs[0]?.modelId ?? "",
		models,
		providerId: providerConfig.providerId ?? "openai-compatible",
	};
}

export interface ModelPolicy {
	readonly capability: ModelCapability;
	readonly maxOutputTokens?: number;
	readonly primary: ModelRef;
	readonly fallbacks?: readonly ModelRef[];
	readonly thinking?: "off" | "low" | "medium" | "high";
}

export interface ModelRef {
	readonly modelId: string;
	readonly providerId: string;
}

export interface ModelUsageRecord {
	readonly capability: ModelCapability;
	readonly inputTokens: number;
	readonly modelId: string;
	readonly outputTokens: number;
	readonly providerId: string;
}

export class ModelUsageLedger {
	readonly #records: ModelUsageRecord[] = [];

	get records(): readonly ModelUsageRecord[] {
		return [...this.#records];
	}

	get totals(): { readonly inputTokens: number; readonly outputTokens: number } {
		return this.#records.reduce(
			(accumulator, record) => ({
				inputTokens: accumulator.inputTokens + record.inputTokens,
				outputTokens: accumulator.outputTokens + record.outputTokens,
			}),
			{ inputTokens: 0, outputTokens: 0 },
		);
	}

	record(message: AssistantMessage, capability: ModelCapability): ModelUsageRecord {
		const record: ModelUsageRecord = {
			capability,
			inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
			modelId: message.model,
			outputTokens: message.usage.output,
			providerId: message.provider,
		};
		this.#records.push(record);
		return record;
	}
}

export interface RouteModelRequest {
	readonly capability: ModelCapability;
	readonly policies?: readonly ModelPolicy[];
}

export interface RoutedModel {
	readonly maxOutputTokens?: number;
	readonly model: Model<Api>;
	readonly policy: ModelPolicy;
}

export class ModelPolicyRouter {
	readonly #models = new Map<string, Model<Api>>();

	constructor(models: readonly Model<Api>[]) {
		for (const model of models) {
			this.#models.set(`${model.provider}:${model.id}`, model);
		}
	}

	select(request: RouteModelRequest): RoutedModel {
		const candidates = request.policies?.filter(
			(policy) => policy.capability === request.capability,
		);
		const policy = candidates?.[0];
		if (!policy) throw new Error(`No model policy for capability: ${request.capability}`);
		const fallbacks = [policy.primary, ...(policy.fallbacks ?? [])];
		for (const modelRef of fallbacks) {
			const model = this.#models.get(`${modelRef.providerId}:${modelRef.modelId}`);
			if (model) {
				const policyLimit = policy.maxOutputTokens;
				const modelLimit = model.maxTokens;
				const maxOutputTokens =
					policyLimit === undefined
						? modelLimit
						: modelLimit === undefined
							? policyLimit
							: Math.min(modelLimit, policyLimit);
				return {
					...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
					model,
					policy,
				};
			}
		}
		throw new Error(`No available model for capability: ${request.capability}`);
	}
}
