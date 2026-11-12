const RPC_URL = import.meta.env.VITE_RPC_URL ?? "/rpc";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ConversationRow {
	readonly channelId: string | null;
	readonly createdAt: string;
	readonly durableConversationId: string;
	readonly id: string;
	readonly kind: "private" | "group" | "webui" | "task" | "plugin";
	readonly platformConversationId: string | null;
	readonly status: string;
	readonly title: string | null;
	readonly updatedAt: string;
}

export interface PluginRow {
	readonly apiVersion: string;
	readonly enabled: number;
	readonly id: string;
	readonly kind: "builtin" | "first-party" | "third-party";
	readonly name: string;
	readonly runMode: "host" | "worker";
	readonly version: string;
}

export interface ModelPolicyRow {
	readonly capability: string;
	readonly fallbacksJson: string;
	readonly id: string;
	readonly maxOutputTokens: number | null;
	readonly primaryModel: string;
	readonly primaryProvider: string;
}

export interface DiagnosticsData {
	readonly lastError?: string;
	readonly logLevel: LogLevel;
	readonly onebotConnected: boolean;
	readonly onebotRestartRequired: boolean;
	readonly processedMessages: number;
	readonly routingPolicies: readonly {
		readonly capability: string;
		readonly primary: { readonly modelId: string; readonly providerId: string };
	}[];
	readonly state: {
		readonly reason?: string;
		readonly stage: string;
		readonly startedAtMs: number;
		readonly state: "starting" | "degraded" | "ready" | "maintenance" | "failed";
	};
}

export interface PublicRuntimeSettings {
	readonly logLevel: LogLevel;
	readonly onebotAccessTokenSet: boolean;
	readonly onebotWsUrl?: string;
}

export interface RuntimeSettingsPatch {
	readonly logLevel?: LogLevel;
	readonly onebotAccessToken?: string | null;
	readonly onebotWsUrl?: string | null;
}

interface RpcResponse<T> {
	readonly json?: T;
	readonly error?: { readonly message?: string };
}

async function rpcCall<T>(procedure: string, input?: unknown): Promise<T> {
	const body = input === undefined ? {} : { json: input };
	const response = await fetch(`${RPC_URL}/${procedure}`, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	const text = await response.text();
	let payload: RpcResponse<T> | undefined;
	if (text.length > 0) {
		try {
			payload = JSON.parse(text) as RpcResponse<T>;
		} catch {
			throw new Error(`Invalid RPC response from ${procedure}`);
		}
	}
	if (!response.ok || payload?.error !== undefined) {
		throw new Error(payload?.error?.message ?? `RPC ${procedure} failed (${response.status})`);
	}
	return payload?.json as T;
}

export const api = {
	conversations: {
		list: () => rpcCall<readonly ConversationRow[]>("admin/conversations/list"),
	},
	diagnostics: {
		status: () => rpcCall<DiagnosticsData>("admin/diagnostics/status"),
	},
	modelPolicies: {
		list: () => rpcCall<readonly ModelPolicyRow[]>("admin/modelPolicies/list"),
		set: (input: { capability: string; primaryModel: string; primaryProvider: string }) =>
			rpcCall<readonly unknown[]>("admin/modelPolicies/set", input),
	},
	plugins: {
		list: () => rpcCall<readonly PluginRow[]>("admin/plugins/list"),
	},
	settings: {
		get: () => rpcCall<PublicRuntimeSettings>("admin/settings/get"),
		update: (input: RuntimeSettingsPatch) =>
			rpcCall<PublicRuntimeSettings>("admin/settings/update", input),
	},
};
