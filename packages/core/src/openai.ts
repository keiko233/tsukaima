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
import { previewText, type CoreLogger } from "./logger.ts";

export interface OpenAICompatibleConfig {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly providerId?: string;
	readonly fetch?: FetchFunction;
	readonly logger?: CoreLogger;
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
	/** Sampling defaults for this model; request options and conversation policy override them. */
	readonly temperature?: number;
	readonly topP?: number;
	readonly stop?: readonly string[];
	/**
	 * Longest wait for response headers and longest silent gap inside a streamed response.
	 * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. A timeout fails the attempt with a
	 * retryable error instead of an abort, so pi-durable's retry policy takes over.
	 */
	readonly requestTimeoutMs?: number;
}

/** Default header and stream-idle timeout for OpenAI-compatible requests. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** A request that waited too long for headers or for the next stream chunk. */
export class OpenAIRequestTimeoutError extends Error {
	override readonly name = "OpenAIRequestTimeoutError";
	constructor(
		readonly timeoutMs: number,
		readonly phase: "response" | "stream",
	) {
		super(
			phase === "response"
				? `OpenAI-compatible request timed out after ${timeoutMs}ms waiting for a response`
				: `OpenAI-compatible stream stalled for ${timeoutMs}ms`,
		);
	}
}

/**
 * Abort controller for one request that fires when the caller aborts or when no progress was
 * seen for `timeoutMs`. `touch()` re-arms the idle timer after each received chunk.
 */
