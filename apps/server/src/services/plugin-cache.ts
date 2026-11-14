import type { KeyvCache } from "@elaina/cache";
import {
	hasPermission,
	type PluginCacheApi,
	type PluginCacheSetOptions,
	type PluginPermission,
} from "@elaina/sdk";

const CACHE_PERMISSIONS = ["cache.read", "cache.write", "cache.publish"] as const;

function requirePermission(
	granted: readonly PluginPermission[],
	pluginId: string,
	required: string,
): void {
	if (!hasPermission(granted, required)) {
		throw new Error(`Plugin ${pluginId} is not granted permission ${required}`);
	}
}

/**
 * Per-plugin view of the host KV cache.
 *
 * Keys are prefixed so one plugin can never read or clear another plugin's entries, and
 * channels are prefixed the same way. The bridge is only constructed when the manifest grants
 * at least one `cache.*` permission; each method still checks its own permission so a plugin
 * with read-only access cannot write.
 */
export function createPluginCacheBridge(
	cache: KeyvCache,
	pluginId: string,
	granted: readonly PluginPermission[],
): PluginCacheApi | undefined {
	if (!CACHE_PERMISSIONS.some((permission) => hasPermission(granted, permission))) {
		return undefined;
	}
	const keyPrefix = `plugin:${pluginId}:`;
	const channelPrefix = `plugin.${pluginId}.`;
	return {
		get: async <T = unknown>(key: string): Promise<T | undefined> => {
			requirePermission(granted, pluginId, "cache.read");
			return await cache.get<T>(`${keyPrefix}${key}`);
		},
		set: async (
			key: string,
			value: unknown,
			options: PluginCacheSetOptions = {},
		): Promise<void> => {
			requirePermission(granted, pluginId, "cache.write");
			await cache.set(`${keyPrefix}${key}`, value, options);
		},
		delete: async (key: string): Promise<boolean> => {
			requirePermission(granted, pluginId, "cache.write");
			return await cache.delete(`${keyPrefix}${key}`);
		},
		has: async (key: string): Promise<boolean> => {
			requirePermission(granted, pluginId, "cache.read");
			return await cache.has(`${keyPrefix}${key}`);
		},
		getOrSet: async <T = unknown>(
			key: string,
			factory: () => Promise<T> | T,
			options: PluginCacheSetOptions = {},
		): Promise<T> => {
			requirePermission(granted, pluginId, "cache.read");
			requirePermission(granted, pluginId, "cache.write");
			return await cache.getOrSet(`${keyPrefix}${key}`, factory, options);
		},
		publish: async (channel: string, payload: unknown): Promise<void> => {
			requirePermission(granted, pluginId, "cache.publish");
			await cache.publish(`${channelPrefix}${channel}`, payload);
		},
		subscribe: (channel: string, handler: (payload: unknown) => void): (() => void) => {
			requirePermission(granted, pluginId, "cache.read");
			return cache.subscribe(`${channelPrefix}${channel}`, handler);
		},
	};
}
