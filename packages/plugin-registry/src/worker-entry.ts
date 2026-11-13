import { pathToFileURL } from "node:url";
import {
	createPluginContext,
	pluginManifestSchema,
	PluginRuntime,
	type ElainaPlugin,
	type PluginAuditApi,
	type PluginLogger,
	type PluginStorage,
} from "@elaina/sdk";
import {
	PLUGIN_WORKER_PROTOCOL_VERSION,
	type WorkerHostCallResponse,
	type WorkerInitMessage,
	type WorkerParentMessage,
	type WorkerRequestMessage,
} from "./worker-protocol.ts";

interface WorkerGlobal {
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<WorkerParentMessage>) => void,
	): void;
	close(): void;
	postMessage(message: unknown): void;
}

const workerGlobal = globalThis as unknown as WorkerGlobal;
let runtime: PluginRuntime | undefined;
let activeRequestId: number | undefined;
const controllers = new Map<number, AbortController>();
const hostCallWaiters = new Map<
	number,
	{ readonly reject: (error: Error) => void; readonly resolve: (value: unknown) => void }
>();
let nextHostCallId = 0;

function post(message: unknown): void {
	// eslint-disable-next-line unicorn/require-post-message-target-origin
	workerGlobal.postMessage(message);
}

function postStream(
	kind: "log" | "progress",
	level: "debug" | "info" | "warn" | "error" | undefined,
	message: string,
	details?: unknown,
): void {
	post({
		...(activeRequestId === undefined ? {} : { requestId: activeRequestId }),
		...(details === undefined ? {} : { details }),
		...(level === undefined ? {} : { level }),
		kind,
		message,
		type: "stream",
	});
}

function hostCall(method: string, args: readonly unknown[]): Promise<unknown> {
	const id = nextHostCallId++;
	post({ args, id, method, type: "hostCall" });
	return new Promise<unknown>((resolve, reject) => {
		hostCallWaiters.set(id, { reject, resolve });
	});
}

function createWorkerStorage(): PluginStorage {
	return {
		conversation: {
			get: async <T>(conversationId: string, key: string) =>
				(await hostCall("storage.conversation.get", [conversationId, key])) as T | undefined,
			set: async (conversationId, key, value) => {
				await hostCall("storage.conversation.set", [conversationId, key, value]);
			},
		},
		global: {
			get: async <T>(key: string) => (await hostCall("storage.global.get", [key])) as T | undefined,
			set: async (key, value) => {
				await hostCall("storage.global.set", [value, key]);
			},
		},
	};
}

function createWorkerAudit(): PluginAuditApi {
	return {
		record: async (entry) => {
			await hostCall("audit.record", [entry]);
		},
	};
}

function writeStreamLog(
	level: "debug" | "info" | "warn" | "error",
	message: string,
	details?: unknown,
): void {
	postStream("log", level, message, details);
}

function createWorkerLogger(): PluginLogger {
	return {
		debug: (message, details) => writeStreamLog("debug", message, details),
		error: (message, details) => writeStreamLog("error", message, details),
		info: (message, details) => writeStreamLog("info", message, details),
		warn: (message, details) => writeStreamLog("warn", message, details),
	};
}

async function initialize(message: InitMessageWithProtocol): Promise<void> {
	if (message.protocolVersion !== PLUGIN_WORKER_PROTOCOL_VERSION) {
		throw new Error(
			`Unsupported plugin worker protocol ${message.protocolVersion}; expected ${PLUGIN_WORKER_PROTOCOL_VERSION}`,
		);
	}
	const imported = (await import(pathToFileURL(message.modulePath).href)) as {
		default?: ElainaPlugin;
		plugin?: ElainaPlugin;
	};
	const loaded = imported.plugin ?? imported.default;
	if (loaded === undefined || typeof loaded.setup !== "function") {
		throw new Error(`Plugin module must export a plugin with setup(): ${message.modulePath}`);
	}
	const manifest = pluginManifestSchema.parse(message.manifest);
	const context = createPluginContext({
		audit: createWorkerAudit(),
		config: message.config,
		grantedPermissions: message.grantedPermissions,
		logger: createWorkerLogger(),
		manifest,
		pluginId: message.pluginId,
		storage: createWorkerStorage(),
	});
	runtime = new PluginRuntime({ context, plugin: loaded });
	await runtime.start();
	const bridge = runtime.hostBridge();
	post({
		pluginId: message.pluginId,
		protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
		tools: bridge.listTools().map((tool) => ({ name: tool.name })),
		type: "ready",
		ui: bridge.listUi().map((ui) => ({ id: ui.id })),
	});
}

type InitMessageWithProtocol = WorkerInitMessage;

async function handleRequest(message: WorkerRequestMessage): Promise<void> {
	const controller = new AbortController();
	controllers.set(message.id, controller);
	activeRequestId = message.id;
	try {
		if (runtime === undefined) {
			throw new Error("Plugin worker is not initialized");
		}
		const bridge = runtime.hostBridge();
		let result: unknown;
		if (message.method === "emitHook") {
			await bridge.emitHook(
				message.args[0] as Parameters<typeof bridge.emitHook>[0],
				message.args[1],
			);
		} else if (message.method === "invokeTool") {
			postStream("progress", "info", "tool started");
			const input = message.args[1] as Record<string, unknown>;
			const context = message.args[2] as { conversationId?: string; userId?: string } | undefined;
			result = await bridge.invokeTool(message.args[0] as string, input, {
				...context,
				signal: controller.signal,
			});
			postStream("progress", "info", "tool finished");
		} else if (message.method === "listTools") {
			result = bridge.listTools().map((tool) => ({ name: tool.name }));
		} else if (message.method === "listUi") {
			result = bridge.listUi().map((ui) => ({ id: ui.id }));
		} else {
			await runtime.stop();
			runtime = undefined;
		}
		post({ id: message.id, ok: true, result, type: "response" });
		if (message.method === "stop") {
			workerGlobal.close();
		}
	} catch (error) {
		const aborted = controller.signal.aborted;
		post({
			error: aborted
				? "Plugin worker request cancelled"
				: error instanceof Error
					? error.message
					: String(error),
			id: message.id,
			ok: false,
			type: "response",
		});
	} finally {
		controllers.delete(message.id);
		activeRequestId = undefined;
	}
}

function handleHostCallResponse(message: WorkerHostCallResponse): void {
	const waiter = hostCallWaiters.get(message.id);
	if (waiter === undefined) return;
	hostCallWaiters.delete(message.id);
	if (message.ok) waiter.resolve(message.result);
	else waiter.reject(new Error(message.error ?? "Host call failed"));
}

workerGlobal.addEventListener("message", async (event: MessageEvent<WorkerParentMessage>) => {
	const message = event.data;
	if (message.type === "init") {
		try {
			await initialize(message);
		} catch (error) {
			post({
				error: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		}
		return;
	}
	if (message.type === "cancel") {
		controllers.get(message.id)?.abort(message.reason);
		return;
	}
	if (message.type === "hostCallResponse") {
		handleHostCallResponse(message);
		return;
	}
	await handleRequest(message);
});