function createRequestWatchdog(timeoutMs: number, parent: AbortSignal | undefined) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut: OpenAIRequestTimeoutError | undefined;
	const onParentAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted === true) controller.abort(parent.reason);
	else parent?.addEventListener("abort", onParentAbort, { once: true });
	const touch = (phase: "response" | "stream") => {
		if (timer !== undefined) clearTimeout(timer);
		if (timeoutMs <= 0 || controller.signal.aborted) return;
		timer = setTimeout(() => {
			timedOut = new OpenAIRequestTimeoutError(timeoutMs, phase);
			controller.abort(timedOut);
		}, timeoutMs);
		timer.unref?.();
	};
	return {
		signal: controller.signal,
		touch,
		timedOut: () => timedOut,
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

/** Run one body read, rejecting as soon as `signal` aborts even if the body never settles. */
function readWithSignal<R>(read: () => Promise<R>, signal: AbortSignal | undefined): Promise<R> {
	if (signal === undefined) return read();
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		read().then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
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
	readonly temperature?: number;
	readonly top_p?: number;
	readonly stop?: readonly string[];
	readonly stream?: true;
	readonly stream_options?: { readonly include_usage: true };
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
			readonly reasoning_content?: string;
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

interface OpenAIReasoningDetail {
	readonly text?: string | null;
	readonly summary?: string | null;
}

interface OpenAIResponse {
	readonly choices?: readonly {
		readonly message?: {
			readonly content?: string | null;
			readonly reasoning?: string | null;
			readonly reasoning_content?: string | null;
			readonly reasoning_details?: readonly OpenAIReasoningDetail[] | null;
			readonly thinking?: string | null;
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

interface OpenAIStreamToolCall {
	readonly index?: number;
	readonly id?: string;
	readonly type?: string;
	readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface OpenAIStreamDelta {
	readonly content?: string | null;
	readonly reasoning?: string | null;
	readonly reasoning_content?: string | null;
	readonly reasoning_details?: readonly OpenAIReasoningDetail[] | null;
	readonly thinking?: string | null;
	readonly tool_calls?: readonly OpenAIStreamToolCall[];
}

interface OpenAIStreamChunk {
	readonly choices?: readonly {
		readonly delta?: OpenAIStreamDelta;
		readonly finish_reason?: string | null;
	}[];
	readonly error?: { readonly message?: unknown };
	readonly id?: string;
	readonly model?: string;
	readonly usage?: OpenAIResponse["usage"];
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

/** Provider usage object to an assistant usage record; streamed providers may only send it at the end. */
function usageFromPayload(payload: OpenAIResponse["usage"]): Usage {
	const promptTokens = payload?.prompt_tokens ?? 0;
	const cachedTokens = Math.min(promptTokens, payload?.prompt_tokens_details?.cached_tokens ?? 0);
	const base = usage(promptTokens - cachedTokens, payload?.completion_tokens ?? 0, cachedTokens);
	const reasoning = payload?.completion_tokens_details?.reasoning_tokens;
	return reasoning === undefined ? base : { ...base, reasoning };
}

/** Raw `data:` payloads of a server-sent event response, in arrival order. */
async function* readSseData(
	response: Response,
	progress?: { readonly signal: AbortSignal; readonly onChunk: () => void },
): AsyncGenerator<string> {
	const body = response.body;
	if (body === null) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	try {
		while (true) {
			const { done, value } = await readWithSignal(() => reader.read(), progress?.signal);
			if (done) break;
			progress?.onChunk();
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length === 0) {
					if (data.length > 0) {
						yield data.join("\n");
						data = [];
					}
				} else if (line.startsWith("data:")) {
					data.push(line.slice(5).replace(/^ /, ""));
				}
				newline = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length > 0) yield data.join("\n");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Replay a completed message as granular events, for providers that answered with JSON. */
function replayAssistantMessage(
	message: AssistantMessage,
	output: AssistantMessageEventStream,
): void {
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
	for (const [index, block] of message.content.entries()) {
		if (block.type !== "toolCall") continue;
		output.push({
			type: "toolcall_start",
			contentIndex: index,
			partial: { ...message, content: [] },
		});
		output.push({
			type: "toolcall_delta",
			contentIndex: index,
			delta: JSON.stringify(block.arguments),
			partial: message,
		});
		output.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
	}
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

function extractReasoningText(
	source:
		| {
				readonly reasoning?: string | null;
				readonly reasoning_content?: string | null;
				readonly reasoning_details?: readonly OpenAIReasoningDetail[] | null;
				readonly thinking?: string | null;
		  }
		| undefined,
): string | undefined {
	if (source === undefined) return undefined;
	if (typeof source.reasoning_content === "string" && source.reasoning_content.length > 0) {
		return source.reasoning_content;
	}
	if (typeof source.reasoning === "string" && source.reasoning.length > 0) {
		return source.reasoning;
	}
	if (typeof source.thinking === "string" && source.thinking.length > 0) {
		return source.thinking;
	}
	if (Array.isArray(source.reasoning_details) && source.reasoning_details.length > 0) {
		const parts: string[] = [];
		for (const detail of source.reasoning_details) {
			const chunk =
				typeof detail?.text === "string" && detail.text.length > 0
					? detail.text
					: typeof detail?.summary === "string" && detail.summary.length > 0
						? detail.summary
						: undefined;
			if (chunk !== undefined) parts.push(chunk);
		}
		if (parts.length > 0) return parts.join("");
	}
	return undefined;
}

const INLINE_THINKING_OPEN = /<(think|thought|thinking)(?::[^>\s]+)?>/iu;
const INLINE_THINKING_MAX_TAG_LEN = 48;

/**
 * Split inline `<think>...</think>` (and `<thought>`, `<thinking>`, `<think:id>`) emitted inside
 * `content` into `thinking` vs `text` pieces, preserving `<think>` tags inside fenced code blocks.
 * Buffers short trailing partial tags so tags split across SSE chunks never leak into `text`.
 */
class InlineThinkingSplitter {
	#buffer = "";
	#inThinking: string | undefined;
	#fenceChar: "`" | "~" | undefined;
	#fenceLen = 0;
	#atLineStart = true;

	push(chunk: string): { readonly kind: "thinking" | "text"; readonly value: string }[] {
		if (chunk.length === 0) return [];
		this.#buffer += chunk;
		return this.#drain(false);
	}

	flush(): { readonly kind: "thinking" | "text"; readonly value: string }[] {
		return this.#drain(true);
	}

	#drain(final: boolean): { readonly kind: "thinking" | "text"; readonly value: string }[] {
		const out: { readonly kind: "thinking" | "text"; readonly value: string }[] = [];
		const emit = (kind: "thinking" | "text", value: string) => {
			if (value.length === 0) return;
			if (kind === "text") {
				this.#updateFenceState(value);
			}
			const last = out.at(-1);
			if (last !== undefined && last.kind === kind) {
				out[out.length - 1] = { kind, value: last.value + value };
			} else {
				out.push({ kind, value });
			}
		};

		while (this.#buffer.length > 0) {
			if (this.#inThinking !== undefined) {
				const closePattern = new RegExp(`<\\/${this.#inThinking}(?::[^>\\s]+)?\\s*>`, "iu");
				const match = closePattern.exec(this.#buffer);
				if (match !== null) {
					emit("thinking", this.#buffer.slice(0, match.index));
					this.#buffer = this.#buffer.slice(match.index + match[0].length);
					this.#inThinking = undefined;
					continue;
				}
				if (!final) {
					const hold = this.#partialTagStart(this.#buffer);
					if (hold >= 0) {
						emit("thinking", this.#buffer.slice(0, hold));
						this.#buffer = this.#buffer.slice(hold);
						break;
					}
				}
				emit("thinking", this.#buffer);
				this.#buffer = "";
				break;
			}

			// Outside thinking: if we're inside a fenced code block, scan line by line until it closes.
			if (this.#fenceChar !== undefined) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) {
					if (!final) break;
					emit("text", this.#buffer);
					this.#buffer = "";
					break;
				}
				emit("text", this.#buffer.slice(0, newline + 1));
				this.#buffer = this.#buffer.slice(newline + 1);
				continue;
			}

			// Outside thinking and outside a code fence: check whether a code fence starts before any
			// inline thinking tag.
			const fenceIdx = this.#nextFenceStart(this.#buffer);
			const openMatch = INLINE_THINKING_OPEN.exec(this.#buffer);
			const openIdx = openMatch?.index ?? Number.POSITIVE_INFINITY;

			if (fenceIdx < openIdx) {
				const newline = this.#buffer.indexOf("\n", fenceIdx);
				if (newline < 0) {
					if (!final) {
						emit("text", this.#buffer.slice(0, fenceIdx));
						this.#buffer = this.#buffer.slice(fenceIdx);
						break;
					}
					emit("text", this.#buffer);
					this.#buffer = "";
					break;
				}
				emit("text", this.#buffer.slice(0, newline + 1));
				this.#buffer = this.#buffer.slice(newline + 1);
				continue;
			}

			if (openMatch !== null) {
				emit("text", this.#buffer.slice(0, openMatch.index));
				this.#buffer = this.#buffer.slice(openMatch.index + openMatch[0].length);
				this.#inThinking = (openMatch[1] ?? "think").toLowerCase();
				continue;
			}

			if (!final) {
				const holdTag = this.#partialTagStart(this.#buffer);
				const holdFence = this.#partialFenceStart(this.#buffer);
				const hold =
					holdTag >= 0 && holdFence >= 0
						? Math.min(holdTag, holdFence)
						: holdTag >= 0
							? holdTag
							: holdFence;
				if (hold >= 0) {
					emit("text", this.#buffer.slice(0, hold));
					this.#buffer = this.#buffer.slice(hold);
					break;
				}
			}

			emit("text", this.#buffer);
			this.#buffer = "";
		}

		return out;
	}

	#partialTagStart(text: string): number {
		const lastLt = text.lastIndexOf("<");
		if (lastLt < 0) return -1;
		if (text.length - lastLt > INLINE_THINKING_MAX_TAG_LEN) return -1;
		if (text.indexOf(">", lastLt) >= 0) return -1;
		const tail = text.slice(lastLt).toLowerCase();
		if (this.#inThinking !== undefined) {
			const prefix = `</${this.#inThinking}`;
			if (prefix.startsWith(tail) || tail.startsWith(prefix)) return lastLt;
			return -1;
		}
		const candidates = ["<think", "<thought", "<thinking"];
		if (candidates.some((candidate) => candidate.startsWith(tail) || tail.startsWith(candidate))) {
			return lastLt;
		}
		return -1;
	}

	#partialFenceStart(text: string): number {
		const lastNl = text.lastIndexOf("\n");
		const lineStart = lastNl < 0 ? (this.#atLineStart ? 0 : -1) : lastNl + 1;
		if (lineStart < 0) return -1;
		const tail = text.slice(lineStart);
		if (/^ {0,3}(?:`{1,2}|~{1,2})$/u.test(tail)) return lineStart;
		return -1;
	}

	#nextFenceStart(text: string): number {
		let pos = 0;
		let lineStart = this.#atLineStart;
		while (pos < text.length) {
			if (lineStart) {
				const match = /^ {0,3}(`{3,}|~{3,})/u.exec(text.slice(pos));
				if (match !== null) return pos;
			}
			const nl = text.indexOf("\n", pos);
			if (nl < 0) break;
			pos = nl + 1;
			lineStart = true;
		}
		return Number.POSITIVE_INFINITY;
	}

	#updateFenceState(text: string): void {
		let pos = 0;
		while (pos < text.length) {
			const nl = text.indexOf("\n", pos);
			const end = nl < 0 ? text.length : nl;
			if (this.#atLineStart) {
				const line = text.slice(pos, end);
				if (this.#fenceChar === undefined) {
					const open = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
					if (open !== null && open[1] !== undefined) {
						this.#fenceChar = open[1][0] as "`" | "~";
						this.#fenceLen = open[1].length;
					}
				} else {
					const close = new RegExp(`^ {0,3}${this.#fenceChar}{${this.#fenceLen},}[ \\t\\r]*$`, "u");
					if (close.test(line)) {
						this.#fenceChar = undefined;
						this.#fenceLen = 0;
					}
				}
			}
			if (nl < 0) {
				this.#atLineStart = false;
				break;
			}
			pos = nl + 1;
			this.#atLineStart = true;
		}
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
	const rawText = message?.content ?? "";
	const finishReason = choice?.finish_reason;
	const reasoning = extractReasoningText(message);
	const content: AssistantMessage["content"] = [];
	if (reasoning !== undefined) {
		content.push({ type: "thinking", thinking: reasoning });
	}
	if (rawText.length > 0) {
		const splitter = new InlineThinkingSplitter();
		for (const piece of [...splitter.push(rawText), ...splitter.flush()]) {
			if (piece.kind === "thinking") {
				content.push({ type: "thinking", thinking: piece.value });
			} else {
				content.push({ type: "text", text: piece.value });
			}
		}
	}
	content.push(...toolCalls);
	const stopReason: "toolUse" | "length" | "stop" =
		toolCalls.length > 0 ? "toolUse" : finishReason === "length" ? "length" : "stop";
	return {
		api: model.api,
		content,
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason,
		timestamp: Date.now(),
		usage: usageFromPayload(payload.usage),
		...(payload.id === undefined ? {} : { responseId: payload.id }),
		...(payload.model === undefined ? {} : { responseModel: payload.model }),
		...(finishReason === undefined ? {} : { rawStopReason: finishReason }),
	};
}

function messageToOpenAI(
	message: TranscriptContext["messages"][number],
	index: number,
	lastUserIndex: number,
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
		const thinking =
			lastUserIndex >= 0 && index > lastUserIndex
				? message.content
						.flatMap((block) =>
							block.type === "thinking" && block.thinking.length > 0 ? [block.thinking] : [],
						)
						.join("\n")
				: "";
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
			...(thinking.length > 0 ? { reasoning_content: thinking } : {}),
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

/** Single-line text of one converted request message, for the trace-level request preview. */
function openAIMessageText(message: OpenAIMessage): string {
	if (message.role === "tool") return message.content;
	if (message.role === "assistant") return message.content ?? "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
}

/**
 * Consume an OpenAI-compatible SSE response and publish each delta as it arrives.
 *
 * The provider API is the only place a token can wait: a request that buffers the whole body
 * before replaying it gives the WebUI nothing until the model has already answered. Every
 * `delta` here is pushed immediately, so durable's throttled `pi.live` commit sees text,
 * reasoning, and tool-call arguments while the model is still producing them.
 */
async function consumeOpenAIStream(
	model: Model<Api>,
	response: Response,
	output: AssistantMessageEventStream,
	timestamp: number,
	progress?: { readonly signal: AbortSignal; readonly onChunk: () => void },
): Promise<AssistantMessage> {
	const content: AssistantMessage["content"] = [];
	const base: AssistantMessage = {
		api: model.api,
		content,
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason: "pending",
		timestamp,
		usage: usage(0, 0, 0),
	};
	const partial = (): AssistantMessage => ({ ...base, content: [...content] });
	let thinking:
		| { block: Extract<AssistantMessage["content"][number], { type: "thinking" }>; index: number }
		| undefined;
	let text:
		| { block: Extract<AssistantMessage["content"][number], { type: "text" }>; index: number }
		| undefined;
	const toolCalls = new Map<
		number,
		{
			block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
			index: number;
			rawArguments: string;
		}
	>();
	let responseId: string | undefined;
	let responseModel: string | undefined;
	let rawStopReason: string | undefined;
	let messageUsage = usage(0, 0, 0);
	let sawChoice = false;

	const closeThinking = () => {
		if (thinking === undefined) return;
		output.push({
			type: "thinking_end",
			contentIndex: thinking.index,
			content: thinking.block.thinking,
			partial: partial(),
		});
		thinking = undefined;
	};
	const closeText = () => {
		if (text === undefined) return;
		output.push({
			type: "text_end",
			contentIndex: text.index,
			content: text.block.text,
			partial: partial(),
		});
		text = undefined;
	};
	const startThinking = () => {
		if (thinking !== undefined) return thinking;
		output.push({ type: "thinking_start", contentIndex: content.length, partial: partial() });
		const block = { type: "thinking" as const, thinking: "" };
		content.push(block);
		thinking = { block, index: content.length - 1 };
		return thinking;
	};
	const startText = () => {
		if (text !== undefined) return text;
		output.push({ type: "text_start", contentIndex: content.length, partial: partial() });
		const block = { type: "text" as const, text: "" };
		content.push(block);
		text = { block, index: content.length - 1 };
		return text;
	};

	const contentSplitter = new InlineThinkingSplitter();
	const emitThinkingDelta = (value: string) => {
		if (value.length === 0) return;
		if (text !== undefined) closeText();
		const current = startThinking();
		current.block.thinking += value;
		output.push({
			type: "thinking_delta",
			contentIndex: current.index,
			delta: value,
			partial: partial(),
		});
	};
	const emitTextDelta = (value: string) => {
		if (value.length === 0) return;
		if (thinking !== undefined) closeThinking();
		const current = startText();
		current.block.text += value;
		output.push({
			type: "text_delta",
			contentIndex: current.index,
			delta: value,
			partial: partial(),
		});
	};
	const flushContentSplitter = () => {
		for (const piece of contentSplitter.flush()) {
			if (piece.kind === "thinking") emitThinkingDelta(piece.value);
			else emitTextDelta(piece.value);
		}
	};

	for await (const data of readSseData(response, progress)) {
		if (data.trim() === "[DONE]") break;
		let chunk: OpenAIStreamChunk;
		try {
			chunk = JSON.parse(data) as OpenAIStreamChunk;
		} catch {
			continue;
		}
		const errorMessage = chunk.error?.message;
		if (typeof errorMessage === "string" && errorMessage.length > 0) {
			throw new Error(`OpenAI-compatible stream failed: ${errorMessage}`);
		}
		if (chunk.id !== undefined) responseId ??= chunk.id;
		if (chunk.model !== undefined) responseModel ??= chunk.model;
		if (chunk.usage !== undefined) messageUsage = usageFromPayload(chunk.usage);
		const choice = chunk.choices?.[0];
		if (choice === undefined) continue;
		sawChoice = true;
		if (typeof choice.finish_reason === "string") rawStopReason = choice.finish_reason;
		const delta = choice.delta;
		if (delta === undefined) continue;

		const reasoning = extractReasoningText(delta);
		if (reasoning !== undefined) {
			flushContentSplitter();
			emitThinkingDelta(reasoning);
		}
		if (typeof delta.content === "string" && delta.content.length > 0) {
			for (const piece of contentSplitter.push(delta.content)) {
				if (piece.kind === "thinking") emitThinkingDelta(piece.value);
				else emitTextDelta(piece.value);
			}
		}
		for (const call of delta.tool_calls ?? []) {
			const key = call.index ?? 0;
			let current = toolCalls.get(key);
			if (current === undefined) {
				flushContentSplitter();
				if (thinking !== undefined) closeThinking();
				if (text !== undefined) closeText();
				const block = {
					arguments: {},
					id: call.id ?? `tool-call-${key}`,
					name: call.function?.name ?? "",
					type: "toolCall" as const,
				};
				output.push({
					type: "toolcall_start",
					contentIndex: content.length,
					partial: partial(),
				});
				content.push(block);
				current = { block, index: content.length - 1, rawArguments: "" };
				toolCalls.set(key, current);
			} else {
				if (current.block.name.length === 0 && call.function?.name !== undefined) {
					current.block.name = call.function.name;
				}
				if (call.id !== undefined) current.block.id = call.id;
			}
			const argumentPart = call.function?.arguments;
			if (typeof argumentPart === "string" && argumentPart.length > 0) {
				current.rawArguments += argumentPart;
				output.push({
					type: "toolcall_delta",
					contentIndex: current.index,
					delta: argumentPart,
					partial: partial(),
				});
			}
		}
	}

	if (!sawChoice) throw new Error("OpenAI-compatible stream contained no choices");
	flushContentSplitter();
	if (thinking !== undefined) closeThinking();
	if (text !== undefined) closeText();
	for (const current of [...toolCalls.values()].toSorted((a, b) => a.index - b.index)) {
		const parsed = parseToolArguments(
			current.rawArguments.length === 0 ? "{}" : current.rawArguments,
			current.block.id,
		);
		current.block.arguments = parsed.arguments;
		if (parsed.argumentsError !== undefined) current.block.argumentsError = parsed.argumentsError;
		output.push({
			type: "toolcall_end",
			contentIndex: current.index,
			toolCall: current.block,
			partial: partial(),
		});
	}
	const stopReason: "toolUse" | "length" | "stop" =
		toolCalls.size > 0 ? "toolUse" : rawStopReason === "length" ? "length" : "stop";
	return {
		...base,
		content,
		...(responseId === undefined ? {} : { responseId }),
		...(responseModel === undefined ? {} : { responseModel }),
		...(rawStopReason === undefined ? {} : { rawStopReason }),
		stopReason,
		usage: messageUsage,
	};
}

/**
 * Sampling fields for one request: pi-ai request options win over the model's configured
 * defaults. `samplingParams.top_p`/`stop` come from pi-ai's pass-through sampling map.
 *
 * Sampling is explicit operator intent, so reasoning models keep it too. Some providers reject
 * `temperature`/`top_p` together with `reasoning_effort`; forwarding the configured values lets
 * that surface as a clear provider error instead of silently ignoring a saved setting.
 */
function requestSampling(
	modelConfig: OpenAICompatibleModelConfig | undefined,
	options: SimpleStreamOptions | undefined,
): Pick<OpenAIRequest, "temperature" | "top_p" | "stop"> {
	const params = options?.samplingParams;
	const paramTopP = typeof params?.top_p === "number" ? params.top_p : undefined;
	const paramStop =
		Array.isArray(params?.stop) && params.stop.every((value) => typeof value === "string")
			? (params.stop as string[])
			: undefined;
	const temperature = options?.temperature ?? modelConfig?.temperature;
	const topP = paramTopP ?? modelConfig?.topP;
	const stop = paramStop ?? modelConfig?.stop;
	return {
		...(temperature === undefined ? {} : { temperature }),
		...(topP === undefined ? {} : { top_p: topP }),
		...(stop === undefined || stop.length === 0 ? {} : { stop }),
	};
}

export function createOpenAICompatibleStreams(
	config: OpenAICompatibleConfig,
	modelConfigs: readonly OpenAICompatibleModelConfig[] = [],
): ProviderStreams {
	const baseUrl = normalizeBaseUrl(config.baseUrl);
	const apiKey = assertNonEmpty(config.apiKey, "API key");
	const fetchImplementation = config.fetch ?? (fetch as FetchFunction);
	const configs = new Map(modelConfigs.map((modelConfig) => [modelConfig.modelId, modelConfig]));

	const stream = (
		requestModel: Model<Api>,
		requestContext: TranscriptContext,
		requestOptions?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const output = createAssistantMessageEventStream();
		const startedAt = performance.now();
		const timestamp = Date.now();
		const logger = config.logger;
		const providerId = config.providerId ?? requestModel.provider;
		let watchdog: ReturnType<typeof createRequestWatchdog> | undefined;
		queueMicrotask(async () => {
			try {
				const modelConfig = configs.get(requestModel.id);
				const url = `${baseUrl}/chat/completions`;
				const messages: OpenAIMessage[] = [];
				let lastUserIndex = -1;
				for (const [index, message] of requestContext.messages.entries()) {
					if (message.role === "user") lastUserIndex = index;
				}
				for (const [index, message] of requestContext.messages.entries()) {
					const converted = messageToOpenAI(message, index, lastUserIndex);
					if (converted) messages.push(converted);
				}
				const declaredTools = getCurrentTools(requestContext.messages);
				const supportsTools = modelConfig?.supportsTools ?? true;
				const requestedTools = requestOptions?.toolChoice === "none" ? [] : declaredTools;
				const tools = supportsTools ? openAITools(requestedTools) : [];
				const maxOutputTokens = Math.min(
					requestModel.maxTokens ?? Number.POSITIVE_INFINITY,
					requestOptions?.maxTokens ?? Number.POSITIVE_INFINITY,
				);
				if (!Number.isFinite(maxOutputTokens)) {
					const error = new Error(`Model has no output token limit: ${requestModel.id}`);
					logger?.error("OpenAI-compatible request has no output token limit", {
						providerId,
						modelId: requestModel.id,
						durationMs: Math.round(performance.now() - startedAt),
						error,
					});
					throw error;
				}
				const apiKeyFromOptions = requestOptions?.apiKey ?? apiKey;
				const requestedReasoning = requestOptions?.reasoning;
				const clampedReasoning =
					requestedReasoning !== undefined &&
					modelConfig?.reasoningLevels !== undefined &&
					modelConfig.reasoningLevels.length > 0 &&
					!modelConfig.reasoningLevels.includes(requestedReasoning)
						? modelConfig.reasoningLevels[0]
						: requestedReasoning;
				const reasoningEffort =
					requestModel.reasoning === true
						? (clampedReasoning ?? modelConfig?.defaultReasoningLevel)
						: undefined;
				const sampling = requestSampling(modelConfig, requestOptions);
				const baseRequest: OpenAIRequest = {
					model: requestModel.id,
					messages,
					max_completion_tokens: maxOutputTokens,
					...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
					...sampling,
					stream: true,
					stream_options: { include_usage: true },
					...(tools.length > 0 ? { tools, tool_choice: requestOptions?.toolChoice ?? "auto" } : {}),
				};
				// `onPayload` carries pi-durable's `beforeProviderRequest` hooks (per-conversation
				// sampling overrides), so it sees the final body and may replace it.
				const replaced = await requestOptions?.onPayload?.(baseRequest, requestModel);
				const request = (replaced ?? baseRequest) as OpenAIRequest;
				const timeoutMs =
					requestOptions?.timeoutMs ?? modelConfig?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
				watchdog = createRequestWatchdog(timeoutMs, requestOptions?.signal);
				const activeWatchdog = watchdog;
				logger?.debug("OpenAI-compatible chat completion requested", {
					providerId,
					modelId: requestModel.id,
					messageCount: messages.length,
					toolCount: tools.length,
					maxOutputTokens,
					reasoningEffort,
					timeoutMs,
				});
				const lastMessage = messages.findLast(
					(message) => message.role === "user" || message.role === "tool",
				);
				logger?.trace("OpenAI-compatible request detail", {
					providerId,
					modelId: requestModel.id,
					lastMessageRole: lastMessage?.role,
					lastMessagePreview:
						lastMessage === undefined ? undefined : previewText(openAIMessageText(lastMessage)),
					tools: declaredTools.map((tool) => tool.name),
				});
				let response: Response;
				try {
					activeWatchdog.touch("response");
					// Race the fetch against the watchdog as well: a test double or an adapter that
					// ignores the abort signal must not wedge the run after headers never arrive.
					response = await readWithSignal(
						() =>
							fetchImplementation(url, {
								body: JSON.stringify(request),
								headers: {
									accept: "text/event-stream",
									authorization: `Bearer ${apiKeyFromOptions}`,
									"content-type": "application/json",
								},
								method: "POST",
								signal: activeWatchdog.signal,
							}),
						activeWatchdog.signal,
					);
				} catch (error) {
					const durationMs = Math.round(performance.now() - startedAt);
					const timedOut = activeWatchdog.timedOut();
					if (timedOut !== undefined) {
						logger?.warn("OpenAI-compatible request timed out", {
							providerId,
							modelId: requestModel.id,
							durationMs,
							timeoutMs,
						});
						throw timedOut;
					}
					if (error instanceof Error && error.name === "AbortError") {
						logger?.debug("OpenAI-compatible request aborted", {
							providerId,
							modelId: requestModel.id,
							durationMs,
						});
						throw error;
					}
					const wrapped = new Error(
						`OpenAI-compatible request failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
					logger?.error("OpenAI-compatible request failed", {
						providerId,
						modelId: requestModel.id,
						durationMs,
						error: wrapped,
					});
					throw wrapped;
				}
				if (!response.ok) {
					const message = await readErrorMessage(response);
					logger?.warn("OpenAI-compatible request rejected", {
						providerId,
						modelId: requestModel.id,
						durationMs: Math.round(performance.now() - startedAt),
						status: response.status,
						error: message,
					});
					throw new Error(message);
				}
				const contentType = response.headers.get("content-type") ?? "";
				output.push({
					type: "start",
					partial: {
						api: requestModel.api,
						content: [],
						model: requestModel.id,
						provider: requestModel.provider,
						role: "assistant",
						stopReason: "pending",
						timestamp,
						usage: usage(0, 0, 0),
					},
				});
				let assistant: AssistantMessage;
				const progress = {
					signal: activeWatchdog.signal,
					onChunk: () => activeWatchdog.touch("stream"),
				};
				// The body may stall as well as the headers; keep the idle timer armed until it ends.
				activeWatchdog.touch("stream");
				if (contentType.includes("json") || response.body === null) {
					// Some compatible servers ignore `stream: true`; keep the full-body path so a
					// provider that cannot stream still produces a usable answer.
					let payload: OpenAIResponse;
					try {
						payload = (await response.json()) as OpenAIResponse;
					} catch (error) {
						const wrapped = new Error(
							`Invalid JSON from OpenAI-compatible provider: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
						logger?.warn("OpenAI-compatible response was not valid JSON", {
							providerId,
							modelId: requestModel.id,
							durationMs: Math.round(performance.now() - startedAt),
							status: response.status,
							error: wrapped,
						});
						throw wrapped;
					}
					if (!payload.choices?.length) {
						const message = "OpenAI-compatible response contained no choices";
						logger?.warn("OpenAI-compatible response contained no choices", {
							providerId,
							modelId: requestModel.id,
							durationMs: Math.round(performance.now() - startedAt),
							status: response.status,
							error: message,
						});
						throw new Error(message);
					}
					assistant = { ...buildAssistantMessage(requestModel, payload), timestamp };
					replayAssistantMessage(assistant, output);
				} else {
					assistant = await consumeOpenAIStream(
						requestModel,
						response,
						output,
						timestamp,
						progress,
					);
				}
				activeWatchdog.dispose();
				config.onMessage?.(assistant);
				const texts: string[] = [];
				const thinkingTexts: string[] = [];
				const calledTools: string[] = [];
				for (const block of assistant.content) {
					if (block.type === "text") texts.push(block.text);
					else if (block.type === "thinking") thinkingTexts.push(block.thinking);
					else if (block.type === "toolCall") calledTools.push(block.name);
				}
				logger?.debug("OpenAI-compatible chat completion completed", {
					providerId,
					modelId: requestModel.id,
					durationMs: Math.round(performance.now() - startedAt),
					stopReason: assistant.stopReason,
					rawStopReason: assistant.rawStopReason,
					inputTokens: assistant.usage.input,
					outputTokens: assistant.usage.output,
					cacheRead: assistant.usage.cacheRead,
					reasoningTokens: assistant.usage.reasoning,
					toolCallCount: calledTools.length,
				});
				logger?.trace("OpenAI-compatible response detail", {
					providerId,
					modelId: requestModel.id,
					textPreview: previewText(texts.join("\n")),
					reasoningPreview:
						thinkingTexts.length === 0 ? undefined : previewText(thinkingTexts.join("\n")),
					toolCalls: calledTools,
				});
				output.push({
					type: "done",
					reason:
						assistant.stopReason === "toolUse" || assistant.stopReason === "length"
							? assistant.stopReason
							: "stop",
					message: assistant,
				});
				output.end(assistant);
			} catch (caught) {
				// A stalled stream rejects with whatever the body reader saw; report the timeout so the
				// attempt fails as retryable rather than looking like a caller abort.
				const error = watchdog?.timedOut() ?? caught;
				watchdog?.dispose();
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
