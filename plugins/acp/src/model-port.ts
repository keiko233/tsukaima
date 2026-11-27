import {
	contentText,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	getCurrentTools,
	getSystemMessageText,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Api,
	type ImageContent,
	type JsonObject,
	type Model,
	type ProviderStreams,
	type StreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ModelPort } from "@tsukaima/core";
import type { PluginLogger, PluginModelPort } from "@tsukaima/sdk";
import { createAcpModel, type AcpModelConfig, type ResolvedAcpProfile } from "./config.ts";
import type { AcpManagedClient, AcpProcessManager, AcpSessionContext } from "./process-manager.ts";
import type {
	AcpClientHandlers,
	AcpContentBlock,
	AcpPromptInput,
	AcpPromptResult,
	AcpSessionUpdate,
} from "./protocol.ts";

const ACP_API = "acp";
const ACP_BASE_URL = "acp://local";
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

export interface CreateAcpModelPortOptions {
	readonly logger?: PluginLogger;
	readonly onMessage?: (message: AssistantMessage) => void;
	readonly processManager: AcpProcessManager;
	readonly profile: ResolvedAcpProfile;
	readonly toolsRootDir?: string;
}

/** Structural view of the stdio client methods this port needs beyond `AcpManagedClient`. */
interface AcpProtocolClient {
	prompt(input: AcpPromptInput): Promise<AcpPromptResult>;
	setSessionHandlers?(sessionId: string, handlers: AcpClientHandlers | undefined): void;
}

/** Permission requests are denied and no filesystem or terminal handlers are installed. */
const CHAT_SESSION_HANDLERS: AcpClientHandlers = {
	onPermissionRequest: () => ({ outcome: "cancelled" }),
};

/**
 * Build a chat-only model port backed by an ACP stdio agent.
 *
 * The port streams `agent_thought_chunk` as thinking blocks and `agent_message_chunk` as text
 * blocks. It never installs filesystem or terminal handlers and always denies permission
 * requests through the per-session handler.
 */
export function createAcpModelPort(
	options: CreateAcpModelPortOptions,
): ModelPort & PluginModelPort {
	const { logger, onMessage, processManager, profile, toolsRootDir } = options;
	const modelConfigs = resolvedModelConfigs(profile);
	const providerModels = modelConfigs.map((config) => ({
		api: ACP_API,
		baseUrl: ACP_BASE_URL,
		contextWindow: config.contextWindow,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id: config.id,
		input: config.supportsImage
			? (["text", "image"] satisfies ("text" | "image")[])
			: (["text"] satisfies ("text" | "image")[]),
		maxTokens: config.maxOutputTokens,
		name: config.name ?? config.id,
		provider: profile.providerId,
		reasoning: config.supportsReasoning,
	}));
	const fixedModelIds = new Set(profile.enabledModels.map((model) => model.id));

	const runStream = (
		model: Model<Api>,
		context: TranscriptContext,
		requestOptions: StreamOptions | undefined,
		output: AssistantMessageEventStream,
		startedAt: number,
	): Promise<void> =>
		runAcpStream({
			context,
			fixedModelIds,
			model,
			output,
			processManager,
			profile,
			requestOptions,
			startedAt,
			...(logger === undefined ? {} : { logger }),
			...(onMessage === undefined ? {} : { onMessage }),
			...(toolsRootDir === undefined ? {} : { toolsRootDir }),
		});

	const stream: ProviderStreams["stream"] = (model, context, requestOptions) => {
		const output = createAssistantMessageEventStream();
		const startedAt = Date.now();
		queueMicrotask(() => {
			void runStream(model, context, requestOptions, output, startedAt).catch((error: unknown) => {
				// `runAcpStream` handles prompt failures itself; this only guards a defect in that path.
				const message: AssistantMessage = {
					api: model.api,
					content: [],
					model: model.id,
					provider: model.provider,
					role: "assistant",
					stopReason: "error",
					timestamp: startedAt,
					usage: emptyUsage(),
					errorMessage: error instanceof Error ? error.message : String(error),
				};
				logger?.error("ACP model stream failed unexpectedly", {
					error: message.errorMessage,
					modelId: model.id,
					providerId: profile.providerId,
				});
				output.push({ error: message, reason: "error", type: "error" });
				output.end(message);
			});
		});
		return output;
	};

	const provider = createProvider({
		api: { stream, streamSimple: stream },
		auth: {
			apiKey: {
				name: "ACP local runtime",
				resolve: async () => ({ auth: {} }),
			},
		},
		baseUrl: ACP_BASE_URL,
		id: profile.providerId,
		models: providerModels,
		name: profile.name ?? profile.id,
	});
	const models = createModels();
	models.setProvider(provider);
	return { modelId: modelConfigs[0]?.id ?? "", models, providerId: profile.providerId };
}

