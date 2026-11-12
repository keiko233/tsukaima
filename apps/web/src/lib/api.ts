const RPC_URL = import.meta.env.VITE_RPC_URL ?? "/rpc";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };

export interface LogSpan {
	readonly fields: Record<string, LogValue>;
	readonly name: string;
}

export interface LogEntry {
	readonly ansi: string;
	readonly fields: Record<string, LogValue>;
	readonly id: number;
	readonly level: LogLevel;
	readonly message: string;
	readonly span: LogSpan | null;
	readonly target: string;
	readonly text: string;
	readonly timestamp: string;
}

export interface LogSnapshot {
	readonly capacity: number;
	readonly dropped: number;
	readonly entries: readonly LogEntry[];
}

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

export type ChatKind = "private" | "group" | "webui" | "task" | "plugin";
export type DeliveryStatus = "received" | "pending" | "accepted" | "sent" | "failed" | "uncertain";

export interface MessagePart {
	readonly sha256?: string;
	readonly text?: string;
	readonly type: "text" | "image" | "sticker";
}

export interface MessageSummary {
	readonly contentText: string;
	readonly deliveryStatus: DeliveryStatus;
	readonly direction: "inbound" | "outbound" | "system";
	readonly id: string;
	readonly kind: string;
	readonly occurredAt: string;
	readonly parts: readonly MessagePart[];
	readonly platformMessageId: string | null;
	readonly replyToMessageId: string | null;
	readonly senderDisplayName: string;
	readonly senderExternalId: string | null;
	readonly senderKind: "human" | "bot" | "assistant" | "system";
}

export interface SessionSummary {
	readonly createdAt: string;
	readonly id: string;
	readonly isReceiving: boolean;
	readonly kind: string;
	readonly latestMessage: MessageSummary | null;
	readonly status: string;
	readonly title: string;
	readonly updatedAt: string;
}

export interface ChatSummary {
	readonly channelId: string | null;
	readonly createdAt: string;
	readonly id: string;
	readonly kind: ChatKind;
	readonly pinned: boolean;
	readonly platformConversationId: string | null;
	readonly sessions: readonly SessionSummary[];
	readonly status: string;
	readonly title: string;
	readonly updatedAt: string;
}

export interface SessionDetail {
	readonly channelId: string | null;
	readonly chat: {
		readonly id: string;
		readonly kind: ChatKind;
		readonly platformConversationId: string | null;
		readonly status: string;
		readonly title: string;
	};
	readonly createdAt: string;
	readonly id: string;
	readonly isReceiving: boolean;
	readonly kind: string;
	readonly status: string;
	readonly title: string;
	readonly updatedAt: string;
}

export interface UserSummary {
	readonly displayName: string;
	readonly id: string;
	readonly identities: readonly {
		readonly displayName: string | null;
		readonly externalId: string;
		readonly id: string;
		readonly platform: string;
		readonly platformAccountId: string;
	}[];
	readonly kind: "human" | "bot" | "system";
	readonly notes: string | null;
	readonly preferredName: string | null;
	readonly trustLevel: string;
}

export interface UserDetail extends UserSummary {
	readonly aliases: readonly string[];
	readonly chats: readonly {
		readonly id: string;
		readonly kind: ChatKind;
		readonly platformConversationId: string | null;
		readonly sessions: readonly {
			readonly id: string;
			readonly isReceiving: number;
			readonly status: string;
			readonly title: string | null;
		}[];
		readonly title: string;
	}[];
	readonly groups: readonly {
		readonly id: string;
		readonly title: string;
	}[];
}

export interface GroupSummary {
	readonly channelId: string | null;
	readonly createdAt: string;
	readonly id: string;
	readonly memberCount: number;
	readonly platformConversationId: string | null;
	readonly sessionCount: number;
	readonly status: string;
	readonly title: string;
	readonly updatedAt: string;
}

export interface GroupDetail extends GroupSummary {
	readonly members: readonly {
		readonly displayName: string;
		readonly platformRole: string | null;
		readonly role: string;
		readonly userId: string;
	}[];
	readonly sessions: readonly {
		readonly id: string;
		readonly isReceiving: number;
		readonly status: string;
		readonly title: string | null;
	}[];
}

