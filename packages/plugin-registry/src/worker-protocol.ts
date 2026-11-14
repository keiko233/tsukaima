import type { PluginHookName, PluginManifest, PluginPermission } from "@tsukaima/sdk";

export const PLUGIN_WORKER_PROTOCOL_VERSION = "1";
export const PLUGIN_WORKER_HOST_VERSION = "1";

export interface WorkerInitMessage {
	readonly type: "init";
	readonly protocolVersion: string;
	readonly hostVersion: string;
	readonly config: Record<string, unknown>;
	readonly grantedPermissions: readonly PluginPermission[];
	readonly modulePath: string;
	readonly pluginId: string;
	readonly manifest: PluginManifest;
}

export interface WorkerRequestMessage {
	readonly type: "request";
	readonly id: number;
	readonly method: "emitHook" | "invokeTool" | "listTools" | "listUi" | "stop";
	readonly args: readonly unknown[];
}

export interface WorkerCancelMessage {
	readonly type: "cancel";
	readonly id: number;
	readonly reason?: string;
}

export interface WorkerHostCallResponse {
	readonly type: "hostCallResponse";
	readonly id: number;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

export type WorkerParentMessage =
	| WorkerInitMessage
	| WorkerRequestMessage
	| WorkerCancelMessage
	| WorkerHostCallResponse;

export type WorkerResponse =
	| {
			readonly type: "ready";
			readonly protocolVersion: string;
			readonly pluginId: string;
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
	| {
			readonly type: "stream";
			readonly requestId?: number;
			readonly kind: "log" | "progress";
			readonly level?: "trace" | "debug" | "info" | "warn" | "error";
			readonly message: string;
			readonly details?: unknown;
	  }
	| {
			readonly type: "hostCall";
			readonly id: number;
			readonly method: string;
			readonly args: readonly unknown[];
	  }
	| { readonly type: "error"; readonly error: string };

export type WorkerHookName = PluginHookName;