interface RunAcpStreamInput {
	readonly context: TranscriptContext;
	readonly fixedModelIds: ReadonlySet<string>;
	readonly logger?: PluginLogger;
	readonly model: Model<Api>;
	readonly onMessage?: (message: AssistantMessage) => void;
	readonly output: AssistantMessageEventStream;
	readonly processManager: AcpProcessManager;
	readonly profile: ResolvedAcpProfile;
	readonly requestOptions: StreamOptions | undefined;
	readonly startedAt: number;
	readonly toolsRootDir?: string;
}

async function runAcpStream(input: RunAcpStreamInput): Promise<void> {
	const {
		context,
		fixedModelIds,
		logger,
		model,
		onMessage,
		output,
		processManager,
		profile,
		requestOptions,
		startedAt,
		toolsRootDir,
	} = input;
	const signal = requestOptions?.signal;
	const content: AssistantMessage["content"] = [];
	const base: AssistantMessage = {
		api: model.api,
		content,
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason: "pending",
		timestamp: startedAt,
		usage: emptyUsage(),
	};
	const partial = (): AssistantMessage => ({ ...base, content: [...content] });
	const notify = (message: AssistantMessage): void => {
		try {
			onMessage?.(message);
		} catch (error) {
			logger?.warn("ACP model message callback failed", {
				error: error instanceof Error ? error.message : String(error),
				modelId: model.id,
				providerId: profile.providerId,
			});
		}
	};

	let thinking:
		| {
				readonly block: Extract<AssistantMessage["content"][number], { type: "thinking" }>;
				readonly index: number;
		  }
		| undefined;
	let text:
		| {
				readonly block: Extract<AssistantMessage["content"][number], { type: "text" }>;
				readonly index: number;
		  }
		| undefined;
	const closeThinking = (): void => {
		if (thinking === undefined) return;
		output.push({
			content: thinking.block.thinking,
			contentIndex: thinking.index,
			partial: partial(),
			type: "thinking_end",
		});
		thinking = undefined;
	};
	const closeText = (): void => {
		if (text === undefined) return;
		output.push({
			content: text.block.text,
			contentIndex: text.index,
			partial: partial(),
			type: "text_end",
		});
		text = undefined;
	};
	const emitThinking = (delta: string): void => {
		if (delta.length === 0) return;
		closeText();
		if (thinking === undefined) {
			const block = { thinking: "", type: "thinking" as const };
			output.push({ contentIndex: content.length, partial: partial(), type: "thinking_start" });
			content.push(block);
			thinking = { block, index: content.length - 1 };
		}
		thinking.block.thinking += delta;
		output.push({
			contentIndex: thinking.index,
			delta,
			partial: partial(),
			type: "thinking_delta",
		});
	};
	const emitText = (delta: string): void => {
		if (delta.length === 0) return;
		closeThinking();
		if (text === undefined) {
			const block = { text: "", type: "text" as const };
			output.push({ contentIndex: content.length, partial: partial(), type: "text_start" });
			content.push(block);
			text = { block, index: content.length - 1 };
		}
		text.block.text += delta;
		output.push({ contentIndex: text.index, delta, partial: partial(), type: "text_delta" });
	};

	const tools = getCurrentTools(context.messages);
	const promptJson = profile.toolBridgeMode === "prompt-json" && tools.length > 0;
	let sawToolCall = false;
	let toolCallId = 0;
	let messageBuffer = "";
	let toolCallBuffer = "";
	let insideToolCall = false;

	const emitToolCall = (raw: string): void => {
		const parsed = parsePromptJsonToolCall(raw, `acp-tool-${toolCallId}`);
		if (parsed === undefined) {
			emitText(`${TOOL_CALL_OPEN}${raw}${TOOL_CALL_CLOSE}`);
			return;
		}
		toolCallId += 1;
		closeThinking();
		closeText();
		output.push({ contentIndex: content.length, partial: partial(), type: "toolcall_start" });
		content.push(parsed);
		const index = content.length - 1;
		output.push({
			contentIndex: index,
			delta: JSON.stringify(parsed.arguments),
			partial: partial(),
			type: "toolcall_delta",
		});
		output.push({
			contentIndex: index,
			partial: partial(),
			toolCall: parsed,
			type: "toolcall_end",
		});
		sawToolCall = true;
	};

	const flushMessageBuffer = (final: boolean): void => {
		for (;;) {
			if (!insideToolCall) {
				const open = messageBuffer.indexOf(TOOL_CALL_OPEN);
				if (open === -1) {
					if (final) {
						emitText(messageBuffer);
						messageBuffer = "";
						return;
					}
					const held = longestSuffixPrefixLength(messageBuffer, TOOL_CALL_OPEN);
					const flushLength = messageBuffer.length - held;
					if (flushLength > 0) {
						emitText(messageBuffer.slice(0, flushLength));
						messageBuffer = messageBuffer.slice(flushLength);
					}
					return;
				}
				if (open > 0) emitText(messageBuffer.slice(0, open));
				messageBuffer = messageBuffer.slice(open + TOOL_CALL_OPEN.length);
				insideToolCall = true;
				toolCallBuffer = "";
				continue;
			}

			const close = messageBuffer.indexOf(TOOL_CALL_CLOSE);
			if (close !== -1) {
				toolCallBuffer += messageBuffer.slice(0, close);
				messageBuffer = messageBuffer.slice(close + TOOL_CALL_CLOSE.length);
				emitToolCall(toolCallBuffer);
				toolCallBuffer = "";
				insideToolCall = false;
				continue;
			}
			toolCallBuffer += messageBuffer;
			messageBuffer = "";
			if (final) {
				emitText(`${TOOL_CALL_OPEN}${toolCallBuffer}`);
				toolCallBuffer = "";
				insideToolCall = false;
			}
			return;
		}
	};

	const handleUpdate = (update: AcpSessionUpdate): void => {
		const value = updateText(update);
		if (value.length === 0) return;
		if (update.sessionUpdate === "agent_thought_chunk") {
			emitThinking(value);
			return;
		}
		if (update.sessionUpdate !== "agent_message_chunk") return;
		if (!promptJson) {
			emitText(value);
			return;
		}
		messageBuffer += value;
		flushMessageBuffer(false);
	};

	output.push({ partial: partial(), type: "start" });
	logger?.debug("ACP model request started", {
		modelId: model.id,
		providerId: profile.providerId,
		toolBridgeMode: profile.toolBridgeMode,
	});

	try {
		throwIfAborted(signal);
		const sessionOptions = {
			...(profile.cwd === undefined ? {} : { cwd: profile.cwd }),
			...(fixedModelIds.has(model.id) ? { modelId: model.id } : {}),
			...(signal === undefined ? {} : { signal }),
			...(toolsRootDir === undefined ? {} : { toolsRootDir }),
		};
		const rawStopReason = await processManager.withSession(
			profile,
			sessionOptions,
			async (session) => {
				throwIfAborted(signal);
				const protocol = asProtocolClient(session.client);
				if (protocol === undefined) throw new Error("ACP client does not support prompting");
				const setHandlers = protocol.setSessionHandlers;
				if (setHandlers !== undefined) {
					setHandlers.call(protocol, session.sessionId, CHAT_SESSION_HANDLERS);
				}
				try {
					const prompt = buildPrompt(
						context,
						session,
						model.input.includes("image"),
						promptJson,
						tools,
					);
					const result = await protocol.prompt({
						...(signal === undefined ? {} : { signal }),
						onUpdate: handleUpdate,
						prompt,
						sessionId: session.sessionId,
						timeoutMs: profile.requestTimeoutMs,
					});
					throwIfAborted(signal);
					if (promptJson) flushMessageBuffer(true);
					if (result.stopReason === "cancelled" || result.stopReason === "canceled") {
						throw abortError();
					}
					return result.stopReason;
				} finally {
					if (setHandlers !== undefined) {
						setHandlers.call(protocol, session.sessionId, undefined);
					}
				}
			},
		);
		closeThinking();
		closeText();
		const stopReason = doneReason(rawStopReason, sawToolCall);
		const message: AssistantMessage = {
			...base,
			content: [...content],
			...(rawStopReason === undefined ? {} : { rawStopReason }),
			stopReason,
		};
		notify(message);
		logger?.debug("ACP model request completed", {
			durationMs: Date.now() - startedAt,
			modelId: model.id,
			providerId: profile.providerId,
			stopReason,
		});
		output.push({ message, reason: stopReason, type: "done" });
		output.end(message);
	} catch (caught) {
		const aborted =
			signal?.aborted === true || (caught instanceof Error && caught.name === "AbortError");
		const error = caught instanceof Error ? caught : new Error(String(caught));
		const message: AssistantMessage = {
			...base,
			content: [...content],
			...(aborted ? {} : { errorMessage: error.message }),
			stopReason: aborted ? "aborted" : "error",
		};
		notify(message);
		if (!aborted) {
			logger?.warn("ACP model request failed", {
				error: error.message,
				modelId: model.id,
				providerId: profile.providerId,
			});
		}
		output.push({ error: message, reason: aborted ? "aborted" : "error", type: "error" });
		output.end(message);
	}
}

