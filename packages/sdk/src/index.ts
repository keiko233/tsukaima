export {
	assertPermission,
	hasPermission,
	permissionMatches,
	toolRequiresPermission,
} from "./permissions.ts";
export { pluginPermissionSchema } from "./manifest.ts";
export { PluginRuntime } from "./runtime.ts";
export { pluginManifestSchema } from "./manifest.ts";
export type {
	PluginChannelApi,
	PluginContext,
	PluginEvents,
	PluginHook,
	PluginHookName,
	PluginLogger,
	PluginManifest,
	PluginPermission,
	PluginStorage,
	PluginTool,
	PluginToolRegistry,
	PluginUiRegistry,
	ToolInvocationContext,
	ToolResult,
} from "./types.ts";
export {
	createPluginContext,
	LocalPluginEventBridge,
	LocalToolBridge,
	LocalUiBridge,
} from "./bridges.ts";
