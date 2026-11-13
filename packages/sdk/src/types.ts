import type { MessageEnvelope, MessagePart } from "@tsukaima/contracts";
import type {
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginRequestApi,
	PluginSettingsApi,
} from "./host.ts";
import type { PluginManifest } from "./manifest.ts";
import type { PluginPermission } from "./permissions.ts";

export interface PluginLogger {
	debug(message: string, details?: unknown): void;
	info(message: string, details?: unknown): void;
	warn(message: string, details?: unknown): void;
	error(message: string, details?: unknown): void;
}

export type SerializedValue = unknown;

export interface PluginStorage {
	conversation: {
		get<T = SerializedValue>(conversationId: string, key: string): Promise<T | undefined>;
		set(conversationId: string, key: string, value: SerializedValue): Promise<void>;
	};
	global: {
		get<T = SerializedValue>(key: string): Promise<T | undefined>;
		set(key: string, value: SerializedValue): Promise<void>;
	};
}

export interface PluginConfig {
	get<T = SerializedValue>(key: string): Promise<T | undefined>;
}

export interface PluginEvents {
	emit(name: PluginHookName, payload: unknown): Promise<void>;
	on(name: PluginHookName, handler: (payload: unknown) => Promise<void> | void): () => void;
}

export interface PluginToolRegistry {
	invoke(
		name: string,
		input: Record<string, unknown>,
		context?: ToolInvocationContext,
	): Promise<PluginToolInvocationResult>;
	register(tool: PluginTool): void;
	list(): readonly PluginTool[];
}

export interface PluginUiRegistry {
	register(definition: PluginUiDefinition): void;
	list(): readonly PluginUiDefinition[];
}

export interface PluginModelDescriptor {
	readonly id: string;
	readonly capabilities: readonly string[];
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
}

export interface PluginModelPort {
	readonly providerId: string;
	readonly modelId: string;
	/** Opaque to the SDK: the host consumes the underlying pi-ai `Models` collection. */
	readonly models: unknown;
}

export interface PluginModelProvider {
	readonly id: string;
	/** False when the plugin has no usable credentials yet; the host then falls back. */
	isConfigured?(): boolean | Promise<boolean>;
	createPort(options?: {
		readonly onMessage?: (message: unknown) => void;
	}): PluginModelPort | Promise<PluginModelPort>;
}

export interface PluginModelRegistry {
	registerProvider(provider: PluginModelProvider): () => void;
	getProvider(id: string): PluginModelProvider | undefined;
	listProviders(): readonly PluginModelProvider[];
}

export type PluginRpcHandler = (input: unknown) => Promise<unknown> | unknown;

export interface PluginRpcRegistry {
	register(method: string, handler: PluginRpcHandler): () => void;
	list(): readonly { readonly method: string }[];
}

export interface PluginChannelApi {
	send(conversationId: string, parts: readonly MessagePart[]): Promise<void>;
}

export interface ToolInvocationContext {
	readonly conversationId?: string;
	readonly userId?: string;
}

export interface ToolResult {
	content: readonly { readonly text: string; readonly type: "text" }[];
}

export interface PluginTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	requiredPermissions: readonly PluginPermission[];
	execute(
		input: Record<string, unknown>,
		context: ToolInvocationContext,
	): Promise<ToolResult> | ToolResult;
}

export type PluginToolInvocationResult =
	| { ok: true; result: ToolResult }
	| { ok: false; reason: "permission_denied"; permission: PluginPermission };

/** The subset of the durable tool API a plugin tool adapter needs. */
export interface PluginToolExecutionApi {
	readonly conversationId: number;
}

/**
 * Structural form of a pi-durable `ToolRegistration`. Kept independent of pi-durable so
 * the plugin SDK can expose tools without depending on the durable runtime.
 */
export interface PluginToolRegistration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		args: unknown,
		api: PluginToolExecutionApi,
		context: unknown,
	): Promise<{
		readonly output: { readonly type: "text"; readonly text: string }[];
		readonly isError?: boolean;
	}>;
}

export interface PluginToolsExtension {
	readonly name: string;
	readonly tools: readonly PluginToolRegistration[];
}

export interface PluginUiDefinition {
	kind: "panel" | "conversation-action" | "message-card" | "settings-form" | "approval-card";
	id: string;
	title: string;
	component: string;
	data: Record<string, unknown>;
}

export type PluginHookName =
	| "message.received"
	| "activity.opened"
	| "activity.closed"
	| "before.agent"
	| "before.reply"
	| "after.reply"
	| "task.created"
	| "task.completed"
	| "channel.connected"
	| "channel.disconnected";

export interface PluginHook {
	name: PluginHookName;
	handler: (payload: unknown) => Promise<void> | void;
}

export interface PluginContext {
	pluginId: string;
	manifest: PluginManifest;
	config: PluginConfig;
	logger: PluginLogger;
	storage: PluginStorage;
	conversation: {
		read(): Promise<readonly MessageEnvelope[]>;
	};
	events: PluginEvents;
	tools: PluginToolRegistry;
	ui: PluginUiRegistry;
	/** Model providers contributed by this plugin. */
	models: PluginModelRegistry;
	/** WebUI-callable procedures contributed by this plugin. */
	rpc: PluginRpcRegistry;
	channel?: PluginChannelApi;
	/** Present when the plugin declares channel permissions. */
	channels?: PluginChannelRegistry;
	/** Per-plugin configuration with host-resolved environment fallbacks. */
	settings?: PluginSettingsApi;
	/** Durable request inbox for friend/group requests. */
	requests?: PluginRequestApi;
	/** Host audit trail. */
	audit?: PluginAuditApi;
	/** Host bindings for built-in plugins; absent for third-party plugins. */
	dependencies?: PluginDependencyBag;
}