function resolvedModelConfigs(profile: ResolvedAcpProfile): readonly AcpModelConfig[] {
	if (profile.enabledModels.length > 0) return profile.enabledModels;
	return [
		createAcpModel(`${profile.id}:default`, {
			enabled: true,
			name: profile.name ?? profile.id,
		}),
	];
}

function buildPrompt(
	context: TranscriptContext,
	session: AcpSessionContext,
	supportsImages: boolean,
	promptJson: boolean,
	tools: readonly Tool[],
): readonly AcpContentBlock[] {
	const rendered = renderContext(context);
	const text = promptJson ? joinText(rendered.text, promptJsonInstructions(tools)) : rendered.text;
	const prompt: AcpContentBlock[] = [];
	if (text.length > 0) prompt.push({ text, type: "text" });
	if (supportsImages && session.promptCapabilities?.image !== false) {
		for (const image of rendered.images) {
			prompt.push({ data: image.data, mimeType: image.mimeType, type: "image" });
		}
	}
	if (prompt.length === 0) prompt.push({ text: "", type: "text" });
	return prompt;
}

interface RenderedContext {
	readonly images: readonly ImageContent[];
	readonly text: string;
}

function renderContext(context: TranscriptContext): RenderedContext {
	const parts: string[] = [];
	const images: ImageContent[] = [];
	let systemMessages = 0;
	for (const message of context.messages) {
		switch (message.role) {
			case "system": {
				const text = getSystemMessageText(message).trim();
				if (text.length > 0) {
					parts.push(systemMessages === 0 ? text : `[system update]\n${text}`);
				}
				systemMessages += 1;
				break;
			}
			case "user": {
				const text = contentText(message.content).trim();
				if (text.length > 0) parts.push(`[user]\n${text}`);
				if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "image") images.push(block);
					}
				}
				break;
			}
			case "assistant": {
				const segments: string[] = [];
				const text = contentText(message.content).trim();
				if (text.length > 0) segments.push(text);
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					segments.push(`[tool call ${block.name}]\n${JSON.stringify(block.arguments)}`);
				}
				if (segments.length > 0) parts.push(`[assistant]\n${segments.join("\n")}`);
				break;
			}
			case "toolResult": {
				const text = contentText(message.content).trim();
				if (text.length > 0 || message.isError) {
					parts.push(
						`[tool result ${message.toolName}${message.isError ? " (error)" : ""}]\n${text}`,
					);
				}
				for (const block of message.content) {
					if (block.type === "image") images.push(block);
				}
				break;
			}
		}
	}
	return { images, text: parts.join("\n\n") };
}

