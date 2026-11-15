import {
	completePluginModel,
	createPluginContext,
	collectPluginModels,
	hasPermission,
	LocalStorageBridge,
	providerSafeToolName,
	type AuditEntry,
	type TsukaimaPlugin,
	type PluginContext,
	type PluginEvents,
	type PluginLogger,
	type PluginManifest,
	type PluginModelCompleteRequest,
	type PluginModelInfo,
	type PluginModelProvider,
	type PluginModelQuery,
	type PluginRpcHandler,
	type PluginSettingsApi,
	type PluginTool,
	type PluginToolInvocationResult,
	type PluginUiRegistry,
	type ToolInvocationContext,
} from "@tsukaima/sdk";
import {
	PluginLifecycleManager,
	PluginRegistry,
	loadPluginMigrations,
	migrateLegacyPluginTables,
	wrapPluginSqlConnection,
	type InstalledPlugin,
	type PluginDatabaseProvider,
	type PluginLifecycleUpgradeOptions,
	type PluginMigration,
	type PluginInstallState,
} from "@tsukaima/plugin-registry";
import type { PluginStatusSnapshot } from "@tsukaima/contracts";
import type { Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { HookBus } from "./hook-bus.ts";
import type { PluginConversationService } from "./plugin-conversation-service.ts";
import type { PluginSettingsStore } from "./plugin-settings.ts";
import type { PluginStatusStore } from "./plugin-status.ts";
import type { PluginStorageStore } from "./plugin-storage.ts";
import type { PluginTaskService } from "./plugin-task-service.ts";
import type { RequestService } from "./request-service.ts";
import type { MigrationRegistry } from "@tsukaima/plugin-registry";
import { createPluginDatabase } from "./plugin-scoped-database.ts";
import { createPluginCacheBridge } from "./plugin-cache.ts";
import { createPluginMediaBridge } from "./plugin-media.ts";
import type { MediaService } from "./media-service.ts";
import { pluginInstallStates, type TsukaimaDatabase } from "@tsukaima/db";
import type { KeyvCache } from "@tsukaima/cache";
import { eq } from "drizzle-orm";

export interface PluginHostOptions {
	readonly audit: (entry: AuditEntry) => Promise<void>;
	readonly bindings?: ReadonlyMap<string, unknown>;
	readonly channels: ChannelRegistry;
	readonly conversations?: PluginConversationService;
	/** Resolve explicitly granted capabilities for the durable conversation id. */
	readonly conversationCapabilities?: (conversationId: string) => Promise<readonly string[]>;
	readonly hooks: HookBus;
	readonly logger: Logger;
	readonly onModelMessage?: (message: unknown, pluginId: string) => void;
	readonly plugins: readonly TsukaimaPlugin[];
	readonly requests: RequestService;
	readonly settings: PluginSettingsStore;
	readonly statuses: PluginStatusStore;
	readonly cache?: KeyvCache;
	readonly database?: () => TsukaimaDatabase | undefined;
	readonly media?: MediaService;
	readonly migrations?: MigrationRegistry;
	readonly pluginDatabases?: PluginDatabaseProvider;
	readonly storage?: PluginStorageStore;
	readonly tasks?: PluginTaskService;
}

export interface PluginHostEntry {
	readonly apiVersion: string;
	readonly config: Record<string, unknown>;
	readonly configSchema?: Record<string, unknown>;
	/** 1/0 to match the WebUI plugin row contract. */
	readonly enabled: number;
	readonly id: string;
	readonly kind: PluginManifest["kind"];
	readonly lifecycle?: {
		readonly failureCount: number;
		readonly quarantinedAt: string | null;
		readonly quarantineReason: string | null;
		readonly retainData: boolean;
	};
	readonly modelProviders: readonly string[];
	readonly name: string;
	readonly permissions: readonly string[];
	readonly runMode: InstalledPlugin["runMode"];
	readonly rpcMethods: readonly string[];
	readonly secretKeys: readonly string[];
	readonly secretsSet: readonly string[];
	readonly status: PluginStatusSnapshot | null;
	readonly tools: readonly string[];
	readonly ui: readonly {
		readonly component: string;
		readonly data: Record<string, unknown>;
		readonly id: string;
		readonly i18nKeys?: readonly string[];
		readonly kind: ReturnType<PluginUiRegistry["list"]>[number]["kind"];
		readonly requiredPermissions?: readonly string[];
		readonly schema?: Record<string, unknown>;
		readonly slot?: ReturnType<PluginUiRegistry["list"]>[number]["kind"];
		readonly title: string;
		readonly version?: string;
	}[];
	readonly version: string;
}

function adaptPluginLogger(logger: Logger, target: string): PluginLogger {
	const build = (current: Logger, currentTarget: string): PluginLogger => ({
		trace: (message, details) => current.trace(message, details),
		debug: (message, details) => current.debug(message, details),
		info: (message, details) => current.info(message, details),
		warn: (message, details) => current.warn(message, details),
		error: (message, details) => current.error(message, details),
		child: (subTarget, fields) => {
			const trimmed = subTarget.trim();
			const nextTarget = trimmed.length === 0 ? currentTarget : `${currentTarget}::${trimmed}`;
			return build(current.child(nextTarget, fields), nextTarget);
		},
	});
	return build(logger.child(target), target);
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
	readonly #conversations: PluginConversationService | undefined;
	readonly #conversationCapabilities:
		| ((conversationId: string) => Promise<readonly string[]>)
		| undefined;
	readonly #plugins = new Map<string, TsukaimaPlugin>();
	readonly #modelProviders = new Map<string, PluginModelProvider>();
	readonly #modelProviderOwners = new Map<string, string>();
	readonly #prepared = new Set<string>();
	readonly #registry = new PluginRegistry();
	readonly #rpcHandlers = new Map<string, PluginRpcHandler>();
	readonly #requests: RequestService;
	readonly #started: string[] = [];
	readonly #statuses: PluginStatusStore;
	readonly #rpcOwners = new Map<string, string>();
	readonly #cache: KeyvCache | undefined;
	readonly #database: (() => TsukaimaDatabase | undefined) | undefined;
	readonly #media: MediaService | undefined;
	readonly #migrations: MigrationRegistry | undefined;
	readonly #pluginDatabases: PluginDatabaseProvider | undefined;
	readonly #storage: PluginStorageStore | undefined;
	readonly #tasks: PluginTaskService | undefined;
	readonly #lifecycle: PluginLifecycleManager;
	#statesLoaded = false;

	constructor(options: PluginHostOptions) {
		this.#options = options;
		this.#audit = options.audit;
		this.#bindings = options.bindings ?? new Map();
		this.#conversations = options.conversations;
		this.#conversationCapabilities = options.conversationCapabilities;
		this.#hooks = options.hooks;
		this.#logger = options.logger.child("tsukaima::server::plugins");
		this.#requests = options.requests;
		this.channels = options.channels;
		this.settings = options.settings;
		this.#statuses = options.statuses;
		this.#cache = options.cache;
		this.#database = options.database;
		this.#media = options.media;
		this.#migrations = options.migrations;
		this.#pluginDatabases = options.pluginDatabases;
		this.#storage = options.storage;
		this.#tasks = options.tasks;
		this.#lifecycle = new PluginLifecycleManager({
			maxFailures: 3,
			migrations: options.migrations,
			registry: this.#registry,
			hooks: {
				clearStorage: async (pluginId) => {
					await this.#storage?.clear(pluginId);
				},
				exportStorage: async (pluginId) => (await this.#storage?.export(pluginId)) ?? [],
				importStorage: async (_pluginId, storage) => {
					if (Array.isArray(storage)) await this.#storage?.import(storage as never);
				},
				readConfig: async (pluginId) => await this.settings.read(pluginId),
				reload: async (pluginId) => {
					this.#contexts.delete(pluginId);
					this.#prepared.delete(pluginId);
				},
				start: async (pluginId) => {
					this.#syncManifest(pluginId);
					await this.#restartPlugin(pluginId);
				},
				stop: async (pluginId) => {
					await this.#stopPlugin(pluginId);
				},
				writeConfig: async (pluginId, config) => {
					await this.settings.write(pluginId, config);
				},
			},
		});
	}

	async list(): Promise<readonly PluginHostEntry[]> {
		const entries: PluginHostEntry[] = [];
		for (const installed of this.#registry.list()) {
			const view = await this.settings.publicView(installed.manifest.name);
			const ui = this.ui().filter((definition) => definition.pluginId === installed.manifest.name);
			const state = this.#lifecycle.state(installed.manifest.name);
			entries.push({
				apiVersion: installed.manifest.apiVersion,
				config: view.config,
				...(installed.manifest.configSchema === undefined
					? {}
					: { configSchema: installed.manifest.configSchema }),
				enabled: installed.enabled ? 1 : 0,
				id: installed.manifest.name,
				kind: installed.manifest.kind,
				...(state === undefined
					? {}
					: {
							lifecycle: {
								failureCount: state.failureCount,
								quarantinedAt: state.quarantinedAt ?? null,
								quarantineReason: state.quarantineReason ?? null,
								retainData: state.retainData,
							},
						}),
				modelProviders: [...this.#modelProviderOwners.entries()]
					.filter(([, owner]) => owner === installed.manifest.name)
					.map(([providerId]) => providerId),
				name: installed.manifest.name,
				permissions: installed.manifest.permissions,
				runMode: installed.runMode,
				rpcMethods: [...this.#rpcOwners.entries()]
					.filter(([, owner]) => owner === installed.manifest.name)
					.map(([method]) => method),
				secretKeys: installed.manifest.secretKeys,
				secretsSet: [...view.secretsSet],
				status: this.#statuses.get(installed.manifest.name) ?? null,
				tools: this.tools()
					.filter((tool) => tool.name.startsWith(`${installed.manifest.name}.`))
					.map((tool) => tool.name),
				ui: ui.map((definition) => ({
					component: definition.component,
					data: definition.data,
					id: definition.id,
					kind: definition.kind,
					title: definition.title,
					...(definition.i18nKeys === undefined ? {} : { i18nKeys: definition.i18nKeys }),
					...(definition.requiredPermissions === undefined
						? {}
						: { requiredPermissions: definition.requiredPermissions }),
					...(definition.schema === undefined ? {} : { schema: definition.schema }),
					...(definition.slot === undefined ? {} : { slot: definition.slot }),
					...(definition.version === undefined ? {} : { version: definition.version }),
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

	plugin(pluginId: string): TsukaimaPlugin | undefined {
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
		readonly i18nKeys?: readonly string[];
		readonly kind: ReturnType<PluginUiRegistry["list"]>[number]["kind"];
		readonly pluginId: string;
		readonly requiredPermissions?: readonly string[];
		readonly schema?: Record<string, unknown>;
		readonly slot?: ReturnType<PluginUiRegistry["list"]>[number]["kind"];
		readonly title: string;
		readonly version?: string;
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

	/** Secret-free model catalog reported by started providers. */
	async listModels(query?: PluginModelQuery): Promise<readonly PluginModelInfo[]> {
		return collectPluginModels(this.#modelProviders.values(), query);
	}

	/** Invoke a WebUI-visible plugin RPC method. Methods are namespaced by plugin id. */
	async invokeRpc(method: string, input: unknown, pluginId?: string): Promise<unknown> {
		if (pluginId !== undefined && !method.startsWith(`${pluginId}.`)) {
			throw new Error(`Plugin RPC method ${method} does not belong to ${pluginId}`);
		}
		const handler = this.#rpcHandlers.get(method);
		if (handler === undefined) throw new Error(`Unknown plugin RPC method: ${method}`);
		const owner = this.#rpcOwners.get(method) ?? pluginId;
		const startedAt = performance.now();
		this.#logger.trace("plugin RPC invoked", { method, pluginId: owner });
		try {
			const result = await handler(input);
			this.#logger.debug("plugin RPC completed", {
				durationMs: Math.round(performance.now() - startedAt),
				method,
				pluginId: owner,
			});
			return result;
		} catch (error) {
			this.#logger.warn("plugin RPC failed", {
				durationMs: Math.round(performance.now() - startedAt),
				error,
				method,
				pluginId: owner,
			});
			throw error;
		}
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
			this.#logger.trace("routing plugin tool invocation", {
				conversationId: context.conversationId,
				pluginId,
				tool: name,
			});
			return pluginContext.tools.invoke(name, input, context);
		}
		throw new Error(`Unknown plugin tool ${name}`);
	}

	/** Policy context layered by the SDK tool adapter for a registered tool. */
	async toolPolicyContext(
		tool: PluginTool,
		context: ToolInvocationContext,
	): Promise<{
		readonly grantedPermissions: readonly string[];
		readonly conversationAllowedTools?: readonly string[];
		readonly channelCapabilities?: readonly string[];
		readonly conversationCapabilities?: readonly string[];
	}> {
		const owner = this.#toolOwner(tool.name);
		const manifest = owner === undefined ? undefined : this.#plugins.get(owner)?.manifest;
		const conversation = context.conversationId;
		const channelCapabilities =
			conversation === undefined
				? undefined
				: this.channels.capabilities(conversation.split(":")[0] ?? "");
		let conversationCapabilities: readonly string[] | undefined;
		if (conversation !== undefined && this.#conversationCapabilities !== undefined) {
			try {
				conversationCapabilities = await this.#conversationCapabilities(conversation);
			} catch {
				conversationCapabilities = [];
			}
		}
		return {
			grantedPermissions: manifest?.permissions ?? [],
			...(context.allowedTools === undefined
				? {}
				: { conversationAllowedTools: context.allowedTools }),
			...(channelCapabilities === undefined ? {} : { channelCapabilities }),
			...(conversationCapabilities === undefined ? {} : { conversationCapabilities }),
		};
	}

	/** Provider-safe model tool names owned by one plugin, used for per-conversation filters. */
	modelToolNames(pluginId: string): readonly string[] {
		const context = this.#contexts.get(pluginId);
		if (context === undefined) return [];
		return context.tools.list().map((tool) => providerSafeToolName(tool.name));
	}

	#toolOwner(name: string): string | undefined {
		for (const pluginId of this.#started) {
			const context = this.#contexts.get(pluginId);
			if (context?.tools.list().some((tool) => tool.name === name) === true) {
				return pluginId;
			}
		}
		return undefined;
	}

	/** Register host surfaces that must exist before the conversation host is built. */
	async prepare(): Promise<void> {
		await this.#loadLifecycleStates();
		for (const plugin of this.#options.plugins) {
			const manifest = plugin.manifest;
			this.settings.registerManifest(manifest);
			this.#plugins.set(manifest.name, plugin);
			if (this.#prepared.has(manifest.name)) continue;
			if (this.#lifecycle.isQuarantined(manifest.name)) {
				this.#logger.debug("skipping quarantined plugin during prepare", {
					pluginId: manifest.name,
				});
				continue;
			}
			if (this.#registry.get(manifest.name) === undefined) {
				const enabled = await this.settings.isEnabled(manifest.name);
				this.#registry.install(manifest, {
					enabled,
					grantedPermissions: manifest.permissions,
					runMode: "host",
				});
			}
			if (this.#registry.get(manifest.name)?.enabled === false) {
				this.#logger.debug("skipping disabled plugin during prepare", { pluginId: manifest.name });
				continue;
			}
			await this.#ensurePluginDatabase(plugin);
			const context = this.#createContext(manifest);
			this.#contexts.set(manifest.name, context);
			const startedAt = performance.now();
			try {
				await plugin.prepare?.(context);
				this.#prepared.add(manifest.name);
				this.#logger.debug("plugin prepared", {
					durationMs: Math.round(performance.now() - startedAt),
					pluginId: manifest.name,
				});
			} catch (error) {
				this.#logger.error("plugin prepare failed", {
					error,
					pluginId: manifest.name,
				});
				await this.recordPluginFailure(
					manifest.name,
					`prepare: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async start(): Promise<void> {
		await this.prepare();
		for (const plugin of this.#options.plugins) {
			if (this.#registry.get(plugin.manifest.name)?.enabled === false) continue;
			if (this.#lifecycle.isQuarantined(plugin.manifest.name)) continue;
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
				this.#logger.debug("plugin stopped", { pluginId });
			} catch (error) {
				this.#logger.warn("plugin teardown failed", {
					error,
					pluginId,
				});
			}
		}
		this.#started.length = 0;
		this.#rpcHandlers.clear();
		this.#rpcOwners.clear();
		this.#modelProviders.clear();
		this.#modelProviderOwners.clear();
	}

	async applySettings(pluginId: string, patch: Record<string, unknown>): Promise<unknown> {
		this.#logger.debug("applying plugin settings patch", {
			keys: Object.keys(patch),
			pluginId,
		});
		return this.settings.write(pluginId, patch);
	}

	/** Persist an enable/disable choice and start or stop the plugin immediately. */
	async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
		const installed = this.#registry.get(pluginId);
		if (installed === undefined) throw new Error(`Unknown plugin ${pluginId}`);
		await this.settings.setEnabled(pluginId, enabled);
		this.#registry.setEnabled(pluginId, enabled);
		this.#logger.info("plugin enabled state updated", { enabled, pluginId });
		if (!enabled) {
			await this.#stopPlugin(pluginId);
			return;
		}
		const plugin = this.#plugins.get(pluginId);
		if (plugin !== undefined && !this.#started.includes(pluginId)) {
			if (this.#lifecycle.isQuarantined(pluginId)) return;
			await this.#ensurePluginDatabase(plugin);
			// A disabled plugin may have been prepared with a context that predates its database.
			this.#contexts.delete(pluginId);
			this.#prepared.delete(pluginId);
			// `prepare` owns host surfaces such as model providers. Re-run it after a
			// disable/enable cycle so those surfaces are registered again.
			if (!this.#prepared.has(pluginId)) {
				const context = this.#contexts.get(pluginId) ?? this.#createContext(plugin.manifest);
				this.#contexts.set(pluginId, context);
				try {
					await plugin.prepare?.(context);
					this.#prepared.add(pluginId);
				} catch (error) {
					await this.recordPluginFailure(
						pluginId,
						`prepare: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
			}
			await this.#startPlugin(plugin);
		}
	}

	async install(
		input: unknown,
		options: {
			readonly config?: Record<string, unknown>;
			readonly enabled?: boolean;
			readonly grantedPermissions?: readonly string[];
			readonly migrations?: readonly PluginMigration[];
			readonly rootDir?: string;
			readonly runMode?: InstalledPlugin["runMode"];
		} = {},
	): Promise<PluginHostEntry> {
		const manifest = await this.#registry.loadManifest(input);
		await this.#lifecycle.install(manifest, options);
		this.settings.registerManifest(manifest);
		const plugin: TsukaimaPlugin = { manifest, setup() {} };
		this.#plugins.set(manifest.name, plugin);
		const installed = this.#registry.get(manifest.name);
		if (installed !== undefined && installed.enabled) {
			const context = this.#createContext(manifest);
			this.#contexts.set(manifest.name, context);
			await this.#startPlugin(plugin);
		}
		await this.#persistLifecycleState(manifest.name);
		return await this.#entry(manifest.name);
	}

	async upgrade(
		pluginId: string,
		input: unknown,
		options: PluginLifecycleUpgradeOptions = {},
	): Promise<PluginHostEntry> {
		const manifest = await this.#registry.loadManifest(input);
		await this.#lifecycle.upgrade(pluginId, manifest, options);
		this.#syncManifest(pluginId);
		await this.#persistLifecycleState(pluginId);
		return await this.#entry(pluginId);
	}

	async downgrade(
		pluginId: string,
		input: unknown,
		options: PluginLifecycleUpgradeOptions = {},
	): Promise<PluginHostEntry> {
		const manifest = await this.#registry.loadManifest(input);
		await this.#lifecycle.downgrade(pluginId, manifest, options);
		this.#syncManifest(pluginId);
		await this.#persistLifecycleState(pluginId);
		return await this.#entry(pluginId);
	}

	async reload(pluginId: string): Promise<PluginHostEntry> {
		await this.#lifecycle.reload(pluginId);
		this.#syncManifest(pluginId);
		await this.#persistLifecycleState(pluginId);
		return await this.#entry(pluginId);
	}

	async recover(pluginId: string): Promise<PluginHostEntry> {
		await this.#lifecycle.recover(pluginId);
		this.#syncManifest(pluginId);
		await this.#persistLifecycleState(pluginId);
		return await this.#entry(pluginId);
	}

	async uninstall(
		pluginId: string,
		options: { readonly retainData?: boolean } = {},
	): Promise<boolean> {
		await this.#lifecycle.uninstall(pluginId, options);
		await this.#stopPlugin(pluginId);
		this.#plugins.delete(pluginId);
		this.#contexts.delete(pluginId);
		this.#prepared.delete(pluginId);
		const database = this.#database?.();
		if (database !== undefined) {
			await database.delete(pluginInstallStates).where(eq(pluginInstallStates.pluginId, pluginId));
		}
		return true;
	}

	async recordPluginFailure(pluginId: string, reason: string): Promise<PluginInstallState> {
		const state = this.#lifecycle.recordFailure(pluginId, reason);
		await this.#persistLifecycleState(pluginId);
		if (state.quarantinedAt !== undefined) {
			await this.#stopPlugin(pluginId);
			this.#logger.warn("plugin quarantined", { pluginId, reason });
		}
		return state;
	}

	async #entry(pluginId: string): Promise<PluginHostEntry> {
		const entries = await this.list();
		const entry = entries.find((plugin) => plugin.id === pluginId);
		if (entry === undefined) throw new Error(`Unknown plugin ${pluginId}`);
		return entry;
	}

	async #restartPlugin(pluginId: string): Promise<void> {
		await this.#stopPlugin(pluginId);
		const plugin = this.#plugins.get(pluginId);
		if (plugin === undefined) return;
		this.#contexts.delete(pluginId);
		this.#prepared.delete(pluginId);
		const context = this.#createContext(plugin.manifest);
		this.#contexts.set(pluginId, context);
		try {
			await plugin.prepare?.(context);
			this.#prepared.add(pluginId);
		} catch (error) {
			await this.recordPluginFailure(
				pluginId,
				`prepare: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		await this.#startPlugin(plugin);
	}

	#syncManifest(pluginId: string): void {
		const installed = this.#registry.get(pluginId);
		const plugin = this.#plugins.get(pluginId);
		if (installed === undefined || plugin === undefined) return;
		plugin.manifest = installed.manifest;
		this.settings.registerManifest(installed.manifest);
	}

	async #loadLifecycleStates(): Promise<void> {
		if (this.#statesLoaded) return;
		this.#statesLoaded = true;
		const database = this.#database?.();
		if (database === undefined) return;
		const rows = await database.select().from(pluginInstallStates);
		const states: PluginInstallState[] = [];
		for (const row of rows) {
			try {
				states.push({
					backup: row.backupJson === null ? undefined : JSON.parse(row.backupJson),
					failureCount: row.failureCount,
					installedVersion: row.installedVersion,
					kind: row.kind,
					manifest: this.#registry.get(row.pluginId)?.manifest ?? JSON.parse(row.manifestJson),
					...(row.quarantineReason === null ? {} : { quarantineReason: row.quarantineReason }),
					...(row.quarantinedAt === null ? {} : { quarantinedAt: row.quarantinedAt }),
					retainData: row.retainData === 1,
					updatedAt: row.updatedAt,
				});
			} catch {}
		}
		this.#lifecycle.hydrate(states);
	}

	async #persistLifecycleState(pluginId: string): Promise<void> {
		const database = this.#database?.();
		const state = this.#lifecycle.state(pluginId);
		if (database === undefined || state === undefined) return;
		await database
			.insert(pluginInstallStates)
			.values({
				backupJson: state.backup === undefined ? null : JSON.stringify(state.backup),
				failureCount: state.failureCount,
				installedVersion: state.installedVersion,
				kind: state.kind,
				manifestJson: JSON.stringify(state.manifest),
				pluginId,
				quarantineReason: state.quarantineReason ?? null,
				quarantinedAt: state.quarantinedAt ?? null,
				retainData: state.retainData ? 1 : 0,
				updatedAt: state.updatedAt,
			})
			.onConflictDoUpdate({
				set: {
					backupJson: state.backup === undefined ? null : JSON.stringify(state.backup),
					failureCount: state.failureCount,
					installedVersion: state.installedVersion,
					kind: state.kind,
					manifestJson: JSON.stringify(state.manifest),
					quarantineReason: state.quarantineReason ?? null,
					quarantinedAt: state.quarantinedAt ?? null,
					retainData: state.retainData ? 1 : 0,
					updatedAt: state.updatedAt,
				},
				target: pluginInstallStates.pluginId,
			});
	}

	async #ensurePluginDatabase(plugin: TsukaimaPlugin): Promise<void> {
		const manifest = plugin.manifest;
		if (manifest.migrations === undefined || plugin.rootDir === undefined) return;
		if (this.#migrations === undefined || this.#pluginDatabases === undefined) return;
		const migrations = await loadPluginMigrations(plugin.rootDir, manifest.migrations);
		await this.#migrations.run(manifest.name, migrations);
		const target = await this.#pluginDatabases.open(manifest.name);
		const domain = this.#database?.();
		if (domain === undefined) return;
		migrateLegacyPluginTables({
			pluginId: manifest.name,
			source: wrapPluginSqlConnection(
				domain.$client as unknown as Parameters<typeof wrapPluginSqlConnection>[0],
			),
			target,
		});
	}

	async #startPlugin(plugin: TsukaimaPlugin): Promise<void> {
		const manifest = plugin.manifest;
		const pluginId = manifest.name;
		if (this.#started.includes(pluginId)) return;
		const context = this.#contexts.get(pluginId) ?? this.#createContext(manifest);
		this.#contexts.set(pluginId, context);
		const startedAt = performance.now();
		this.#logger.debug("starting plugin", { kind: manifest.kind, pluginId });
		try {
			await plugin.setup(context);
			this.#started.push(pluginId);
			this.#lifecycle.recordSuccess(pluginId);
			await this.#persistLifecycleState(pluginId);
			this.#logger.info("plugin started", {
				durationMs: Math.round(performance.now() - startedAt),
				kind: manifest.kind,
				pluginId,
			});
			this.#logger.trace("plugin registered surfaces", {
				pluginId,
				rpcMethods: [...this.#rpcOwners.entries()]
					.filter(([, owner]) => owner === pluginId)
					.map(([method]) => method),
				tools: context.tools.list().map((tool) => tool.name),
			});
		} catch (error) {
			this.#logger.error("plugin failed to start", {
				durationMs: Math.round(performance.now() - startedAt),
				error,
				pluginId,
			});
			await this.recordPluginFailure(
				pluginId,
				`setup: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #stopPlugin(pluginId: string): Promise<void> {
		const context = this.#contexts.get(pluginId);
		const plugin = this.#plugins.get(pluginId);
		if (context === undefined || plugin === undefined) return;
		this.#logger.debug("stopping plugin", { pluginId });
		try {
			await plugin.teardown?.(context);
		} catch (error) {
			this.#logger.warn("plugin teardown failed", {
				error,
				pluginId,
			});
		}
		const index = this.#started.indexOf(pluginId);
		if (index !== -1) this.#started.splice(index, 1);
		for (const [method, owner] of this.#rpcOwners) {
			if (owner !== pluginId) continue;
			this.#rpcHandlers.delete(method);
			this.#rpcOwners.delete(method);
		}
		for (const [providerId, owner] of this.#modelProviderOwners) {
			if (owner !== pluginId) continue;
			this.#modelProviders.delete(providerId);
			this.#modelProviderOwners.delete(providerId);
		}
		this.#statuses.clear(pluginId);
		this.#prepared.delete(pluginId);
	}

	#createContext(manifest: PluginManifest): PluginContext {
		const pluginId = manifest.name;
		const events: PluginEvents = {
			emit: async (name, payload) => this.#hooks.emit(name, payload),
			on: (name, handler) => {
				if (name === "reply.transform" && !hasPermission(manifest.permissions, name)) {
					this.#logger.warn("plugin lacks reply.transform permission; hook ignored", {
						pluginId,
					});
					return () => {};
				}
				return this.#hooks.on(name, handler);
			},
			transform: async (name, payload) => {
				if (name === "reply.transform" && !hasPermission(manifest.permissions, name)) {
					return payload;
				}
				return await this.#hooks.transform(name, payload);
			},
		};
		const settings: PluginSettingsApi = {
			get: async () => this.settings.read(pluginId),
			onChange: (handler) => this.settings.onChange(pluginId, handler),
		};
		const models = {
			getProvider: (id: string) => this.#modelProviders.get(id),
			listProviders: () => [...this.#modelProviders.values()],
			listModels: async (query?: PluginModelQuery): Promise<readonly PluginModelInfo[]> => {
				const catalog = await collectPluginModels(this.#modelProviders.values(), query);
				return catalog.map((model) => {
					const ownerId = this.#modelProviderOwners.get(model.providerId);
					return ownerId === undefined ? model : { ...model, pluginId: ownerId };
				});
			},
			findModel: async (modelId: string, providerId?: string) => {
				const catalog = await collectPluginModels(
					this.#modelProviders.values(),
					providerId === undefined ? {} : { providerId },
				);
				const found = catalog.find((model) => model.id === modelId);
				if (found === undefined) return undefined;
				const ownerId = this.#modelProviderOwners.get(found.providerId);
				return ownerId === undefined ? found : { ...found, pluginId: ownerId };
			},
			complete: async (request: PluginModelCompleteRequest) =>
				await completePluginModel(
					this.#modelProviders,
					request,
					this.#options.onModelMessage === undefined
						? {}
						: {
								onMessage: (message) => {
									this.#options.onModelMessage?.(message, pluginId);
								},
							},
				),
			embed: async (request: Parameters<NonNullable<PluginModelProvider["embed"]>>[0]) => {
				for (const provider of this.#modelProviders.values()) {
					if (provider.embed !== undefined) return await provider.embed(request);
					if (provider.embedding !== undefined) {
						return await provider.embedding.embed(request);
					}
				}
				throw new Error(`No embedding provider for ${request.modelId ?? "default"}`);
			},
			embedding: async (request: Parameters<NonNullable<PluginModelProvider["embed"]>>[0]) => {
				for (const provider of this.#modelProviders.values()) {
					if (provider.embed !== undefined) return await provider.embed(request);
					if (provider.embedding !== undefined) {
						return await provider.embedding.embed(request);
					}
				}
				throw new Error(`No embedding provider for ${request.modelId ?? "default"}`);
			},
			transcribeAudio: async (
				request: Parameters<NonNullable<PluginModelProvider["transcribeAudio"]>>[0],
			) => {
				for (const provider of this.#modelProviders.values()) {
					if (provider.transcribeAudio !== undefined) {
						return await provider.transcribeAudio(request);
					}
					if (provider.audioTranscribe !== undefined) {
						return await provider.audioTranscribe.transcribeAudio(request);
					}
				}
				throw new Error(`No audio-transcribe provider for ${request.modelId ?? "default"}`);
			},
			audioTranscribe: async (
				request: Parameters<NonNullable<PluginModelProvider["transcribeAudio"]>>[0],
			) => {
				for (const provider of this.#modelProviders.values()) {
					if (provider.transcribeAudio !== undefined) {
						return await provider.transcribeAudio(request);
					}
					if (provider.audioTranscribe !== undefined) {
						return await provider.audioTranscribe.transcribeAudio(request);
					}
				}
				throw new Error(`No audio-transcribe provider for ${request.modelId ?? "default"}`);
			},
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
				this.#rpcOwners.set(name, pluginId);
				return () => {
					this.#rpcHandlers.delete(name);
					this.#rpcOwners.delete(name);
				};
			},
		};
		const runMode = this.#registry.get(pluginId)?.runMode ?? "host";
		const storage =
			this.#storage?.bridge(pluginId, manifest.permissions) ?? new LocalStorageBridge();
		const cache =
			this.#cache === undefined
				? undefined
				: createPluginCacheBridge(this.#cache, pluginId, manifest.permissions);
		const migrations =
			this.#migrations === undefined
				? undefined
				: {
						list: async () =>
							(await this.#migrations!.list(pluginId)).map((migration) => ({
								checksum: migration.checksum,
								durationMs: migration.durationMs,
								pluginId: migration.pluginId,
								rollbackSql: migration.rollbackSql ?? null,
								status: "applied" as const,
								version: migration.version,
							})),
						rollback: async (options?: { readonly dryRun?: boolean }) =>
							await this.#migrations!.rollbackPlugin(
								pluginId,
								options?.dryRun === undefined ? {} : { dryRun: options.dryRun },
							),
					};
		const pluginDatabase =
			runMode === "host" && manifest.migrations !== undefined
				? this.#pluginDatabases?.get(pluginId)
				: undefined;
		const scopedDatabase =
			pluginDatabase === undefined ? undefined : createPluginDatabase(pluginDatabase, pluginId);
		const media =
			this.#media !== undefined &&
			(hasPermission(manifest.permissions, "media.read") ||
				hasPermission(manifest.permissions, "media.write"))
				? createPluginMediaBridge(this.#media, pluginId, manifest.permissions)
				: undefined;
		const tasks = this.#tasks?.apiFor(pluginId, manifest.permissions);
		const conversations = this.#conversations?.forPlugin(pluginId, manifest.permissions);
		return createPluginContext({
			channels: this.channels,
			storage,
			...(cache === undefined ? {} : { cache }),
			...(tasks === undefined ? {} : { tasks }),
			...(conversations === undefined ? {} : { conversations }),
			...(migrations === undefined ? {} : { migrations }),
			...(scopedDatabase === undefined ? {} : { database: scopedDatabase }),
			...(media === undefined ? {} : { media }),
			dependencies: {
				get: <T = unknown>(key: string): T | undefined => this.#bindings.get(key) as T | undefined,
			},
			events,
			grantedPermissions: manifest.permissions,
			logger: adaptPluginLogger(this.#logger, `tsukaima::plugin::${pluginId}`),
			manifest,
			models,
			pluginId,
			onStatus: (status) => {
				this.#statuses.set(pluginId, status);
			},
			rpc,
			requests: { persist: async (request) => this.#requests.persist(request) },
			settings,
			audit: { record: async (entry: AuditEntry) => this.#audit(entry) },
		});
	}
}
