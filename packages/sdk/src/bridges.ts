import { assertPermission, hasPermission, type PluginPermission } from "./permissions.ts";
import { pluginManifestSchema } from "./manifest.ts";
import type {
	AuditEntry,
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginRequestApi,
	PluginSettingsApi,
} from "./host.ts";
import type { MessageEnvelope } from "@elaina/contracts";
import type {
	PluginChannelApi,
	PluginConfig,
	PluginContext,
	PluginEvents,
	PluginHookName,
	PluginLogger,
	PluginModelDescriptor,
	PluginModelInfo,
	PluginModelProvider,
	PluginModelQuery,
	PluginModelRegistry,
	PluginRpcHandler,
	PluginRpcRegistry,
	PluginStorage,
	PluginTool,
	PluginToolInvocationResult,
	PluginToolRegistration,
	PluginToolsExtension,
	PluginUiDefinition,
	ToolInvocationContext,
	ToolResult,
} from "./types.ts";
import { pluginStatusInputSchema } from "@elaina/contracts";
import type { PluginStatusSnapshot } from "@elaina/contracts";

export class LocalPluginEventBridge {
	readonly #handlers = new Map<PluginHookName, Set<(payload: unknown) => Promise<void> | void>>();

	on(name: PluginHookName, handler: (payload: unknown) => Promise<void> | void): () => void {
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
}

export class LocalToolBridge {
	readonly #tools = new Map<string, PluginTool>();
	readonly #pluginId: string;
	readonly #grantedPermissions: readonly string[];

	constructor(pluginId: string, grantedPermissions: readonly string[]) {
		this.#pluginId = pluginId;
		this.#grantedPermissions = grantedPermissions;
	}

