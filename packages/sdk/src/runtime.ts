import type { PluginContext, PluginHookName, ToolInvocationContext } from "./types.ts";

export type PluginSetup = (context: PluginContext) => Promise<void> | void;
/** Runs before the conversation host exists, for host-surface registration. */
export type PluginPrepare = (context: PluginContext) => Promise<void> | void;
export type PluginTeardown = (context: PluginContext) => Promise<void> | void;

export interface TsukaimaPlugin {
	manifest: PluginContext["manifest"];
	prepare?: PluginPrepare;
	setup: PluginSetup;
	teardown?: PluginTeardown;
}

export interface PluginRuntimeOptions {
	plugin: TsukaimaPlugin;
	context: PluginContext;
}

export interface PluginRuntimeState {
	started: boolean;
}

export type PluginWorkerInvocationResult =
	| { ok: true; result: unknown }
	| { ok: false; reason: string };

export type HostPluginBridge = {
	emitHook(name: PluginHookName, payload: unknown): Promise<void>;
	invokeTool(
		name: string,
		input: Record<string, unknown>,
		context?: ToolInvocationContext,
	): Promise<PluginWorkerInvocationResult>;
	listTools(): readonly { name: string }[];
	listUi(): readonly { id: string }[];
};

export class PluginRuntime {
	readonly #plugin: TsukaimaPlugin;
	readonly #context: PluginContext;
	readonly state: PluginRuntimeState = { started: false };
	#hostBridge!: HostPluginBridge;

	constructor({ plugin, context }: PluginRuntimeOptions) {
		this.#plugin = plugin;
		this.#context = context;
		this.#hostBridge = this.createHostBridge();
	}

	async start(): Promise<void> {
		if (this.state.started) {
			throw new Error(`Plugin ${this.#context.pluginId} is already started`);
		}
		await this.#plugin.setup(this.#context);
		this.state.started = true;
	}

	async stop(): Promise<void> {
		if (!this.state.started) {
			return;
		}
		await this.#plugin.teardown?.(this.#context);
		this.state.started = false;
	}

	hostBridge(): HostPluginBridge {
		return this.#hostBridge;
	}

	createHostBridge(): HostPluginBridge {
		return {
			emitHook: async (name, payload) => this.#readyContext().events.emit(name, payload),
			invokeTool: async (name, input, context) =>
				this.#readyContext().tools.invoke(name, input, context),
			listTools: () => this.#readyContext().tools.list(),
			listUi: () => this.#readyContext().ui.list(),
		};
	}

	#readyContext(): PluginContext {
		if (!this.state.started) throw new Error(`Plugin ${this.#context.pluginId} is not started`);
		return this.#context;
	}
}
