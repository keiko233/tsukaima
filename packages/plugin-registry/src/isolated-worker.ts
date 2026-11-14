import type {
	PluginAuditApi,
	PluginHookName,
	PluginManifest,
	PluginPermission,
	PluginStorage,
} from "@tsukaima/sdk";
import { PluginRegistryError } from "./registry.ts";
import type { PluginWorkerChannel } from "./worker.ts";
import {
	PLUGIN_WORKER_HOST_VERSION,
	PLUGIN_WORKER_PROTOCOL_VERSION,
	type WorkerHostCallResponse,
	type WorkerParentMessage,
	type WorkerResponse,
} from "./worker-protocol.ts";

export interface BunPluginWorkerLog {
	readonly pluginId: string;
	readonly requestId?: number;
	readonly kind: "log" | "progress";
	readonly level?: "trace" | "debug" | "info" | "warn" | "error";
	readonly message: string;
	readonly details?: unknown;
}

export interface BunPluginWorkerOptions {
	readonly config?: Record<string, unknown>;
	readonly grantedPermissions?: readonly PluginPermission[];
	readonly manifest: PluginManifest;
	readonly modulePath: string;
	readonly pluginId: string;
	readonly requestTimeoutMs?: number;
	readonly startupTimeoutMs?: number;
	/** Host-mediated capabilities; workers never receive direct database handles. */
	readonly host?: {
		readonly audit?: PluginAuditApi;
		readonly storage?: PluginStorage;
	};
	readonly hostCall?: (method: string, args: readonly unknown[]) => Promise<unknown> | unknown;
	readonly maxInFlight?: number;
	readonly maxQueuedRequests?: number;
	readonly maxRestarts?: number;
	readonly restartDelayMs?: number;
	readonly onLog?: (entry: BunPluginWorkerLog) => void;
	readonly onProgress?: (entry: BunPluginWorkerLog) => void;
	readonly onCrash?: (error: Error, restarts: number) => void;
}

