import type { PluginPermission } from "./types.ts";

export function permissionMatches(granted: PluginPermission, required: PluginPermission): boolean {
	if (granted === required || granted === "*") {
		return true;
	}
	if (granted.endsWith(".*")) {
		const prefix = granted.slice(0, -2);
		return required.startsWith(`${prefix}.`);
	}
	return false;
}

export function hasPermission(
	granted: readonly PluginPermission[],
	required: PluginPermission,
): boolean {
	return granted.some((permission) => permissionMatches(permission, required));
}

export class PermissionDeniedError extends Error {
	constructor(required: PluginPermission, pluginId: string) {
		super(`Plugin ${pluginId} is not granted permission ${required}`);
		this.name = "PermissionDeniedError";
	}
}

export function assertPermission(
	granted: readonly PluginPermission[],
	required: PluginPermission,
	pluginId: string,
): void {
	if (!hasPermission(granted, required)) {
		throw new PermissionDeniedError(required, pluginId);
	}
}

export function toolRequiresPermission(
	required: readonly PluginPermission[],
	permission: PluginPermission,
): boolean {
	return required.includes(permission);
}
