import {
	createPluginContext,
	type AuditEntry,
	type ElainaPlugin,
	type PluginContext,
	type PluginEvents,
	type PluginManifest,
	type PluginModelProvider,
	type PluginRpcHandler,
	type PluginSettingsApi,
	type PluginTool,
	type PluginToolInvocationResult,
	type PluginUiRegistry,
	type ToolInvocationContext,
} from "@elaina/sdk";
import { PluginRegistry, type InstalledPlugin } from "@elaina/plugin-registry";
import type { Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { HookBus } from "./hook-bus.ts";
import type { PluginSettingsStore } from "./plugin-settings.ts";
import type { RequestService } from "./request-service.ts";

export interface PluginHostOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly bindings?: ReadonlyMap<string, unknown>;
	readonly channels: ChannelRegistry;
	readonly hooks: HookBus;
	readonly logger: Logger;
	readonly plugins: readonly ElainaPlugin[];
	readonly requests: RequestService;
	readonly settings: PluginSettingsStore;
}

export interface PluginHostEntry {
	readonly apiVersion: string;
	readonly config: Record<string, unknown>;
	readonly configSchema?: Record<string, unknown>;
	/** 1/0 to match the WebUI plugin row contract. */
	readonly enabled: number;
	readonly id: string;
	readonly kind: PluginManifest["kind"];
	readonly modelProviders: readonly string[];
	readonly name: string;
	readonly runMode: InstalledPlugin["runMode"];
	readonly secretKeys: readonly string[];
	readonly secretsSet: readonly string[];
	readonly ui: readonly {
		readonly component: string;
		readonly data: Record<string, unknown>;
		readonly id: string;
		readonly kind: ReturnType<PluginUiRegistry["list"]>[number]["kind"];
		readonly title: string;
	}[];
	readonly version: string;
}

/**
 * The host side of the plugin framework: installs built-in plugins into the registry,
 * builds their runtime context from host services, and runs `setup`/`teardown`.
 */
export class PluginHost {
	readonly channels: ChannelRegistry;
	readonly settings: PluginSettingsStore;
	readonly #audit: (entry: AuditEntry) => Promise<void>;
	readonly #bindings: ReadonlyMap<string, unknown>;
	readonly #contexts = new Map<string, PluginContext>();
	readonly #hooks: HookBus;
	readonly #logger: Logger;
	readonly #options: PluginHostOptions;
	readonly #plugins = new Map<string, ElainaPlugin>();
	readonly #modelProviders = new Map<string, PluginModelProvider>();
	readonly #modelProviderOwners = new Map<string, string>();
	readonly #prepared = new Set<string>();
	readonly #registry = new PluginRegistry();
	readonly #rpcHandlers = new Map<string, PluginRpcHandler>();
	readonly #requests: RequestService;
	readonly #started: string[] = [];

	constructor(options: PluginHostOptions) {
		this.#options = options;
		this.#audit = options.audit;
		this.#bindings = options.bindings ?? new Map();
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("elaina::server::plugins");
		this.#requests = options.requests;
		this.channels = options.channels;
		this.settings = options.settings;
	}

