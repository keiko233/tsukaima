import type { PluginHookName, PluginRuntime } from "@tsukaima/sdk";
import { PluginRegistryError } from "./registry.ts";

export interface PluginWorkerChannel {
	readonly mode: "worker";
	emitHook(name: PluginHookName, payload: unknown): Promise<void>;
	invokeTool(
		name: string,
		input: Record<string, unknown>,
		context?: { conversationId?: string; userId?: string; signal?: AbortSignal },
	): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;
	listTools(): readonly { name: string }[];
	listUi(): readonly { id: string }[];
	start(): Promise<void>;
	stop(): Promise<void>;
}

export class LocalPluginWorker implements PluginWorkerChannel {
	readonly mode = "worker" as const;
	readonly #runtime: PluginRuntime;
	#hostBridge: ReturnType<PluginRuntime["hostBridge"]> | undefined;
	#starting = false;

	constructor(runtime: PluginRuntime) {
		this.#runtime = runtime;
	}

	async start(): Promise<void> {
		if (this.#starting) {
			throw new PluginRegistryError("Plugin worker is already starting");
		}
		this.#starting = true;
		await this.#runtime.start();
		this.#hostBridge = this.#runtime.hostBridge();
		this.#starting = false;
	}

	async stop(): Promise<void> {
		if (this.#starting) {
			throw new PluginRegistryError("Plugin worker is starting");
		}
		await this.#runtime.stop();
		this.#hostBridge = undefined;
	}

	async emitHook(name: PluginHookName, payload: unknown): Promise<void> {
		const bridge = this.#requireHostBridge();
		await bridge.emitHook(name, payload);
	}

	async invokeTool(
		name: string,
		input: Record<string, unknown>,
		context?: { conversationId?: string; userId?: string; signal?: AbortSignal },
	): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
		return this.#requireHostBridge().invokeTool(name, input, context);
	}

	listTools(): readonly { name: string }[] {
		return this.#requireHostBridge().listTools();
	}

	listUi(): readonly { id: string }[] {
		return this.#requireHostBridge().listUi();
	}

	#requireHostBridge(): ReturnType<PluginRuntime["hostBridge"]> {
		const bridge = this.#hostBridge;
		if (!bridge) {
			throw new PluginRegistryError("Plugin worker is not started");
		}
		return bridge;
	}
}