export interface RequestRow {
	readonly accountId: string;
	readonly channelId: string;
	readonly comment: string | null;
	readonly createdAt: string;
	readonly errorMessage: string | null;
	readonly flag: string;
	readonly groupExternalId: string | null;
	readonly id: string;
	readonly kind: "friend" | "group-add" | "group-invite";
	readonly requesterDisplayName: string | null;
	readonly requesterExternalId: string;
	readonly resolutionAction: "approve" | "reject" | null;
	readonly resolutionReason: string | null;
	readonly resolvedAt: string | null;
	readonly status: "pending" | "approved" | "rejected" | "failed" | "uncertain";
	readonly subType: string | null;
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
	readonly channels: readonly {
		readonly connected: boolean;
		readonly eventCount: number;
		readonly id: string;
		readonly kind: string;
		readonly lastErrorClass: string | null;
		readonly reconnectAttempts: number;
		readonly state: "connecting" | "open" | "closed" | "reconnecting";
	}[];
	readonly lastError?: string;
	readonly logLevel: LogLevel;
	readonly onebotConfigured: boolean;
	readonly onebotConnected: boolean;
	readonly onebotLastErrorClass: string | null;
	readonly onebotReconnectAttempts: number;
	readonly onebotState: "connecting" | "open" | "closed" | "reconnecting";
	readonly onebotRestartRequired: boolean;
	readonly processedMessages: number;
	readonly providerRestartRequired: boolean;
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
	readonly usage: readonly {
		readonly capability: string;
		readonly inputTokens: number;
		readonly modelId: string;
		readonly outputTokens: number;
		readonly providerId: string;
	}[];
	readonly usageTotals: {
		readonly inputTokens: number;
		readonly outputTokens: number;
	};
}

export interface PublicRuntimeSettings {
	readonly logLevel: LogLevel;
	readonly openAiApiKeySet: boolean;
	readonly openAiBaseUrl?: string;
	readonly openAiModelId?: string;
	readonly onebotAccessTokenSet: boolean;
	readonly onebotWsUrl?: string;
}

export interface RemoteModel {
	readonly id: string;
	readonly ownedBy?: string;
}

export interface RemoteModelList {
	readonly baseUrl: string;
	readonly models: readonly RemoteModel[];
}

export interface RuntimeSettingsPatch {
	readonly logLevel?: LogLevel;
	readonly openAiApiKey?: string | null;
	readonly openAiBaseUrl?: string | null;
	readonly openAiModelId?: string | null;
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
	chats: {
		createLocal: (input: { sessionTitle: string; title: string }) =>
			rpcCall<{ chatId: string; sessionId: string }>("admin/chats/createLocal", input),
		list: (input: { status?: "active" | "archived" | "all" } = {}) =>
			rpcCall<readonly ChatSummary[]>("admin/chats/list", input),
	},
	conversations: {
		list: () => rpcCall<readonly ConversationRow[]>("admin/conversations/list"),
	},
	diagnostics: {
		clearLogs: () => rpcCall<{ cleared: number }>("admin/diagnostics/clearLogs"),
		logs: () => rpcCall<LogSnapshot>("admin/diagnostics/logs"),
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
	groups: {
		get: (groupId: string) => rpcCall<GroupDetail | null>("admin/groups/get", { groupId }),
		list: () => rpcCall<readonly GroupSummary[]>("admin/groups/list"),
	},
	requests: {
		get: (requestId: string) => rpcCall<RequestRow | null>("admin/requests/get", { requestId }),
		list: (status: "all" | "pending" | "processed" = "all") =>
			rpcCall<readonly RequestRow[]>("admin/requests/list", { status }),
		respond: (input: { action: "approve" | "reject"; reason?: string; requestId: string }) =>
			rpcCall<RequestRow>("admin/requests/respond", input),
	},
	sessions: {
		create: (input: { chatObjectId: string; title: string }) =>
			rpcCall<{ id: string }>("admin/sessions/create", input),
		get: (sessionId: string) => rpcCall<SessionDetail | null>("admin/sessions/get", { sessionId }),
		messages: (sessionId: string) =>
			rpcCall<readonly MessageSummary[]>("admin/sessions/messages", { sessionId }),
		send: (input: { sessionId: string; target: "channel" | "elaina"; text: string }) =>
			rpcCall<MessageSummary>("admin/sessions/send", input),
		setReceiving: (sessionId: string) =>
			rpcCall<{ ok: true }>("admin/sessions/setReceiving", { sessionId }),
		update: (input: { sessionId: string; status?: "active" | "archived"; title?: string }) =>
			rpcCall<{ ok: true }>("admin/sessions/update", input),
	},
	settings: {
		get: () => rpcCall<PublicRuntimeSettings>("admin/settings/get"),
		models: (input: { apiKey?: string; baseUrl?: string } = {}) =>
			rpcCall<RemoteModelList>("admin/settings/models", input),
		update: (input: RuntimeSettingsPatch) =>
			rpcCall<PublicRuntimeSettings>("admin/settings/update", input),
	},
	users: {
		get: (userId: string) => rpcCall<UserDetail | null>("admin/users/get", { userId }),
		list: () => rpcCall<readonly UserSummary[]>("admin/users/list"),
	},
};
