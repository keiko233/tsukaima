import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const ACP_PLUGIN_ID = "acp";
export const ACP_PROVIDER_PREFIX = "acp";
export const ACP_PATHS_BINDING = "acp.paths";
export const ACP_PROBE_RPC = "acp.probe";
export const ACP_RUNTIME_STATUS_RPC = "acp.runtime.status";
export const ACP_RUNTIME_INSTALL_RPC = "acp.runtime.install";
export const ACP_RUNTIME_UNINSTALL_RPC = "acp.runtime.uninstall";
export const ACP_AUTH_STATUS_RPC = "acp.auth.status";
export const ACP_AUTH_LOGIN_START_RPC = "acp.auth.loginStart";
export const ACP_AUTH_LOGIN_POLL_RPC = "acp.auth.loginPoll";
export const ACP_AUTH_LOGIN_CANCEL_RPC = "acp.auth.loginCancel";

const acpModelJsonSchema = {
	properties: {
		capabilities: { items: { type: "string" }, type: "array" },
		contextWindow: { type: "integer" },
		defaultReasoningLevel: { type: "string" },
		enabled: { type: "boolean" },
		id: { type: "string" },
		maxOutputTokens: { type: "integer" },
		name: { type: "string" },
		reasoningLevels: { items: { type: "string" }, type: "array" },
		supportsAudio: { type: "boolean" },
		supportsImage: { type: "boolean" },
		supportsImageGeneration: { type: "boolean" },
		supportsReasoning: { type: "boolean" },
		supportsSidechat: { type: "boolean" },
		supportsTools: { type: "boolean" },
		supportsVideoGeneration: { type: "boolean" },
	},
	type: "object",
} as const;

export const acpManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		artifactsRootDir: "TSUKAIMA_ACP_ARTIFACTS_DIR",
		toolsRootDir: "TSUKAIMA_ACP_TOOLS_DIR",
	},
	configSchema: {
		properties: {
			artifactsRootDir: { type: "string" },
			profileEnvSecrets: {
				additionalProperties: {
					additionalProperties: { type: "string" },
					type: "object",
				},
				type: "object",
			},
			profiles: {
				items: {
					properties: {
						allowedCapabilityChat: { type: "boolean" },
						args: { items: { type: "string" }, type: "array" },
						command: { type: "string" },
						cwd: { type: "string" },
						enableAsModelProvider: { type: "boolean" },
						enabled: { type: "boolean" },
						env: { additionalProperties: { type: "string" }, type: "object" },
						id: { type: "string" },
						idleTtlMs: { type: "integer" },
						models: { items: acpModelJsonSchema, type: "array" },
						name: { type: "string" },
						preset: {
							enum: ["antigravity", "codex", "claude-code", "custom"],
							type: "string",
						},
						requestTimeoutMs: { type: "integer" },
						supportsCapabilityTool: { type: "boolean" },
						supportsImageGeneration: { type: "boolean" },
						supportsVideoGeneration: { type: "boolean" },
						toolBridgeMode: {
							enum: ["disabled", "mcp-bridge", "prompt-json"],
							type: "string",
						},
					},
					type: "object",
				},
				type: "array",
			},
			toolsRootDir: { type: "string" },
		},
		type: "object",
	},
	kind: "builtin",
	name: ACP_PLUGIN_ID,
	permissions: [
		"ui.panel",
		"model.call",
		"settings",
		"media.read",
		"media.write",
		"channel.send",
		"audit.write",
	],
	secretKeys: ["profileEnvSecrets"],
	version: "0.1.0",
});
