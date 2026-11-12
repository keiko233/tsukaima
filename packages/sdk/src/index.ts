export {
	assertPermission,
	hasPermission,
	permissionMatches,
	toolRequiresPermission,
} from "./permissions.ts";
export { pluginPermissionSchema } from "./manifest.ts";
export { PluginRuntime } from "./runtime.ts";
export type { ElainaPlugin, PluginSetup, PluginTeardown } from "./runtime.ts";
export { pluginManifestSchema } from "./manifest.ts";
export type {
	PluginChannelApi,
	PluginContext,
	PluginEvents,
	PluginHook,
	PluginHookName,
	PluginLogger,
	PluginStorage,
	PluginTool,
	PluginToolRegistry,
	PluginUiRegistry,
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
	ChannelRequestDecision,
	OutboundTarget,
	PluginAuditApi,
	PluginChannelRegistry,
	PluginDependencyBag,
	PluginRequestApi,
	PluginSettingsApi,
	SendResult,
} from "./host.ts";
export {
	createPluginContext,
	LocalPluginEventBridge,
	LocalToolBridge,
	LocalUiBridge,
} from "./bridges.ts";
