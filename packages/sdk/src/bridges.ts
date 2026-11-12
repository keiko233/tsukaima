import { assertPermission, hasPermission, type PluginPermission } from "./permissions.ts";
import { pluginManifestSchema } from "./manifest.ts";
import type {
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
	PluginStorage,
	PluginTool,
	PluginUiDefinition,
	ToolInvocationContext,
	ToolResult,
} from "./types.ts";

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

	register(definition: PluginUiDefinition): void {
		this.#definitions.set(definition.id, definition);
	}

	list(): readonly PluginUiDefinition[] {
		return [...this.#definitions.values()];
	}
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
	settings?: PluginSettingsApi;
	requests?: PluginRequestApi;
	audit?: PluginAuditApi;
	dependencies?: PluginDependencyBag;
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
	const ui = new LocalUiBridge();
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
		...(options.channel ? { channel: options.channel } : {}),
		...(options.channels ? { channels: options.channels } : {}),
		...(options.settings ? { settings: options.settings } : {}),
		...(options.requests ? { requests: options.requests } : {}),
		...(options.audit ? { audit: options.audit } : {}),
		...(options.dependencies ? { dependencies: options.dependencies } : {}),
	};
}