	register(tool: PluginTool): void {
		const namespace = `${this.#pluginId}.`;
		if (!tool.name.startsWith(namespace) || tool.name === namespace) {
			throw new Error(`Tool ${tool.name} must be namespaced as ${namespace}<name>`);
		}
		for (const permission of tool.requiredPermissions) {
			assertPermission(this.#grantedPermissions, permission, this.#pluginId);
		}
		this.#tools.set(tool.name, tool);
	}

	list(): readonly PluginTool[] {
		return [...this.#tools.values()];
	}

	async invoke(
		name: string,
		input: Record<string, unknown>,
		context: ToolInvocationContext = {},
	): Promise<
		| { ok: true; result: ToolResult }
		| { ok: false; reason: "permission_denied"; permission: PluginPermission }
	> {
		const tool = this.#tools.get(name);
		if (!tool) {
			throw new Error(`Unknown tool ${name}`);
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
		this.#definitions.set(definition.id, definition);
	}

	list(): readonly PluginUiDefinition[] {
		return [...this.#definitions.values()];
	}

	setStatus(input: unknown): void {
		if (!hasPermission(this.#grantedPermissions, "ui.panel")) {
			console.warn(
				`elaina: plugin ${this.#pluginId} is not granted permission ui.panel; status dropped`,
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
			console.warn("elaina: dropped invalid plugin status", parsed.error.message);
			return;
		}
		const metrics = parsed.data.metrics;
		const details = parsed.data.details;
		if (
			(metrics !== undefined && Object.keys(metrics).length > 32) ||
			(details !== undefined && Object.keys(details).length > 32)
		) {
			console.warn("elaina: dropped plugin status with too many fields");
			return;
		}
		const status: PluginStatusSnapshot = {
			...parsed.data,
			updatedAt: new Date().toISOString(),
		};
		if (JSON.stringify(status).length > 8192) {
			console.warn("elaina: dropped oversized plugin status");
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

export const PLUGIN_TOOLS_EXTENSION_NAME = "elaina-plugin-tools";

/**
 * OpenAI-compatible providers only accept function names matching `^[a-zA-Z0-9_-]{1,64}$`.
 * Plugin tools are namespaced `<pluginId>.<tool>`, so the model-facing name is sanitized and
 * suffixed with a short deterministic hash. The extension still invokes the original name, so
 * plugin routing, permission checks, and audit records are unchanged.
 */
export function providerSafeToolName(toolName: string): string {
	const suffix = `_${fnv1aHex(toolName)}`;
	const base = toolName.replace(/[^a-zA-Z0-9_-]/gu, "_") || "tool";
	return `${base.slice(0, 64 - suffix.length)}${suffix}`;
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
	readonly name?: string;
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

function warn(
	logger: PluginToolsExtensionOptions["logger"],
	message: string,
	error?: unknown,
): void {
	try {
		logger?.(message, error);
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
		{ readonly tool: PluginTool; readonly registration: PluginToolRegistration }
	>();

	const audit = async (entry: AuditEntry): Promise<void> => {
		if (options.audit === undefined) return;
		try {
			await options.audit(entry);
		} catch (error) {
			warn(options.logger, "plugin tool audit failed", error);
		}
	};

	const registrationFor = (tool: PluginTool): PluginToolRegistration => {
		const existing = registrations.get(tool.name);
		if (existing?.tool === tool) return existing.registration;
		const registration: PluginToolRegistration = {
			description: tool.description,
			async execute(args, api) {
				const input = isRecord(args) ? args : {};
				const conversationId = String(api.conversationId);
				const invocationContext: ToolInvocationContext = { conversationId };
				try {
					const outcome = await invoke(tool.name, input, invocationContext);
					if (!outcome.ok) {
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
							output: textOutput(`Permission denied for tool ${tool.name}: ${outcome.permission}`),
						};
					}
					await audit({
						action: "plugin.tool.invoke",
						payload: { conversationId, tool: tool.name },
						result: "ok",
						targetId: tool.name,
						targetKind: "plugin-tool",
					});
					return {
						output: outcome.result.content.map((part) => ({ text: part.text, type: "text" })),
					};
				} catch (error) {
					const message = errorText(error);
					await audit({
						action: "plugin.tool.invoke",
						payload: { conversationId, tool: tool.name },
						reason: message,
						result: "failed",
						targetId: tool.name,
						targetKind: "plugin-tool",
					});
					return {
						isError: true,
						output: textOutput(`Tool ${tool.name} failed: ${message}`),
					};
				}
			},
			name: providerSafeToolName(tool.name),
			parameters: tool.parameters,
		};
		registrations.set(tool.name, { registration, tool });
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
			const tools: PluginToolRegistration[] = [];
			for (const tool of current) {
				if (names.has(tool.name)) {
					warn(options.logger, `duplicate plugin tool name ${tool.name}`);
					continue;
				}
				names.add(tool.name);
				tools.push(registrationFor(tool));
			}
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
	conversation?: {
		read(): Promise<readonly MessageEnvelope[]>;
	};
	channel?: PluginChannelApi;
	channels?: PluginChannelRegistry;
	events?: PluginEvents;
	models?: PluginModelRegistry;
	rpc?: PluginRpcRegistry;
	settings?: PluginSettingsApi;
	requests?: PluginRequestApi;
	audit?: PluginAuditApi;
	dependencies?: PluginDependencyBag;
	onStatus?: (status: PluginStatusSnapshot | null) => void;
}

export function createPluginContext(options: PluginContextOptions = {}): PluginContext {
	const storage = options.storage ?? new LocalStorageBridge();
	const logger = options.logger ?? console;
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
	const tools = new LocalToolBridge(pluginId, options.grantedPermissions ?? manifest.permissions);
	const ui = new LocalUiBridge({
		grantedPermissions: options.grantedPermissions ?? manifest.permissions,
		pluginId,
		...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
	});
	const models = options.models ?? new LocalModelRegistry();
	const rpc = options.rpc ?? new LocalRpcBridge();
	return {
		pluginId,
		manifest,
		config: new LocalConfigBridge(options.config ?? {}),
		logger,
		storage,
		conversation: options.conversation ?? { read: async () => [] },
		events,
		tools,
		ui,
		models,
		rpc,
		...(options.channel ? { channel: options.channel } : {}),
		...(options.channels ? { channels: options.channels } : {}),
		...(options.settings ? { settings: options.settings } : {}),
		...(options.requests ? { requests: options.requests } : {}),
		...(options.audit ? { audit: options.audit } : {}),
		...(options.dependencies ? { dependencies: options.dependencies } : {}),
	};
}
