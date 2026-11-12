import type { MessageEnvelope, MessagePart } from "@elaina/contracts";
import type { PluginManifest } from "./manifest.ts";
import type { PluginPermission } from "./permissions.ts";

export type PluginPermission = string;

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
	): Promise<
		| { ok: true; result: ToolResult }
		| { ok: false; reason: "permission_denied"; permission: PluginPermission }
	>;
	register(tool: PluginTool): void;
	list(): readonly PluginTool[];
}

export interface PluginUiRegistry {
	register(definition: PluginUiDefinition): void;
	list(): readonly PluginUiDefinition[];
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
	channel?: PluginChannelApi;
}