type PendingRequest = {
	readonly reject: (error: Error) => void;
	readonly resolve: (value: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

type SlotWaiter = {
	readonly reject: (error: Error) => void;
	readonly resolve: (release: () => void) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_QUEUED = 64;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 100;

export class BunPluginWorker implements PluginWorkerChannel {
	readonly mode = "worker" as const;
	readonly #options: BunPluginWorkerOptions;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #hostCalls = new Map<
		number,
		{ readonly reject: (error: Error) => void; readonly resolve: (value: unknown) => void }
	>();
	readonly #slots: SlotWaiter[] = [];
	#nextRequestId = 0;
	#activeRequests = 0;
	#started = false;
	#stopping = false;
	#restarts = 0;
	#restartTimer: ReturnType<typeof setTimeout> | undefined;
	#tools: readonly { readonly name: string }[] = [];
	#ui: readonly { readonly id: string }[] = [];
	#worker: Worker | undefined;

	constructor(options: BunPluginWorkerOptions) {
		this.#options = options;
	}

	get restarts(): number {
		return this.#restarts;
	}

	get pendingRequests(): number {
		return this.#pending.size;
	}

	async start(): Promise<void> {
		if (this.#worker !== undefined) {
			throw new PluginRegistryError(`Plugin worker ${this.#options.pluginId} is already started`);
		}
		this.#stopping = false;
		this.#restarts = 0;
		await this.#spawn();
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#restartTimer !== undefined) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}
		const worker = this.#worker;
		if (worker === undefined) {
			this.#failAll(new PluginRegistryError("Plugin worker stopped"));
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
			this.#failHostCalls(new PluginRegistryError("Plugin worker stopped"));
		}
	}

	async emitHook(name: PluginHookName, payload: unknown): Promise<void> {
		await this.#request("emitHook", [name, payload]);
	}

	async invokeTool(
		name: string,
		input: Record<string, unknown>,
		context?: { conversationId?: string; userId?: string; signal?: AbortSignal },
	): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
		const { signal, ...wireContext } = context ?? {};
		const result = await this.#request(
			"invokeTool",
			[name, input, context === undefined ? undefined : wireContext],
			this.#timeoutMs,
			signal,
		);
		return result as { ok: true; result: unknown } | { ok: false; reason: string };
	}

	/** Cancel one in-flight request by id. */
	cancel(id: number, reason = "cancelled by host"): boolean {
		const pending = this.#pending.get(id);
		if (pending === undefined) return false;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		this.#post({ id, reason, type: "cancel" });
		pending.reject(new PluginRegistryError(`Plugin worker request ${reason}`));
		return true;
	}

	cancelAll(reason = "cancelled by host"): void {
		for (const id of this.#pending.keys()) this.cancel(id, reason);
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

	get #maxInFlight(): number {
		return Math.max(1, this.#options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
	}

	get #maxQueued(): number {
		return Math.max(0, this.#options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED);
	}

	async #spawn(): Promise<void> {
		const worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href, {
			type: "module",
		});
		this.#worker = worker;
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(
					new PluginRegistryError(`Plugin worker ${this.#options.pluginId} did not become ready`),
				);
			}, this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
			const onMessage = (event: MessageEvent<WorkerResponse>) => {
				const message = event.data;
				if (message.type === "ready") {
					clearTimeout(timeout);
					worker.removeEventListener("message", onMessage);
					if (message.protocolVersion !== PLUGIN_WORKER_PROTOCOL_VERSION) {
						reject(
							new PluginRegistryError(
								`Plugin worker protocol mismatch: ${message.protocolVersion} != ${PLUGIN_WORKER_PROTOCOL_VERSION}`,
							),
						);
						return;
					}
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
			this.#handleCrash(new PluginRegistryError(event.message || "Plugin worker crashed"));
		});
		const init: WorkerParentMessage = {
			config: this.#options.config ?? {},
			grantedPermissions: this.#options.grantedPermissions ?? this.#options.manifest.permissions,
			hostVersion: PLUGIN_WORKER_HOST_VERSION,
			manifest: this.#options.manifest,
			modulePath: this.#options.modulePath,
			pluginId: this.#options.pluginId,
			protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
			type: "init",
		};
		this.#post(init);
		try {
			await ready;
		} catch (error) {
			this.#worker = undefined;
			worker.terminate();
			throw error;
		}
	}

	#handleCrash(error: Error): void {
		if (this.#stopping) return;
		const worker = this.#worker;
		this.#worker = undefined;
		this.#started = false;
		this.#tools = [];
		this.#ui = [];
		worker?.terminate();
		this.#failAll(error);
		this.#failHostCalls(error);
		this.#releaseQueued(error);
		if (this.#restarts >= (this.#options.maxRestarts ?? DEFAULT_MAX_RESTARTS)) {
			this.#options.onCrash?.(error, this.#restarts);
			return;
		}
		this.#restarts += 1;
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			if (this.#stopping) return;
			void this.#spawn().catch((restartError: unknown) => {
				this.#handleCrash(
					restartError instanceof Error ? restartError : new Error(String(restartError)),
				);
			});
		}, this.#options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS);
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#failHostCalls(error: Error): void {
		for (const pending of this.#hostCalls.values()) pending.reject(error);
		this.#hostCalls.clear();
	}

	#releaseQueued(error: Error): void {
		for (const waiter of this.#slots.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	#handleMessage(message: WorkerResponse): void {
		if (message.type === "error") {
			this.#failAll(new PluginRegistryError(message.error));
			return;
		}
		if (message.type === "stream") {
			const entry: BunPluginWorkerLog = {
				...(message.details === undefined ? {} : { details: message.details }),
				...(message.level === undefined ? {} : { level: message.level }),
				kind: message.kind,
				message: message.message,
				pluginId: this.#options.pluginId,
				...(message.requestId === undefined ? {} : { requestId: message.requestId }),
			};
			if (message.kind === "progress") this.#options.onProgress?.(entry);
			else this.#options.onLog?.(entry);
			return;
		}
		if (message.type === "hostCall") {
			void this.#handleHostCall(message);
			return;
		}
		if (message.type !== "response") return;
		const pending = this.#pending.get(message.id);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		this.#pending.delete(message.id);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new PluginRegistryError(message.error ?? "Plugin worker request failed"));
	}

	async #handleHostCall(message: {
		readonly id: number;
		readonly method: string;
		readonly args: readonly unknown[];
	}): Promise<void> {
		const respond = (response: Omit<WorkerHostCallResponse, "id" | "type">) => {
			this.#post({
				...response,
				id: message.id,
				type: "hostCallResponse",
			} satisfies WorkerHostCallResponse);
		};
		try {
			let result: unknown;
			if (this.#options.hostCall !== undefined) {
				result = await this.#options.hostCall(message.method, message.args);
			} else {
				result = await this.#routeHostCall(message.method, message.args);
			}
			respond({ ok: true, result });
		} catch (error) {
			respond({ error: error instanceof Error ? error.message : String(error), ok: false });
		}
	}

	async #routeHostCall(method: string, args: readonly unknown[]): Promise<unknown> {
		const storage = this.#options.host?.storage;
		const audit = this.#options.host?.audit;
		switch (method) {
			case "storage.global.get":
				if (storage === undefined) throw new Error("Durable host storage is unavailable");
				return await storage.global.get(String(args[0]));
			case "storage.global.set":
				if (storage === undefined) throw new Error("Durable host storage is unavailable");
				return await storage.global.set(String(args[1]), args[0]);
			case "storage.conversation.get":
				if (storage === undefined) throw new Error("Durable host storage is unavailable");
				return await storage.conversation.get(String(args[0]), String(args[1]));
			case "storage.conversation.set":
				if (storage === undefined) throw new Error("Durable host storage is unavailable");
				return await storage.conversation.set(String(args[0]), String(args[1]), args[2]);
			case "audit.record":
				if (audit === undefined) throw new Error("Host audit is unavailable");
				return await audit.record(args[0] as Parameters<PluginAuditApi["record"]>[0]);
			default:
				throw new Error(`Unsupported host call ${method}`);
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

	async #acquireSlot(): Promise<() => void> {
		if (this.#activeRequests < this.#maxInFlight) {
			this.#activeRequests += 1;
			return this.#releaseOnce();
		}
		if (this.#slots.length >= this.#maxQueued) {
			throw new PluginRegistryError("Plugin worker request queue is full");
		}
		return await new Promise<() => void>((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.#slots.findIndex((waiter) => waiter.resolve === resolve);
				if (index !== -1) this.#slots.splice(index, 1);
				reject(new PluginRegistryError("Plugin worker request queue timed out"));
			}, this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
			this.#slots.push({ reject, resolve, timer });
		});
	}

	#releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#slots.shift();
			if (next === undefined) {
				this.#activeRequests -= 1;
				return;
			}
			clearTimeout(next.timer);
			next.resolve(this.#releaseOnce());
		};
	}

	async #request(
		method: "emitHook" | "invokeTool" | "stop",
		args: readonly unknown[],
		timeoutMs = this.#timeoutMs,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (!this.#started && method !== "stop") {
			throw new PluginRegistryError("Plugin worker is not started");
		}
		const release = await this.#acquireSlot();
		if (signal?.aborted === true) {
			release();
			throw new PluginRegistryError("Plugin worker request cancelled");
		}
		const id = this.#nextRequestId++;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.cancel(id, "timed out");
				reject(new PluginRegistryError(`Plugin worker request timed out: ${method}`));
			}, timeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				this.cancel(id, "cancelled");
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(id, {
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				timer,
			});
			try {
				this.#post({ args, id, method, type: "request" });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		}).finally(release);
	}
}
