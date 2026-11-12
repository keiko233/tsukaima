import type { PluginHookName, PluginManifest, PluginPermission } from "@elaina/sdk";
import { PluginRegistryError } from "./registry.ts";
import type { PluginWorkerChannel } from "./worker.ts";

export interface BunPluginWorkerOptions {
	readonly config?: Record<string, unknown>;
	readonly grantedPermissions?: readonly PluginPermission[];
	readonly manifest: PluginManifest;
	readonly modulePath: string;
	readonly pluginId: string;
	readonly requestTimeoutMs?: number;
}

type WorkerResponse =
	| {
			readonly type: "ready";
			readonly tools: readonly { readonly name: string }[];
			readonly ui: readonly { readonly id: string }[];
	  }
	| {
			readonly type: "response";
			readonly id: number;
			readonly ok: boolean;
			readonly result?: unknown;
			readonly error?: string;
	  }
	| { readonly type: "error"; readonly error: string };

type PendingRequest = {
	readonly reject: (error: Error) => void;
	readonly resolve: (value: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class BunPluginWorker implements PluginWorkerChannel {
	readonly mode = "worker" as const;
	readonly #options: BunPluginWorkerOptions;
	readonly #pending = new Map<number, PendingRequest>();
	#nextRequestId = 0;
	#started = false;
	#tools: readonly { readonly name: string }[] = [];
	#ui: readonly { readonly id: string }[] = [];
	#worker: Worker | undefined;

	constructor(options: BunPluginWorkerOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		if (this.#worker !== undefined) {
			throw new PluginRegistryError(`Plugin worker ${this.#options.pluginId} is already started`);
		}
		const worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href, {
			type: "module",
		});
		this.#worker = worker;
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(
					new PluginRegistryError(`Plugin worker ${this.#options.pluginId} did not become ready`),
				);
			}, this.#timeoutMs);
			const onMessage = (event: MessageEvent<WorkerResponse>) => {
				const message = event.data;
				if (message.type === "ready") {
					clearTimeout(timeout);
					worker.removeEventListener("message", onMessage);
					this.#tools = message.tools;
					this.#ui = message.ui;
					this.#started = true;
					resolve();
				} else if (message.type === "error") {
					clearTimeout(timeout);
					worker.removeEventListener("message", onMessage);
					reject(new PluginRegistryError(message.error));
				}
			};
			worker.addEventListener("message", onMessage);
		});
		worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
			this.#handleMessage(event.data);
		});
		worker.addEventListener("error", (event) => {
			this.#failAll(new PluginRegistryError(event.message || "Plugin worker crashed"));
		});
		this.#post({
			config: this.#options.config ?? {},
			grantedPermissions: this.#options.grantedPermissions ?? [],
			manifest: this.#options.manifest,
			modulePath: this.#options.modulePath,
			pluginId: this.#options.pluginId,
			type: "init",
		});
		try {
			await ready;
		} catch (error) {
			this.#worker = undefined;
			worker.terminate();
			throw error;
		}
	}

	async stop(): Promise<void> {
		const worker = this.#worker;
		if (worker === undefined) {
			return;
		}
		try {
			if (this.#started) {
				await this.#request("stop", [], 2_000);
			}
		} catch {
			// A crashing or wedged plugin still has to release its worker.
		} finally {
			this.#started = false;
			this.#worker = undefined;
			this.#tools = [];
			this.#ui = [];
			worker.terminate();
			this.#failAll(new PluginRegistryError("Plugin worker stopped"));
		}
	}

	async emitHook(name: PluginHookName, payload: unknown): Promise<void> {
		await this.#request("emitHook", [name, payload]);
	}

	async invokeTool(
		name: string,
		input: Record<string, unknown>,
		context?: { conversationId?: string; userId?: string },
	): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
		const result = await this.#request("invokeTool", [name, input, context]);
		return result as { ok: true; result: unknown } | { ok: false; reason: string };
	}

	listTools(): readonly { name: string }[] {
		return this.#tools;
	}

	listUi(): readonly { id: string }[] {
		return this.#ui;
	}

	get #timeoutMs(): number {
		return this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#handleMessage(message: WorkerResponse): void {
		if (message.type === "error") {
			this.#failAll(new PluginRegistryError(message.error));
			return;
		}
		if (message.type !== "response") {
			return;
		}
		const pending = this.#pending.get(message.id);
		if (pending === undefined) {
			return;
		}
		clearTimeout(pending.timer);
		this.#pending.delete(message.id);
		if (message.ok) {
			pending.resolve(message.result);
		} else {
			pending.reject(new PluginRegistryError(message.error ?? "Plugin worker request failed"));
		}
	}

	#post(message: unknown): void {
		const worker = this.#worker;
		if (worker === undefined) {
			throw new PluginRegistryError("Plugin worker is not started");
		}
		// eslint-disable-next-line unicorn/require-post-message-target-origin
		worker.postMessage(message);
	}

	async #request(
		method: "emitHook" | "invokeTool" | "stop",
		args: readonly unknown[],
		timeoutMs = this.#timeoutMs,
	): Promise<unknown> {
		if (!this.#started && method !== "stop") {
			throw new PluginRegistryError("Plugin worker is not started");
		}
		const id = this.#nextRequestId++;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new PluginRegistryError(`Plugin worker request timed out: ${method}`));
			}, timeoutMs);
			this.#pending.set(id, { reject, resolve, timer });
			try {
				this.#post({ args, id, method, type: "request" });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}
