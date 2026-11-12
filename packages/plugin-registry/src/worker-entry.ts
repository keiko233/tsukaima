import { pathToFileURL } from "node:url";
import {
	createPluginContext,
	pluginManifestSchema,
	PluginRuntime,
	type TsukaimaPlugin,
	type PluginManifest,
	type PluginPermission,
} from "@tsukaima/sdk";

interface InitMessage {
	readonly type: "init";
	readonly config: Record<string, unknown>;
	readonly grantedPermissions: readonly PluginPermission[];
	readonly modulePath: string;
	readonly pluginId: string;
	readonly manifest: PluginManifest;
}

interface RequestMessage {
	readonly type: "request";
	readonly id: number;
	readonly method: "emitHook" | "invokeTool" | "stop";
	readonly args: readonly unknown[];
}

type ParentMessage = InitMessage | RequestMessage;

interface WorkerGlobal {
	addEventListener(type: "message", listener: (event: MessageEvent<ParentMessage>) => void): void;
	close(): void;
	postMessage(message: unknown): void;
}

const workerGlobal = globalThis as unknown as WorkerGlobal;
let runtime: PluginRuntime | undefined;

function post(message: unknown): void {
	// eslint-disable-next-line unicorn/require-post-message-target-origin
	workerGlobal.postMessage(message);
}

async function initialize(message: InitMessage): Promise<void> {
	const imported = (await import(pathToFileURL(message.modulePath).href)) as {
		default?: TsukaimaPlugin;
		plugin?: TsukaimaPlugin;
	};
	const loaded = imported.plugin ?? imported.default;
	if (loaded === undefined || typeof loaded.setup !== "function") {
		throw new Error(`Plugin module must export a plugin with setup(): ${message.modulePath}`);
	}
	const manifest = pluginManifestSchema.parse(message.manifest);
	const context = createPluginContext({
		config: message.config,
		grantedPermissions: message.grantedPermissions,
		manifest,
		pluginId: message.pluginId,
	});
	runtime = new PluginRuntime({ context, plugin: loaded });
	await runtime.start();
	const bridge = runtime.hostBridge();
	post({
		tools: bridge.listTools().map((tool) => ({ name: tool.name })),
		type: "ready",
		ui: bridge.listUi().map((ui) => ({ id: ui.id })),
	});
}

async function handleRequest(message: RequestMessage): Promise<void> {
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
			result = await bridge.invokeTool(
				message.args[0] as string,
				message.args[1] as Record<string, unknown>,
				message.args[2] as { conversationId?: string; userId?: string } | undefined,
			);
		} else {
			await runtime.stop();
			runtime = undefined;
		}
		post({ id: message.id, ok: true, result, type: "response" });
		if (message.method === "stop") {
			workerGlobal.close();
		}
	} catch (error) {
		post({
			error: error instanceof Error ? error.message : String(error),
			id: message.id,
			ok: false,
			type: "response",
		});
	}
}

workerGlobal.addEventListener("message", async (event: MessageEvent<ParentMessage>) => {
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
	await handleRequest(message);
});