	async list(): Promise<readonly PluginHostEntry[]> {
		const entries: PluginHostEntry[] = [];
		for (const installed of this.#registry.list()) {
			const view = await this.settings.publicView(installed.manifest.name);
			const ui = this.ui().filter((definition) => definition.pluginId === installed.manifest.name);
			entries.push({
				apiVersion: installed.manifest.apiVersion,
				config: view.config,
				...(installed.manifest.configSchema === undefined
					? {}
					: { configSchema: installed.manifest.configSchema }),
				enabled: installed.enabled ? 1 : 0,
				id: installed.manifest.name,
				kind: installed.manifest.kind,
				modelProviders: [...this.#modelProviderOwners.entries()]
					.filter(([, owner]) => owner === installed.manifest.name)
					.map(([providerId]) => providerId),
				name: installed.manifest.name,
				runMode: installed.runMode,
				secretKeys: installed.manifest.secretKeys,
				secretsSet: [...view.secretsSet],
				ui: ui.map((definition) => ({
					component: definition.component,
					data: definition.data,
					id: definition.id,
					kind: definition.kind,
					title: definition.title,
				})),
				version: installed.manifest.version,
			});
		}
		return entries;
	}

	/**
	 * Public, secret-free configuration for every started plugin, keyed by plugin id.
	 * Settings screens use this instead of importing a specific plugin's constants.
	 */
	async configViews(): Promise<
		{ config: Record<string, unknown>; id: string; secretsSet: string[] }[]
	> {
		const views = [];
		for (const pluginId of this.#started) {
			const view = await this.settings.publicView(pluginId);
			views.push({ config: view.config, id: pluginId, secretsSet: [...view.secretsSet] });
		}
		return views;
	}

	plugin(pluginId: string): ElainaPlugin | undefined {
		return this.#plugins.get(pluginId);
	}

	context(pluginId: string): PluginContext | undefined {
		return this.#contexts.get(pluginId);
	}

	/** UI declarations from every started plugin, with the owning plugin id attached. */
	ui(): readonly {
		readonly component: string;
		readonly data: Record<string, unknown>;
		readonly id: string;
		readonly kind: ReturnType<PluginUiRegistry["list"]>[number]["kind"];
		readonly pluginId: string;
		readonly title: string;
	}[] {
		const definitions = [];
		for (const pluginId of this.#started) {
			const context = this.#contexts.get(pluginId);
			if (context === undefined) continue;
			for (const definition of context.ui.list()) {
				definitions.push({ ...definition, pluginId });
			}
		}
		return definitions;
	}

	/** Model providers contributed by started plugins, first registration wins. */
	modelProviders(): readonly PluginModelProvider[] {
		return [...this.#modelProviders.values()];
	}

	modelProvider(providerId: string): PluginModelProvider | undefined {
		return this.#modelProviders.get(providerId);
	}

	/** Invoke a WebUI-visible plugin RPC method. Methods are namespaced by plugin id. */
	async invokeRpc(method: string, input: unknown): Promise<unknown> {
		const handler = this.#rpcHandlers.get(method);
		if (handler === undefined) throw new Error(`Unknown plugin RPC method: ${method}`);
		return handler(input);
	}

	rpcMethods(): readonly string[] {
		return [...this.#rpcHandlers.keys()];
	}

	/**
	 * Tools registered by started plugins, in startup order. Read on every model request
	 * through the durable tools extension, so registrations made after startup are visible.
	 */
	tools(): readonly PluginTool[] {
		const tools: PluginTool[] = [];
		const names = new Set<string>();
		for (const pluginId of this.#started) {
			const context = this.#contexts.get(pluginId);
			if (context === undefined) continue;
			for (const tool of context.tools.list()) {
				if (names.has(tool.name)) continue;
				names.add(tool.name);
				tools.push(tool);
			}
		}
		return tools;
	}

	/** Route a model tool call to the plugin that registered it. */
	async invokeTool(
		name: string,
		input: Record<string, unknown>,
		context: ToolInvocationContext = {},
	): Promise<PluginToolInvocationResult> {
		for (const pluginId of this.#started) {
			const pluginContext = this.#contexts.get(pluginId);
			if (pluginContext?.tools.list().some((tool) => tool.name === name) !== true) continue;
			return pluginContext.tools.invoke(name, input, context);
		}
		throw new Error(`Unknown plugin tool ${name}`);
	}

	/** Register host surfaces that must exist before the conversation host is built. */
	async prepare(): Promise<void> {
		for (const plugin of this.#options.plugins) {
			const manifest = plugin.manifest;
			this.settings.registerManifest(manifest);
			this.#plugins.set(manifest.name, plugin);
			if (this.#prepared.has(manifest.name)) continue;
			if (this.#registry.get(manifest.name) === undefined) {
				this.#registry.install(manifest, {
					enabled: true,
					grantedPermissions: manifest.permissions,
					runMode: "host",
				});
			}
			const context = this.#createContext(manifest);
			this.#contexts.set(manifest.name, context);
			try {
				await plugin.prepare?.(context);
				this.#prepared.add(manifest.name);
			} catch (error) {
				this.#logger.error("plugin prepare failed", {
					error: error instanceof Error ? error.message : String(error),
					pluginId: manifest.name,
				});
			}
		}
	}

