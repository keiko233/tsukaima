import { assertPermission, hasPermission } from "./permissions.ts";
import { pluginManifestSchema, type PluginManifest } from "./manifest.ts";
import { LocalTaskBridge } from "./tasks.ts";
import {
	resolveToolPolicyAccess,
	resolveToolPolicy,
	toolPayloadTooLarge,
	type ToolPolicyAccessContext,
} from "./policy.ts";
import type {
	AuditEntry,
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginOutboundApi,
	PluginRequestApi,
	PluginSettingsApi,
} from "./host.ts";
import type { MessageEnvelope } from "@tsukaima/contracts";
import type {
	PluginChannelApi,
	PluginConfig,
	PluginContext,
	PluginConversationsApi,
	PluginEvents,
	PluginHookName,
	PluginLogger,
	PluginAudioTranscribeRequest,
	PluginAudioTranscribeResult,
	PluginDatabaseApi,
	PluginEmbeddingRequest,
	PluginEmbeddingResult,
	PluginFollowUpsApi,
	PluginSchedulesApi,
	PluginMigrationsApi,
	PluginModelCompleteMessage,
	PluginModelCompleteRequest,
	PluginModelCompleteResult,
	PluginModelDescriptor,
	PluginModelInfo,
	PluginModelMessageContentPart,
	PluginModelProvider,
	PluginModelQuery,
	PluginMediaApi,
	PluginModelRegistry,
	PluginCacheApi,
	PluginCacheSetOptions,
	PluginRpcHandler,
	PluginRpcRegistry,
	PluginStorage,
	PluginTasksApi,
	PluginTool,
	PluginToolInvocationResult,
	PluginToolRegistration,
	PluginToolsExtension,
	PluginUiDefinition,
	ToolInvocationContext,
} from "./types.ts";
import { pluginStatusInputSchema } from "@tsukaima/contracts";
import type { PluginStatusSnapshot } from "@tsukaima/contracts";

export {
	DEFAULT_TOOL_POLICY,
	isModelVisibleTool,
	resolveToolPolicy,
	resolveToolPolicyAccess,
	toolPayloadTooLarge,
} from "./policy.ts";

type PluginLoggerLevel = "trace" | "debug" | "info" | "warn" | "error";

type PluginLoggerSink = (level: PluginLoggerLevel, message: string, details: unknown) => void;

function mergeLoggerFields(fields: Record<string, unknown> | undefined, details: unknown): unknown {
	if (fields === undefined || Object.keys(fields).length === 0) return details;
	if (details === undefined) return fields;
	if (isRecord(details)) return { ...fields, ...details };
	return { ...fields, details };
}

function createChildPluginLogger(
	sink: PluginLoggerSink,
	label: string,
	fields: Record<string, unknown> | undefined,
): PluginLogger {
	const target = label.trim().length > 0 ? label.trim() : "child";
	const write = (level: PluginLoggerLevel, message: string, details: unknown): void => {
		sink(level, `[${target}] ${message}`, mergeLoggerFields(fields, details));
	};
	return {
		trace: (message, details) => write("trace", message, details),
		debug: (message, details) => write("debug", message, details),
		info: (message, details) => write("info", message, details),
		warn: (message, details) => write("warn", message, details),
		error: (message, details) => write("error", message, details),
		child: (nestedTarget, nestedFields) =>
			createChildPluginLogger(
				sink,
				`${target}.${nestedTarget}`,
				fields === undefined
					? nestedFields
					: nestedFields === undefined
						? fields
						: { ...fields, ...nestedFields },
			),
	};
}

function writeConsoleLog(level: PluginLoggerLevel, message: string, details: unknown): void {
	const args: unknown[] = details === undefined ? [message] : [message, details];
	switch (level) {
		case "trace":
		case "debug": {
			console.debug(...args);
			break;
		}
		case "info": {
			console.info(...args);
			break;
		}
		case "warn": {
			console.warn(...args);
			break;
		}
		case "error": {
			console.error(...args);
			break;
		}
	}
}

/**
 * Default plugin logger. `trace` intentionally maps to `console.debug` so enabling verbose
 * plugin logging does not require a dedicated console method.
 */
export function createConsolePluginLogger(): PluginLogger {
	return {
		trace: (message, details) => writeConsoleLog("trace", message, details),
		debug: (message, details) => writeConsoleLog("debug", message, details),
		info: (message, details) => writeConsoleLog("info", message, details),
		warn: (message, details) => writeConsoleLog("warn", message, details),
		error: (message, details) => writeConsoleLog("error", message, details),
		child: (target, fields) => createChildPluginLogger(writeConsoleLog, target, fields),
	};
}

/**
 * Completes partial or legacy plugin loggers. A logger without `trace` (for example an older
 * test double) falls back to `debug` so the SDK can always call `trace` safely.
 */
export function normalizePluginLogger(
	logger: Partial<PluginLogger> & Pick<PluginLogger, "debug" | "info" | "warn" | "error">,
): PluginLogger {
	const call = (level: PluginLoggerLevel, message: string, details: unknown): void => {
		const handler = logger[level];
		if (typeof handler === "function") {
			handler.call(logger, message, details);
			return;
		}
		if (level === "trace") {
			logger.debug.call(logger, message, details);
			return;
		}
		const fallback = logger.error ?? logger.warn ?? logger.info ?? logger.debug;
		fallback.call(logger, message, details);
	};
	const normalized: PluginLogger = {
		trace: (message, details) => call("trace", message, details),
		debug: (message, details) => call("debug", message, details),
		info: (message, details) => call("info", message, details),
		warn: (message, details) => call("warn", message, details),
		error: (message, details) => call("error", message, details),
	};
	if (typeof logger.child === "function") {
		const child = logger.child.bind(logger);
		normalized.child = (target, fields) => normalizePluginLogger(child(target, fields));
	}
	return normalized;
}

export class LocalPluginEventBridge {
	readonly #handlers = new Map<
		PluginHookName,
		Set<(payload: unknown) => unknown | Promise<unknown>>
	>();

	on(name: PluginHookName, handler: (payload: unknown) => unknown | Promise<unknown>): () => void {
		const handlers = this.#handlers.get(name) ?? new Set();
		handlers.add(handler);
		this.#handlers.set(name, handlers);
		return () => {
			handlers.delete(handler);
		};
	}

	async emit(name: PluginHookName, payload: unknown): Promise<void> {
		const handlers = this.#handlers.get(name);
		if (!handlers) {
			return;
		}
		for (const handler of handlers) {
			await handler(payload);
		}
	}

	async transform(name: PluginHookName, payload: unknown): Promise<unknown> {
		let current = payload;
		for (const handler of this.#handlers.get(name) ?? []) {
			const next = await handler(current);
			if (next !== undefined) current = next;
		}
		return current;
	}
}

export class LocalToolBridge {
	readonly #tools = new Map<string, PluginTool>();
	readonly #pluginId: string;
	readonly #grantedPermissions: readonly string[];
	readonly #declarations: ReadonlyMap<string, PluginManifest["tools"][number]>;