function promptJsonInstructions(tools: readonly Tool[]): string {
	const definitions = tools
		.map((tool) =>
			[
				`Tool: ${tool.name}`,
				`Description: ${tool.description}`,
				`Parameters JSON Schema: ${JSON.stringify(tool.parameters)}`,
			].join("\n"),
		)
		.join("\n\n");
	return [
		"Tool use is available.",
		"To call a tool, emit a single block in this exact form, with valid JSON:",
		'<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>',
		"Use one block per tool call and do not wrap it in Markdown fences.",
		definitions,
	].join("\n\n");
}

function parsePromptJsonToolCall(raw: string, id: string): ToolCall | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
	if (name.length === 0) return undefined;
	const argumentsValue = parsed.arguments;
	if (!isRecord(argumentsValue)) return undefined;
	return { arguments: argumentsValue as JsonObject, id, name, type: "toolCall" };
}

function updateText(update: AcpSessionUpdate): string {
	if (typeof update.text === "string") return update.text;
	const content = update.content;
	if (content === undefined) return "";
	if (Array.isArray(content)) {
		return content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	const block = content as AcpContentBlock;
	return block.type === "text" ? block.text : "";
}

function longestSuffixPrefixLength(value: string, prefix: string): number {
	const max = Math.min(value.length, prefix.length - 1);
	for (let length = max; length > 0; length -= 1) {
		if (value.endsWith(prefix.slice(0, length))) return length;
	}
	return 0;
}

function doneReason(raw: string | undefined, sawToolCall: boolean): "stop" | "length" | "toolUse" {
	if (sawToolCall) return "toolUse";
	if (raw === "length" || raw === "max_tokens" || raw === "maxTokens") return "length";
	return "stop";
}

function asProtocolClient(client: AcpManagedClient): AcpProtocolClient | undefined {
	const candidate = client as Partial<AcpProtocolClient>;
	return typeof candidate.prompt === "function" ? (candidate as AcpProtocolClient) : undefined;
}

function abortError(): Error {
	const error = new Error("ACP model request was aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw abortError();
}

function joinText(left: string, right: string): string {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	return `${left}\n\n${right}`;
}

function emptyUsage(): Usage {
	return {
		cacheRead: 0,
		cacheWrite: 0,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
		input: 0,
		output: 0,
		totalTokens: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