	async start(): Promise<void> {
		await this.prepare();
		for (const plugin of this.#options.plugins) {
			await this.#startPlugin(plugin);
		}
	}

	async stop(): Promise<void> {
		for (const pluginId of this.#started.toReversed()) {
			const context = this.#contexts.get(pluginId);
			const plugin = this.#plugins.get(pluginId);
			if (context === undefined || plugin === undefined) continue;
			try {
				await plugin.teardown?.(context);
			} catch (error) {
				this.#logger.warn("plugin teardown failed", {
					error: error instanceof Error ? error.message : String(error),
					pluginId,
				});
			}
		}
		this.#started.length = 0;
		this.#rpcHandlers.clear();
		this.#modelProviders.clear();
		this.#modelProviderOwners.clear();
	}

	async applySettings(pluginId: string, patch: Record<string, unknown>): Promise<unknown> {
		return this.settings.write(pluginId, patch);
	}

	async #startPlugin(plugin: ElainaPlugin): Promise<void> {
		const manifest = plugin.manifest;
		const pluginId = manifest.name;
		if (this.#started.includes(pluginId)) return;
		const context = this.#contexts.get(pluginId) ?? this.#createContext(manifest);
		this.#contexts.set(pluginId, context);
		try {
			await plugin.setup(context);
			this.#started.push(pluginId);
			this.#logger.info("plugin started", { kind: manifest.kind, pluginId });
		} catch (error) {
			this.#logger.error("plugin failed to start", {
				error: error instanceof Error ? error.message : String(error),
				pluginId,
			});
		}
	}

	#createContext(manifest: PluginManifest): PluginContext {
		const pluginId = manifest.name;
		const events: PluginEvents = {
			emit: async (name, payload) => this.#hooks.emit(name, payload),
			on: (name, handler) => this.#hooks.on(name, handler),
		};
		const settings: PluginSettingsApi = {
			get: async () => this.settings.read(pluginId),
			onChange: (handler) => this.settings.onChange(pluginId, handler),
		};
		const models = {
			getProvider: (id: string) => this.#modelProviders.get(id),
			listProviders: () => [...this.#modelProviders.values()],
			registerProvider: (provider: PluginModelProvider): (() => void) => {
				if (this.#modelProviders.has(provider.id)) {
					throw new Error(`Model provider ${provider.id} is already registered`);
				}
				this.#modelProviders.set(provider.id, provider);
				this.#modelProviderOwners.set(provider.id, pluginId);
				return () => {
					this.#modelProviders.delete(provider.id);
					this.#modelProviderOwners.delete(provider.id);
				};
			},
		};
		const rpc = {
			list: () => [...this.#rpcHandlers.keys()].map((method) => ({ method })),
			register: (method: string, handler: PluginRpcHandler): (() => void) => {
				const name = `${pluginId}.${method}`;
				if (this.#rpcHandlers.has(name)) {
					throw new Error(`Plugin RPC method ${name} is already registered`);
				}
				this.#rpcHandlers.set(name, handler);
				return () => {
					this.#rpcHandlers.delete(name);
				};
			},
		};
		return createPluginContext({
			channels: this.channels,
			dependencies: {
				get: <T = unknown>(key: string): T | undefined => this.#bindings.get(key) as T | undefined,
			},
			events,
			grantedPermissions: manifest.permissions,
			logger: this.#logger.child(pluginId),
			manifest,
			models,
			pluginId,
			rpc,
			requests: { persist: async (request) => this.#requests.persist(request) },
			settings,
			audit: { record: async (entry: AuditEntry) => this.#audit(entry) },
		});
	}
}