	constructor(
		pluginId: string,
		grantedPermissions: readonly string[],
		declarations: readonly PluginManifest["tools"][number][] = [],
	) {
		this.#pluginId = pluginId;
		this.#grantedPermissions = grantedPermissions;
		this.#declarations = new Map(
			declarations.map((declaration) => [declaration.name, declaration]),
		);
	}

	register(tool: PluginTool): void {
		const namespace = `${this.#pluginId}.`;
		if (!tool.name.startsWith(namespace) || tool.name === namespace) {
			throw new Error(`Tool ${tool.name} must be namespaced as ${namespace}<name>`);
		}
		for (const permission of tool.requiredPermissions) {
			assertPermission(this.#grantedPermissions, permission, this.#pluginId);
		}
		const declaration = this.#declarations.get(tool.name);
		const lazy = tool.lazy ?? tool.policy?.lazy ?? declaration?.lazy;
		const surface = tool.surface ?? tool.policy?.surface ?? declaration?.surface;
		const shortName =
			tool.modelName ?? tool.shortName ?? declaration?.modelName ?? declaration?.shortName;
		const modelName = tool.modelName ?? declaration?.modelName;
		const aliases = [...(tool.aliases ?? []), ...(declaration?.aliases ?? [])];
		this.#tools.set(tool.name, {
			...tool,
			...(lazy === undefined ? {} : { lazy }),
			...(surface === undefined ? {} : { surface }),
			...(shortName === undefined ? {} : { shortName }),
			...(modelName === undefined ? {} : { modelName }),
			...(aliases.length === 0 ? {} : { aliases }),
		});
	}

	list(): readonly PluginTool[] {
		return [...this.#tools.values()];
	}

	unregister(name: string): void {
		this.#tools.delete(name);
	}

	async invoke(
		name: string,
		input: Record<string, unknown>,
		context: ToolInvocationContext = {},
	): Promise<PluginToolInvocationResult> {
		const tool = this.#tools.get(name);
		if (!tool) {
			return {
				message: `Unknown tool ${name}`,
				ok: false as const,
				reason: "unknown_tool",
			};
		}
		for (const permission of tool.requiredPermissions) {
			if (!hasPermission(this.#grantedPermissions, permission)) {
				return {
					ok: false as const,
					reason: "permission_denied",
					permission,
				};
			}
		}
		const decision = resolveToolPolicyAccess(tool, {
			...context,
			...(context.allowedTools === undefined
				? {}
				: { conversationAllowedTools: context.allowedTools }),
			grantedPermissions: this.#grantedPermissions,
		});
		if (!decision.allowed) {
			return {
				ok: false as const,
				reason: decision.reason?.startsWith("task_kind") ? "task_kind_denied" : "unauthorized",
				...(decision.reason === undefined ? {} : { message: decision.reason }),
			};
		}
		if (toolPayloadTooLarge(tool, input)) {
			return {
				message: `Tool ${name} payload exceeds maxPayloadBytes`,
				ok: false as const,
				reason: "payload_too_large",
			};
		}
		return {
			ok: true as const,
			result: await tool.execute(input, context),
		};
	}
}

export class LocalUiBridge {
	readonly #definitions = new Map<string, PluginUiDefinition>();
	readonly #onStatus: ((status: PluginStatusSnapshot | null) => void) | undefined;
	readonly #pluginId: string;
	readonly #grantedPermissions: readonly string[];
	#status: PluginStatusSnapshot | null = null;

	constructor(
		options: {
			readonly onStatus?: (status: PluginStatusSnapshot | null) => void;
			readonly pluginId?: string;
			readonly grantedPermissions?: readonly string[];
		} = {},
	) {
		this.#onStatus = options.onStatus;
		this.#pluginId = options.pluginId ?? "plugin";
		this.#grantedPermissions = options.grantedPermissions ?? ["ui.panel"];
	}

	register(definition: PluginUiDefinition): void {
		assertPermission(this.#grantedPermissions, "ui.panel", this.#pluginId);
		// Component-specific permissions are enforced by the renderer against the plugin's
		// grant; registration only requires the base ui.panel scope.
		this.#definitions.set(definition.id, definition);
	}

	list(): readonly PluginUiDefinition[] {
		return [...this.#definitions.values()];
	}

	setStatus(input: unknown): void {
		if (!hasPermission(this.#grantedPermissions, "ui.panel")) {
			console.warn(
				`tsukaima: plugin ${this.#pluginId} is not granted permission ui.panel; status dropped`,
			);
			return;
		}
		if (input === null) {
			this.#status = null;
			this.#onStatus?.(null);
			return;
		}
		const parsed = pluginStatusInputSchema.safeParse(input);
		if (!parsed.success) {
			console.warn("tsukaima: dropped invalid plugin status", parsed.error.message);
			return;
		}
		const metrics = parsed.data.metrics;
		const details = parsed.data.details;
		if (
			(metrics !== undefined && Object.keys(metrics).length > 32) ||
			(details !== undefined && Object.keys(details).length > 32)
		) {
			console.warn("tsukaima: dropped plugin status with too many fields");
			return;
		}
		const status: PluginStatusSnapshot = {
			...parsed.data,
			updatedAt: new Date().toISOString(),
		};
		if (JSON.stringify(status).length > 8192) {
			console.warn("tsukaima: dropped oversized plugin status");
			return;
		}
		this.#status = status;
		this.#onStatus?.(status);
	}

	currentStatus(): PluginStatusSnapshot | null {
		return this.#status;
	}
}

export class LocalModelRegistry implements PluginModelRegistry {
	readonly #providers = new Map<string, PluginModelProvider>();

	registerProvider(provider: PluginModelProvider): () => void {
		if (provider.id.trim().length === 0) throw new Error("Model provider id must not be empty");
		this.#providers.set(provider.id, provider);
		return () => {
			this.#providers.delete(provider.id);
		};
	}

	getProvider(id: string): PluginModelProvider | undefined {
		return this.#providers.get(id);
	}

	listProviders(): readonly PluginModelProvider[] {
		return [...this.#providers.values()];
	}

	async listModels(query: PluginModelQuery = {}): Promise<readonly PluginModelInfo[]> {
		return collectPluginModels(this.#providers.values(), query);
	}

	async findModel(modelId: string, providerId?: string): Promise<PluginModelInfo | undefined> {
		const models = await this.listModels(providerId === undefined ? {} : { providerId });
		return models.find((model) => model.id === modelId);
	}

	async complete(request: PluginModelCompleteRequest): Promise<PluginModelCompleteResult> {
		return await completePluginModel(this.#providers, request);
	}

	async embed(request: PluginEmbeddingRequest): Promise<PluginEmbeddingResult> {
		const providers = this.#providersFor(request.modelId, "embedding");
		for (const provider of providers) {
			if (provider.embed !== undefined) return provider.embed(request);
			if (provider.embedding !== undefined) return provider.embedding.embed(request);
		}
		throw new Error(`No embedding-capable model provider for ${request.modelId ?? "default"}`);
	}

	async embedding(request: PluginEmbeddingRequest): Promise<PluginEmbeddingResult> {
		return await this.embed(request);
	}

	async transcribeAudio(
		request: PluginAudioTranscribeRequest,
	): Promise<PluginAudioTranscribeResult> {
		const providers = this.#providersFor(request.modelId, "audio.transcribe");
		for (const provider of providers) {
			if (provider.transcribeAudio !== undefined) return provider.transcribeAudio(request);
			if (provider.audioTranscribe !== undefined) {
				return provider.audioTranscribe.transcribeAudio(request);
			}
		}
		throw new Error(
			`No audio-transcribe-capable model provider for ${request.modelId ?? "default"}`,
		);
	}

	async audioTranscribe(
		request: PluginAudioTranscribeRequest,
	): Promise<PluginAudioTranscribeResult> {
		return await this.transcribeAudio(request);
	}

	#providersFor(modelId: string | undefined, capability: string): readonly PluginModelProvider[] {
		const providers = [...this.#providers.values()];
		if (modelId === undefined) return providers;
		return providers.filter((provider) => {
			const models = provider.listModels?.();
			if (models instanceof Promise) return true;
			return (
				models === undefined ||
				models.some((model) => model.id === modelId && model.capabilities.includes(capability))
			);
		});
	}
}

interface StructuralModelCollection {
	getModel?(providerId: string, modelId: string): unknown;
	getModels?(providerId: string): readonly unknown[];
	completeSimple?(
		model: unknown,
		context: {
			readonly messages: readonly unknown[];
			readonly systemPrompt?: string;
		},
		options?: {
			readonly maxTokens?: number;
			readonly signal?: AbortSignal;
			readonly temperature?: number;
		},
	): Promise<{
		readonly content?: readonly { readonly text?: string; readonly type?: string }[];
		readonly errorMessage?: string;
		readonly stopReason?: string;
	}>;
}

function messageText(content: PluginModelCompleteMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is Extract<PluginModelMessageContentPart, { readonly type: "text" }> => {
			return part.type === "text";
		})
		.map((part) => part.text)
		.join("");
}

function toPortMessages(
	messages: readonly PluginModelCompleteMessage[],
	providerId: string,
	modelId: string,
): { readonly messages: readonly unknown[]; readonly systemPrompt?: string } {
	const systemParts: string[] = [];
	const converted: unknown[] = [];
	const timestamp = Date.now();
	for (const message of messages) {
		if (message.role === "system") {
			const text = messageText(message.content).trim();
			if (text.length > 0) systemParts.push(text);
			continue;
		}
		if (message.role === "user") {
			converted.push({
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((part) =>
								part.type === "text"
									? { text: part.text, type: "text" as const }
									: { data: part.data, mimeType: part.mimeType, type: "image" as const },
							),
				role: "user" as const,
				timestamp,
			});
			continue;
		}
		converted.push({
			api: "openai-compatible",
			content: [{ text: messageText(message.content), type: "text" as const }],
			model: modelId,
			provider: providerId,
			role: "assistant" as const,
			stopReason: "stop",
			timestamp,
			usage: {
				cacheRead: 0,
				cacheWrite: 0,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
				input: 0,
				output: 0,
				totalTokens: 0,
			},
		});
	}
	const systemPrompt = systemParts.join("\n\n");
	return {
		messages: converted,
		...(systemPrompt.length > 0 ? { systemPrompt } : {}),
	};
}

async function resolveCompletionTarget(
	providers: ReadonlyMap<string, PluginModelProvider>,
	request: PluginModelCompleteRequest,
): Promise<{ readonly modelId?: string; readonly provider: PluginModelProvider }> {
	if (request.providerId !== undefined) {
		const provider = providers.get(request.providerId);
		if (provider === undefined) {
			throw new Error(`Model provider ${request.providerId} is not registered`);
		}
		if ((await provider.isConfigured?.()) === false) {
			throw new Error(`Model provider ${request.providerId} is not configured`);
		}
		if (provider.listModels !== undefined) {
			const descriptors = await provider.listModels();
			if (request.modelId !== undefined) {
				const matched = descriptors.find((descriptor) => descriptor.id === request.modelId);
				if (matched === undefined) {
					throw new Error(
						`Model ${request.modelId} is not enabled on provider ${request.providerId}`,
					);
				}
				return { modelId: matched.id, provider };
			}
			const matched =
				descriptors.find(
					(descriptor) =>
						(request.capability === undefined ||
							descriptor.capabilities.includes(request.capability)) &&
						(request.input === undefined || (descriptor.input?.includes(request.input) ?? false)),
				) ?? descriptors[0];
			if (matched === undefined) {
				throw new Error(`Provider ${request.providerId} has no enabled matching models`);
			}
			return { modelId: matched.id, provider };
		}
		return {
			...(request.modelId === undefined ? {} : { modelId: request.modelId }),
			provider,
		};
	}

	const configuredProviders: PluginModelProvider[] = [];
	for (const provider of providers.values()) {
		if ((await provider.isConfigured?.()) === false) continue;
		configuredProviders.push(provider);
	}

	if (request.modelId !== undefined) {
		const allModels = await collectPluginModels(configuredProviders);
		const matched = allModels.find((model) => model.id === request.modelId);
		if (matched !== undefined) {
			const provider = providers.get(matched.providerId);
			if (provider !== undefined) return { modelId: matched.id, provider };
		}
		const fallback = configuredProviders.find((provider) => provider.listModels === undefined);
		if (fallback !== undefined) {
			return { modelId: request.modelId, provider: fallback };
		}
		throw new Error(`Model ${request.modelId} is not available from any configured provider`);
	}

	const matchingModels = await collectPluginModels(configuredProviders, {
		...(request.capability === undefined ? {} : { capability: request.capability }),
		...(request.input === undefined ? {} : { input: request.input }),
	});
	const firstMatch = matchingModels[0];
	if (firstMatch !== undefined) {
		const provider = providers.get(firstMatch.providerId);
		if (provider !== undefined) return { modelId: firstMatch.id, provider };
	}
	const fallback = configuredProviders.find((provider) => provider.listModels === undefined);
	if (fallback !== undefined) return { provider: fallback };
	throw new Error("No matching model is configured");
}

/** Runs a text or multimodal completion through a registered model provider and model. */
export async function completePluginModel(
	providers: ReadonlyMap<string, PluginModelProvider>,
	request: PluginModelCompleteRequest,
	options: { readonly onMessage?: (message: unknown) => void } = {},
): Promise<PluginModelCompleteResult> {
	if (request.signal?.aborted === true) {
		throw new Error("Model request aborted");
	}
	const { modelId, provider } = await resolveCompletionTarget(providers, request);
	if (provider.complete !== undefined) {
		return await provider.complete({
			...request,
			...(modelId === undefined ? {} : { modelId }),
			providerId: provider.id,
		});
	}
	const port = await provider.createPort(
		options.onMessage === undefined ? {} : { onMessage: options.onMessage },
	);
	const models = port.models as StructuralModelCollection | undefined;
	const targetModelId = modelId ?? port.modelId;
	const selected =
		models?.getModel?.(port.providerId, targetModelId) ??
		(modelId === undefined ? models?.getModels?.(port.providerId)?.[0] : undefined);
	if (selected === undefined || typeof models?.completeSimple !== "function") {
		throw new Error(`Model ${targetModelId} is unavailable on provider ${provider.id}`);
	}
	const response = await models.completeSimple(
		selected,
		toPortMessages(request.messages, port.providerId, targetModelId),
		{
			...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
			...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
			...(request.signal === undefined ? {} : { signal: request.signal }),
			...(request.temperature === undefined ? {} : { temperature: request.temperature }),
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `Model request ${response.stopReason}`);
	}
	const text = (response.content ?? [])
		.filter(
			(part): part is { readonly text: string; readonly type: "text" } =>
				part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
	return {
		modelId: targetModelId,
		providerId: provider.id,
		text,
	};
}

/**
 * Builds a stable, secret-free catalog from provider descriptors. A broken provider must not
 * prevent unrelated models from being discovered by another plugin.
 */
export async function collectPluginModels(
	providers: Iterable<PluginModelProvider>,
	query: PluginModelQuery = {},
): Promise<readonly PluginModelInfo[]> {
	const models: PluginModelInfo[] = [];
	for (const provider of providers) {
		if (query.providerId !== undefined && provider.id !== query.providerId) continue;
		let descriptors: readonly PluginModelDescriptor[];
		try {
			descriptors = (await provider.listModels?.()) ?? [];
		} catch {
			continue;
		}
		const seen = new Set<string>();
		for (const descriptor of descriptors) {
			if (descriptor.id.trim().length === 0 || seen.has(descriptor.id)) continue;
			seen.add(descriptor.id);
			if (query.capability !== undefined && !descriptor.capabilities.includes(query.capability)) {
				continue;
			}
			if (query.input !== undefined && !descriptor.input?.includes(query.input)) continue;
			models.push({ ...descriptor, providerId: provider.id });
		}
	}
	return models;
}

export class LocalRpcBridge implements PluginRpcRegistry {
	readonly #handlers = new Map<string, PluginRpcHandler>();

	register(method: string, handler: PluginRpcHandler): () => void {
		const name = method.trim();
		if (!/^[a-z][a-zA-Z0-9._-]*$/u.test(name)) {
			throw new Error(`Invalid plugin RPC method: ${method}`);
		}
		this.#handlers.set(name, handler);
		return () => {
			this.#handlers.delete(name);
		};
	}

	list(): readonly { readonly method: string }[] {
		return [...this.#handlers.keys()].map((method) => ({ method }));
	}

	async invoke(method: string, input: unknown): Promise<unknown> {
		const handler = this.#handlers.get(method);
		if (handler === undefined) throw new Error(`Unknown plugin RPC method: ${method}`);
		return handler(input);
	}
}

class ToolSemaphore {
	readonly #limit: number;
	#active = 0;
	readonly #waiters: Array<{
		readonly reject: (error: Error) => void;
		readonly resolve: (release: () => void) => void;
	}> = [];

	constructor(limit: number) {
		this.#limit = Math.max(1, Math.floor(limit));
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.#active < this.#limit) {
			this.#active += 1;
			return this.#releaseOnce();
		}
		if (signal?.aborted === true) throw new Error("Tool invocation timed out while queued");
		return await new Promise<() => void>((resolve, reject) => {
			const waiter = { reject, resolve };
			this.#waiters.push(waiter);
			const onAbort = () => {
				const index = this.#waiters.indexOf(waiter);
				if (index !== -1) this.#waiters.splice(index, 1);
				reject(new Error("Tool invocation timed out while queued"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const originalResolve = waiter.resolve;
			waiter.resolve = (release) => {
				signal?.removeEventListener("abort", onAbort);
				originalResolve(release);
			};
		});
	}

	#releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			if (next === undefined) {
				this.#active -= 1;
				return;
			}
			next.resolve(this.#releaseOnce());
		};
	}
}

export const PLUGIN_TOOLS_EXTENSION_NAME = "tsukaima-plugin-tools";

/**
 * Legacy hash-suffixed provider-safe name (`<sanitized>_<8hex>`). Kept for backward
 * compatibility with persisted allowlists, transcripts, and collision disambiguation.
 */
export function legacyProviderSafeToolName(toolName: string): string {
	const suffix = `_${fnv1aHex(toolName)}`;
	const base = toolName.replace(/[^a-zA-Z0-9_-]/gu, "_") || "tool";
	return `${base.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * OpenAI-compatible providers only accept function names matching `^[a-zA-Z0-9_-]{1,64}$`.
 * Clean `<pluginId>.<tool>` names map directly to `<pluginId>_<tool>` without an opaque 8-char
 * hash suffix unless truncation (`> 64` chars), unusual characters, or explicit collision
 * disambiguation requires the deterministic hash suffix.
 */
export function providerSafeToolName(
	toolName: string,
	options?: { readonly disambiguate?: boolean },
): string {
	const base = toolName.replace(/[^a-zA-Z0-9_-]/gu, "_") || "tool";
	if (
		options?.disambiguate !== true &&
		base.length <= 64 &&
		/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/u.test(toolName)
	) {
		return base;
	}
	return legacyProviderSafeToolName(toolName);
}

export type ModelToolNameEntry =
	| string
	| {
			readonly name: string;
			/** Preferred short name; it wins over an automatically derived action name. */
			readonly shortName?: string;
			/** Explicit model-facing name. Alias for shortName. */
			readonly modelName?: string;
			/** Earlier or alternative model-facing names kept resolvable for this tool. */
			readonly aliases?: readonly string[];
			readonly canonicalName?: string;
	  };

/** Provider function names are `^[a-zA-Z0-9_-]{1,64}$`, shared by OpenAI-compatible APIs. */
const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

function modelToolEntryName(entry: ModelToolNameEntry): string {
	return typeof entry === "string" ? entry : entry.name;
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/gu, "_") || "tool";
}

/** A short name that fits the provider limit, or `undefined` when it needs truncation. */
function safeShortName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const candidate = safeName(value.trim());
	return MODEL_TOOL_NAME_PATTERN.test(candidate) ? candidate : undefined;
}

/** Last segment of a namespaced id, the natural model-facing shorthand. */
function derivedShortName(canonical: string): string | undefined {
	return safeShortName(canonical.slice(canonical.lastIndexOf(".") + 1));
}

/** All model-facing names that historically resolve to this canonical tool. */
export function providerToolNameAliases(entry: ModelToolNameEntry): readonly string[] {
	const canonical = modelToolEntryName(entry);
	const explicit =
		typeof entry === "string" ? [] : [entry.modelName, entry.shortName, ...(entry.aliases ?? [])];
	return [
		...new Set(
			[
				canonical,
				providerSafeToolName(canonical),
				legacyProviderSafeToolName(canonical),
				...explicit.flatMap((name) =>
					name === undefined || name.trim() === "" ? [] : [name.trim(), safeName(name.trim())],
				),
			].filter((name) => name.length > 0),
		),
	];
}

/**
 * Allocate one provider-safe model-facing name per canonical tool. Clean namespaced names
 * (`providerSafeToolName`) are used by default; an explicit `modelName` or `shortName` is honored
 * when deliberately set. Real collisions fall back to the legacy hash suffix. `reservedNames`
 * (built-in tools such as `tool_search`) and explicit aliases keep their stable names and force
 * fallback.
 *
 * Canonical names never change: they remain the routing, policy, audit, and authorization ids.
 */
export function allocateModelToolNames(
	entries: Iterable<ModelToolNameEntry>,
	options: { readonly reservedNames?: Iterable<string> } = {},
): Map<string, string> {
	const catalog = [...entries].map((entry) => {
		const canonical = modelToolEntryName(entry);
		const rawShort = typeof entry === "string" ? undefined : (entry.modelName ?? entry.shortName);
		const explicitShort = safeShortName(rawShort);
		return { canonical, explicitShort, entry };
	});
	const reserved = new Set<string>();
	for (const name of options.reservedNames ?? []) {
		const trimmed = name.trim();
		if (trimmed !== "") reserved.add(trimmed);
	}
	/** Explicit names belong to their canonical owner; another tool must not take them. */
	const owned = new Map<string, Set<string>>();
	const own = (name: string | undefined, canonical: string): void => {
		if (name === undefined || name === "") return;
		const owners = owned.get(name) ?? new Set<string>();
		owners.add(canonical);
		owned.set(name, owners);
	};
	for (const { canonical, explicitShort, entry } of catalog) {
		own(explicitShort, canonical);
		for (const alias of providerToolNameAliases(entry)) own(alias, canonical);
	}
	const assigned = new Map<string, string>();
	const claimed = new Set<string>();
	const blocked = (name: string, claimants: ReadonlySet<string>): boolean => {
		if (reserved.has(name) || claimed.has(name)) return true;
		const owners = owned.get(name);
		if (owners === undefined) return false;
		for (const owner of owners) if (!claimants.has(owner)) return true;
		return false;
	};
	const remaining = catalog.filter((entry) => entry.canonical.length > 0);
	const assignRound = (
		candidateFor: (entry: (typeof catalog)[number]) => string | undefined,
		priorityFor: (entry: (typeof catalog)[number]) => number = () => 0,
	): void => {
		const groups = new Map<
			string,
			{ readonly priority: number; readonly entries: (typeof catalog)[number][] }
		>();
		for (const entry of remaining) {
			if (assigned.has(entry.canonical)) continue;
			const candidate = candidateFor(entry);
			if (candidate === undefined) continue;
			const group = groups.get(candidate) ?? { entries: [], priority: Number.POSITIVE_INFINITY };
			group.entries.push(entry);
			groups.set(candidate, {
				entries: group.entries,
				priority: Math.min(group.priority, priorityFor(entry)),
			});
		}
		for (const [candidate, group] of groups) {
			const winners = group.entries.filter((entry) => priorityFor(entry) === group.priority);
			if (winners.length !== 1) continue;
			const winner = winners[0]!;
			if (blocked(candidate, new Set(group.entries.map((entry) => entry.canonical)))) continue;
			assigned.set(winner.canonical, candidate);
			claimed.add(candidate);
		}
	};
	assignRound(
		(entry) => entry.explicitShort,
		() => 0,
	);
	assignRound(
		(entry) => providerSafeToolName(entry.canonical),
		() => 1,
	);
	assignRound(
		(entry) => legacyProviderSafeToolName(entry.canonical),
		() => 2,
	);
	// Only a 32-bit hash collision between distinct names can reach this round. Salt the hash
	// until a free name exists rather than failing the whole extension install.
	for (let salt = 2; remaining.some((entry) => !assigned.has(entry.canonical)); salt += 1) {
		assignRound(
			(entry) => legacyProviderSafeToolName(`${entry.canonical}#${salt}`),
			() => 3,
		);
	}
	return assigned;
}

/**
 * Known built-in plugin prefixes. A provider-safe name replaces `.` with `_`, so without a
 * tool catalog a multi-word plugin id (`onebot-napcat_send`) is ambiguous with a tool id that
 * itself contains underscores. Matching known prefixes first keeps the static fallback stable
 * for the built-in tool families while still supporting arbitrary third-party names below.
 */
const STATIC_TOOL_PREFIXES = [
	"proactive-scheduler",
	"openai-compatible",
	"onebot-napcat",
	"sticker-meme",
	"memory",
] as const;

/**
 * Resolve a canonical tool name (`onebot-napcat.send`), clean provider-safe name
 * (`onebot-napcat_send`), double-underscore alias (`onebot_napcat__send`), or legacy
 * hash-suffixed name (`onebot-napcat_send_9fa1ce39`) back to the canonical tool name.
 */
export function resolveToolName(
	name: string,
	tools?: Iterable<ModelToolNameEntry>,
): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0) return undefined;
	if (tools !== undefined) {
		const catalog = [...tools];
		const allocated = allocateModelToolNames(catalog);
		for (const entry of catalog) {
			const canonical = typeof entry === "string" ? entry : entry.name;
			if (canonical === trimmed || allocated.get(canonical) === trimmed) {
				return canonical;
			}
		}
		const matches = new Set<string>();
		for (const entry of catalog) {
			const canonical = typeof entry === "string" ? entry : entry.name;
			if (
				providerToolNameAliases(entry).includes(trimmed) ||
				providerSafeToolName(canonical) === trimmed ||
				legacyProviderSafeToolName(canonical) === trimmed ||
				derivedShortName(canonical) === trimmed ||
				canonical.replace(/\./gu, "__").replace(/-/gu, "_") ===
					trimmed.replace(/\./gu, "__").replace(/-/gu, "_")
			) {
				matches.add(canonical);
			}
		}
		// A historical short name is only safe to resolve while exactly one tool answers to it.
		return matches.size === 1 ? [...matches][0] : undefined;
	}
	const strippedLegacy = trimmed.replace(/_[0-9a-f]{8}$/u, "");
	if (strippedLegacy.includes(".")) return strippedLegacy;
	for (const prefix of STATIC_TOOL_PREFIXES) {
		const variants = [prefix, prefix.replace(/-/gu, "_")];
		for (const variant of variants) {
			for (const delimiter of ["__", "_"]) {
				if (!strippedLegacy.startsWith(`${variant}${delimiter}`)) continue;
				const tool = strippedLegacy.slice(variant.length + delimiter.length);
				if (tool.length > 0) return `${prefix}.${tool}`;
			}
		}
	}
	if (strippedLegacy.includes("__")) {
		const [prefix, ...rest] = strippedLegacy.split("__");
		if (prefix && rest.length > 0) return `${prefix.replace(/_/gu, "-")}.${rest.join("_")}`;
	}
	const underscoreIndex = strippedLegacy.indexOf("_");
	if (underscoreIndex > 0 && !strippedLegacy.includes(".")) {
		return `${strippedLegacy.slice(0, underscoreIndex)}.${strippedLegacy.slice(underscoreIndex + 1)}`;
	}
	return strippedLegacy;
}

function fnv1aHex(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface PluginToolsExtensionOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	/** Called only when auditing or a duplicate name fails; never affects the tool result. */
	readonly logger?: (message: string, error?: unknown) => void;
	/** Verbose per-invocation diagnostics (start, finish, denial). Failures are swallowed. */
	readonly debug?: (message: string, fields?: Record<string, unknown>) => void;
	/** Trace-level per-invocation diagnostics. Failures are swallowed. */
	readonly trace?: (message: string, fields?: Record<string, unknown>) => void;
	readonly name?: string;
	/** Additional policy context or a resolver invoked per tool execution. */
	readonly policyContext?:
		| ToolPolicyAccessContext
		| ((
				tool: PluginTool,
				context: ToolInvocationContext,
		  ) => ToolPolicyAccessContext | Promise<ToolPolicyAccessContext>);
	/** Model-visibility filter; defaults to the tool policy's `visibility === "model"`. */
	readonly filter?: (tool: PluginTool) => boolean;
	/**
	 * Built-in model tool names that plugin shorthands must not shadow. The server passes the
	 * prompt, workspace, schedule, coding, and `tool_search` names; standalone embedders may omit it.
	 */
	readonly reservedNames?: readonly string[] | (() => readonly string[]);
}

type PluginToolSource = () => readonly PluginTool[];
type PluginToolInvoker = (
	name: string,
	input: Record<string, unknown>,
	context?: ToolInvocationContext,
) => Promise<PluginToolInvocationResult>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function textOutput(text: string): { readonly type: "text"; readonly text: string }[] {
	return [{ text, type: "text" }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAbortSignal(value: unknown): AbortSignal | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value.abortSignal;
	if (typeof candidate !== "object" || candidate === null) return undefined;
	if (
		"aborted" in candidate &&
		typeof candidate.aborted === "boolean" &&
		"addEventListener" in candidate &&
		typeof candidate.addEventListener === "function" &&
		"removeEventListener" in candidate &&
		typeof candidate.removeEventListener === "function"
	) {
		return candidate as AbortSignal;
	}
	return undefined;
}

function warn(
	logger: PluginToolsExtensionOptions["logger"],
	message: string,
	error?: unknown,
): void {
	try {
		logger?.(message, error);
	} catch {}
}

function toolLog(
	logger: PluginToolsExtensionOptions["debug"],
	message: string,
	fields: Record<string, unknown>,
): void {
	try {
		logger?.(message, fields);
	} catch {}
}

/**
 * Adapts the plugin tool registry to one pi-durable extension. The tool list is read
 * lazily on every resolution, so a plugin that registers or removes a tool while the
 * process runs is reflected on the next model request without reinstalling the extension.
 */
export function createPluginToolsExtension(
	source: PluginToolSource,
	invoke: PluginToolInvoker,
	options: PluginToolsExtensionOptions = {},
): PluginToolsExtension {
	const registrations = new Map<
		string,
		{
			readonly modelName: string;
			readonly tool: PluginTool;
			readonly registration: PluginToolRegistration;
		}
	>();

	const audit = async (entry: AuditEntry): Promise<void> => {
		if (options.audit === undefined) return;
		try {
			await options.audit(entry);
		} catch (error) {
			warn(options.logger, "plugin tool audit failed", error);
		}
	};

	const semaphores = new Map<string, ToolSemaphore>();
	const semaphoreFor = (tool: PluginTool): ToolSemaphore => {
		const policy = resolveToolPolicy(tool);
		const key = `${tool.name}:${policy.maxConcurrent}`;
		const existing = semaphores.get(key);
		if (existing !== undefined) return existing;
		const created = new ToolSemaphore(policy.maxConcurrent);
		semaphores.set(key, created);
		return created;
	};

	const policyContextFor = async (
		tool: PluginTool,
		context: ToolInvocationContext,
	): Promise<ToolPolicyAccessContext> =>
		typeof options.policyContext === "function"
			? options.policyContext(tool, context)
			: (options.policyContext ?? {});

	const registrationFor = (
		tool: PluginTool,
		modelName: string,
		aliases: readonly string[],
	): PluginToolRegistration => {
		const existing = registrations.get(tool.name);
		if (
			existing?.tool === tool &&
			existing.modelName === modelName &&
			existing.registration.aliases?.join("\0") === aliases.join("\0")
		) {
			return existing.registration;
		}
		const resolvedPolicy = resolveToolPolicy(tool);
		const registration: PluginToolRegistration = {
			description: tool.description,
			...(resolvedPolicy.lazy ? { deferred: true as const } : {}),
			surface: resolvedPolicy.surface ?? "both",
			async execute(args, api, toolContext) {
				const input = isRecord(args) ? args : {};
				const conversationId = String(api.conversationId);
				const callerSignal = readAbortSignal(toolContext);
				const invocationContext: ToolInvocationContext = { conversationId };
				const startedAtMs = Date.now();
				const logDenied = (reason: string): void => {
					toolLog(options.debug, "plugin tool invocation denied", {
						conversationId,
						durationMs: Date.now() - startedAtMs,
						ok: false,
						reason,
						tool: tool.name,
					});
				};
				toolLog(options.trace, "plugin tool invocation started", {
					conversationId,
					inputKeys: Object.keys(input),
					tool: tool.name,
				});
				const policy = resolveToolPolicy(tool);
				const resolvedPolicyContext = await policyContextFor(tool, invocationContext);
				const mergedCapabilities =
					resolvedPolicyContext.channelCapabilities !== undefined ||
					resolvedPolicyContext.conversationCapabilities !== undefined ||
					invocationContext.conversationCapabilities !== undefined
						? [
								...new Set([
									...(invocationContext.conversationCapabilities ?? []),
									...(resolvedPolicyContext.channelCapabilities ?? []),
									...(resolvedPolicyContext.conversationCapabilities ?? []),
								]),
							]
						: undefined;
				const mergedAllowedTools =
					resolvedPolicyContext.allowedTools ??
					resolvedPolicyContext.conversationAllowedTools ??
					invocationContext.allowedTools;
				const effectiveInvocationContext: ToolInvocationContext = {
					...invocationContext,
					...(resolvedPolicyContext.platformConversationId === undefined
						? {}
						: { platformConversationId: resolvedPolicyContext.platformConversationId }),
					...(resolvedPolicyContext.chatKind === undefined
						? {}
						: { chatKind: resolvedPolicyContext.chatKind }),
					...(resolvedPolicyContext.channelId === undefined
						? {}
						: { channelId: resolvedPolicyContext.channelId }),
					...(resolvedPolicyContext.senderPlatformId === undefined
						? {}
						: { senderPlatformId: resolvedPolicyContext.senderPlatformId }),
					...(resolvedPolicyContext.userId === undefined
						? {}
						: { userId: resolvedPolicyContext.userId }),
					...(resolvedPolicyContext.isAdmin === undefined
						? {}
						: { isAdmin: resolvedPolicyContext.isAdmin }),
					...(resolvedPolicyContext.role === undefined ? {} : { role: resolvedPolicyContext.role }),
					...(resolvedPolicyContext.taskKind === undefined
						? {}
						: { taskKind: resolvedPolicyContext.taskKind }),
					...(mergedAllowedTools === undefined ? {} : { allowedTools: mergedAllowedTools }),
					...(mergedCapabilities === undefined
						? {}
						: { conversationCapabilities: mergedCapabilities }),
				};
				const decision = resolveToolPolicyAccess(tool, {
					...effectiveInvocationContext,
					...resolvedPolicyContext,
				});
				if (!decision.allowed) {
					logDenied(decision.reason ?? "denied");
					await audit({
						action: "plugin.tool.invoke",
						payload: { conversationId, tool: tool.name },
						reason: decision.reason ?? "denied",
						result: "denied",
						targetId: tool.name,
						targetKind: "plugin-tool",
					});
					return {
						isError: true,
						output: textOutput(
							`Tool ${tool.name} is not available: ${decision.reason ?? "denied"}`,
						),
					};
				}
				if (toolPayloadTooLarge(tool, input)) {
					logDenied(`payload_too_large:${policy.maxPayloadBytes}`);
					await audit({
						action: "plugin.tool.invoke",
						payload: { conversationId, tool: tool.name },
						reason: `payload_too_large:${policy.maxPayloadBytes}`,
						result: "denied",
						targetId: tool.name,
						targetKind: "plugin-tool",
					});
					return {
						isError: true,
						output: textOutput(`Tool ${tool.name} input exceeds ${policy.maxPayloadBytes} bytes`),
					};
				}
				const semaphore = semaphoreFor(tool);
				const controller = new AbortController();
				let timedOut = false;
				let callerAborted = false;
				const onCallerAbort = (): void => {
					callerAborted = true;
					controller.abort(callerSignal?.reason);
				};
				if (callerSignal !== undefined) {
					if (callerSignal.aborted) {
						onCallerAbort();
					} else {
						callerSignal.addEventListener("abort", onCallerAbort, { once: true });
					}
				}
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, policy.timeoutMs);
				let release: (() => void) | undefined;
				try {
					release = await semaphore.acquire(controller.signal);
					if (timedOut) throw new Error(`Tool ${tool.name} timed out after ${policy.timeoutMs}ms`);
					if (callerAborted) throw new Error(`Tool ${tool.name} aborted`);
					const toolAbortError = (): Error =>
						timedOut
							? new Error(`Tool ${tool.name} timed out after ${policy.timeoutMs}ms`)
							: new Error(`Tool ${tool.name} aborted`);
					const execution = Promise.resolve().then(() =>
						invoke(tool.name, input, {
							...effectiveInvocationContext,
							signal: controller.signal,
						}),
					);
					const timeout = new Promise<never>((_resolve, reject) => {
						if (controller.signal.aborted) {
							reject(toolAbortError());
							return;
						}
						controller.signal.addEventListener("abort", () => reject(toolAbortError()), {
							once: true,
						});
					});
					void execution.catch(() => undefined);
					const outcome = await Promise.race([execution, timeout]);
					if (!outcome.ok) {
						if (outcome.reason === "permission_denied") {
							logDenied(`permission_denied:${outcome.permission}`);
							await audit({
								action: "plugin.tool.invoke",
								payload: { conversationId, tool: tool.name },
								reason: `permission_denied:${outcome.permission}`,
								result: "denied",
								targetId: tool.name,
								targetKind: "plugin-tool",
							});
							return {
								isError: true,
								output: textOutput(
									`Permission denied for tool ${tool.name}: ${outcome.permission}`,
								),
							};
						}
						const reason = `${outcome.reason}${outcome.message === undefined ? "" : `:${outcome.message}`}`;
						logDenied(reason);
						await audit({
							action: "plugin.tool.invoke",
							payload: { conversationId, tool: tool.name },
							reason,
							result: "denied",
							targetId: tool.name,
							targetKind: "plugin-tool",
						});
						return {
							isError: true,
							output: textOutput(
								`Tool ${tool.name} is not available: ${outcome.message ?? outcome.reason}`,
							),
						};
					}
					await audit({
						action: "plugin.tool.invoke",
						payload: { conversationId, tool: tool.name },
						result: "ok",
						targetId: tool.name,
						targetKind: "plugin-tool",
					});
					toolLog(options.debug, "plugin tool invocation finished", {
						conversationId,
						durationMs: Date.now() - startedAtMs,
						ok: true,
						tool: tool.name,
					});
					return {
						output: [
							...outcome.result.content.map((part) => ({
								text: part.text,
								type: "text" as const,
							})),
							...(outcome.result.images ?? []).map((image) => ({
								data: image.data,
								mimeType: image.mimeType,
								type: "image" as const,
							})),
						],
					};
				} catch (error) {
					const message = errorText(error);
					const reason = timedOut ? `timeout:${policy.timeoutMs}` : message;
					toolLog(
						options.debug,
						timedOut ? "plugin tool invocation timed out" : "plugin tool invocation failed",
						{
							conversationId,
							durationMs: Date.now() - startedAtMs,
							ok: false,
							reason,
							tool: tool.name,
						},
					);
					await audit({
						action: "plugin.tool.invoke",
						payload: { conversationId, tool: tool.name },
						reason,
						result: "failed",
						targetId: tool.name,
						targetKind: "plugin-tool",
					});
					return {
						isError: true,
						output: textOutput(`Tool ${tool.name} failed: ${message}`),
					};
				} finally {
					clearTimeout(timer);
					callerSignal?.removeEventListener("abort", onCallerAbort);
					release?.();
				}
			},
			name: modelName,
			parameters: tool.parameters,
			canonicalName: tool.name,
			aliases,
		};
		registrations.set(tool.name, { modelName, registration, tool });
		return registration;
	};

	const extension: PluginToolsExtension = {
		name: options.name ?? PLUGIN_TOOLS_EXTENSION_NAME,
		get tools() {
			let current: readonly PluginTool[];
			try {
				current = source();
			} catch (error) {
				warn(options.logger, "plugin tool listing failed", error);
				return [];
			}
			const names = new Set<string>();
			const filtered: PluginTool[] = [];
			for (const tool of current) {
				if (names.has(tool.name)) {
					warn(options.logger, `duplicate plugin tool name ${tool.name}`);
					continue;
				}
				if (!(options.filter?.(tool) ?? resolveToolPolicy(tool).visibility === "model")) {
					continue;
				}
				names.add(tool.name);
				filtered.push(tool);
			}
			const reservedNames =
				typeof options.reservedNames === "function"
					? options.reservedNames()
					: (options.reservedNames ?? []);
			const allocated = allocateModelToolNames(filtered, { reservedNames });
			const canonicalNames = new Set(filtered.map((tool) => tool.name));
			const reserved = new Set(reservedNames);
			const claims = new Map<string, Set<string>>();
			for (const tool of filtered) {
				for (const alias of providerToolNameAliases(tool)) {
					const owners = claims.get(alias) ?? new Set<string>();
					owners.add(tool.name);
					claims.set(alias, owners);
				}
			}
			const tools = filtered.map((tool) => {
				const modelName = allocated.get(tool.name) ?? providerSafeToolName(tool.name);
				const aliases = providerToolNameAliases(tool).filter(
					(alias) =>
						alias === tool.name ||
						(!reserved.has(alias) && !canonicalNames.has(alias) && claims.get(alias)?.size === 1),
				);
				return registrationFor(tool, modelName, aliases);
			});
			for (const name of registrations.keys()) {
				if (!names.has(name)) registrations.delete(name);
			}
			return tools;
		},
	};
	return extension;
}

export class LocalStorageBridge implements PluginStorage {
	readonly #global = new Map<string, unknown>();
	readonly #conversation = new Map<string, Map<string, unknown>>();

	readonly conversation = {
		get: async <T>(conversationId: string, key: string): Promise<T | undefined> =>
			this.#conversation.get(conversationId)?.get(key) as T | undefined,
		set: async (conversationId: string, key: string, value: unknown): Promise<void> => {
			const values = this.#conversation.get(conversationId) ?? new Map();
			values.set(key, value);
			this.#conversation.set(conversationId, values);
		},
	};

	readonly global = {
		get: async <T>(key: string): Promise<T | undefined> => this.#global.get(key) as T | undefined,
		set: async (key: string, value: unknown): Promise<void> => {
			this.#global.set(key, value);
		},
	};
}

/**
 * In-memory plugin cache used by unit tests and embedders. The production host substitutes a
 * KV-backed bridge with the same shape, so plugin code does not change when it runs for real.
 */
export class LocalCacheBridge implements PluginCacheApi {
	readonly #entries = new Map<string, { expiresAt?: number; value: unknown }>();
	readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

	async get<T = unknown>(key: string): Promise<T | undefined> {
		const entry = this.#entries.get(key);
		if (entry === undefined) return undefined;
		if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry.value as T;
	}

	async set(key: string, value: unknown, options: PluginCacheSetOptions = {}): Promise<void> {
		this.#entries.set(
			key,
			options.ttlMs === undefined || options.ttlMs <= 0
				? { value }
				: { expiresAt: Date.now() + options.ttlMs, value },
		);
	}

	async delete(key: string): Promise<boolean> {
		return this.#entries.delete(key);
	}

	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== undefined;
	}

	async getOrSet<T = unknown>(
		key: string,
		factory: () => Promise<T> | T,
		options?: PluginCacheSetOptions,
	): Promise<T> {
		const existing = await this.get<T>(key);
		if (existing !== undefined) return existing;
		const value = await factory();
		await this.set(key, value, options);
		return value;
	}

	async publish(channel: string, payload: unknown): Promise<void> {
		for (const handler of this.#listeners.get(channel) ?? []) handler(payload);
	}

	subscribe(channel: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.#listeners.get(channel) ?? new Set();
		handlers.add(handler);
		this.#listeners.set(channel, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#listeners.delete(channel);
		};
	}
}

export class LocalConfigBridge implements PluginConfig {
	readonly #values: Map<string, unknown>;

	constructor(values: Record<string, unknown>) {
		this.#values = new Map(Object.entries(values));
	}

	async get<T>(key: string): Promise<T | undefined> {
		return this.#values.get(key) as T | undefined;
	}

	has(key: string): boolean {
		return this.#values.has(key);
	}
}

export interface PluginContextOptions {
	pluginId?: string;
	manifest?: PluginContext["manifest"];
	grantedPermissions?: readonly string[];
	config?: Record<string, unknown>;
	logger?: PluginLogger;
	storage?: PluginStorage;
	cache?: PluginCacheApi;
	conversation?: {
		read(): Promise<readonly MessageEnvelope[]>;
	};
	conversations?: PluginConversationsApi;
	followUps?: PluginFollowUpsApi;
	schedules?: PluginSchedulesApi;
	channel?: PluginChannelApi;
	channels?: PluginChannelRegistry;
	outbound?: PluginOutboundApi;
	events?: PluginEvents;
	media?: PluginMediaApi;
	models?: PluginModelRegistry;
	rpc?: PluginRpcRegistry;
	settings?: PluginSettingsApi;
	requests?: PluginRequestApi;
	audit?: PluginAuditApi;
	tasks?: PluginTasksApi;
	migrations?: PluginMigrationsApi;
	database?: PluginDatabaseApi;
	dependencies?: PluginDependencyBag;
	onStatus?: (status: PluginStatusSnapshot | null) => void;
}

export function createPluginContext(options: PluginContextOptions = {}): PluginContext {
	const storage = options.storage ?? new LocalStorageBridge();
	const logger =
		options.logger === undefined
			? createConsolePluginLogger()
			: normalizePluginLogger(options.logger);
	const events = options.events ?? new LocalPluginEventBridge();
	const pluginId = options.pluginId ?? "plugin";
	const manifest =
		options.manifest ??
		pluginManifestSchema.parse({
			apiVersion: "1",
			kind: "builtin",
			name: pluginId,
			version: "0.0.0",
		});
	const granted = options.grantedPermissions ?? manifest.permissions;
	const cache =
		options.cache ??
		(granted.some(
			(permission) =>
				permission === "*" || permission === "cache" || permission.startsWith("cache."),
		)
			? new LocalCacheBridge()
			: undefined);
	const tools = new LocalToolBridge(
		pluginId,
		options.grantedPermissions ?? manifest.permissions,
		manifest.tools,
	);
	const ui = new LocalUiBridge({
		grantedPermissions: options.grantedPermissions ?? manifest.permissions,
		pluginId,
		...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
	});
	const models = options.models ?? new LocalModelRegistry();
	const rpc = options.rpc ?? new LocalRpcBridge();
	const tasks =
		options.tasks ??
		new LocalTaskBridge({
			grantedPermissions: options.grantedPermissions ?? manifest.permissions,
			pluginId,
		});
	return {
		pluginId,
		manifest,
		config: new LocalConfigBridge(options.config ?? {}),
		logger,
		storage,
		...(cache === undefined ? {} : { cache }),
		conversation: options.conversation ?? { read: async () => [] },
		...(options.conversations ? { conversations: options.conversations } : {}),
		...(options.followUps ? { followUps: options.followUps } : {}),
		...(options.schedules ? { schedules: options.schedules } : {}),
		events,
		...(options.media ? { media: options.media } : {}),
		tools,
		ui,
		models,
		rpc,
		...(options.channel ? { channel: options.channel } : {}),
		...(options.channels ? { channels: options.channels } : {}),
		...(options.outbound ? { outbound: options.outbound } : {}),
		...(options.settings ? { settings: options.settings } : {}),
		...(options.requests ? { requests: options.requests } : {}),
		...(options.audit ? { audit: options.audit } : {}),
		tasks,
		...(options.migrations ? { migrations: options.migrations } : {}),
		...(options.database ? { database: options.database } : {}),
		...(options.dependencies ? { dependencies: options.dependencies } : {}),
	};
}
