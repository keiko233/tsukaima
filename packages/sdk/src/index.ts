export {
	assertPermission,
	hasPermission,
	permissionMatches,
	toolRequiresPermission,
} from "./permissions.ts";
export { pluginPermissionSchema } from "./manifest.ts";
export { PluginRuntime } from "./runtime.ts";
export type { ElainaPlugin, PluginPrepare, PluginSetup, PluginTeardown } from "./runtime.ts";
export { pluginManifestSchema } from "./manifest.ts";
export type {
	PluginChannelApi,
	PluginContext,
	PluginEvents,
	PluginHook,
	PluginHookName,
	PluginLogger,
	PluginModelDescriptor,
	PluginModelInfo,
	PluginModelInputModality,
	PluginModelPort,
	PluginModelProvider,
	PluginModelQuery,
	PluginModelReasoning,
	PluginModelReasoningLevel,
	PluginModelRegistry,
	PluginRpcHandler,
	PluginRpcRegistry,
	PluginStorage,
	PluginTool,
	PluginToolExecutionApi,
	PluginToolInvocationResult,
	PluginToolRegistration,
	PluginToolRegistry,
	PluginToolsExtension,
	PluginUiRegistry,
	PluginStatusListener,
	ToolInvocationContext,
	ToolResult,
} from "./types.ts";
export type { PluginManifest } from "./manifest.ts";
export type { PluginPermission } from "./permissions.ts";
export type {
	AuditEntry,
	ChannelAdapter,
	ChannelCapability,
	ChannelDiagnostics,
	ChannelHistoryItem,
	ChannelHistoryOptions,
	ChannelRequestDecision,
	OutboundTarget,
	SendOptions,
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginRequestApi,
	PluginSettingsApi,
	SendResult,
} from "./host.ts";
export {
	createPluginContext,
	createPluginToolsExtension,
	collectPluginModels,
	LocalPluginEventBridge,
	LocalModelRegistry,
	LocalRpcBridge,
	LocalToolBridge,
	LocalUiBridge,
	PLUGIN_TOOLS_EXTENSION_NAME,
	providerSafeToolName,
	type PluginToolsExtensionOptions,
} from "./bridges.ts";
