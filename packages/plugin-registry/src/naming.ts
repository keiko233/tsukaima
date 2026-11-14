export class PluginNamingError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PluginNamingError";
	}
}

/** Stable sanitation used for plugin database file names and legacy object prefixes. */
export function sanitizePluginId(pluginId: string): string {
	const value = pluginId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/gu, "_")
		.replace(/^_+|_+$/gu, "");
	if (value.length === 0) throw new PluginNamingError("Plugin id cannot be sanitized");
	return value;
}

export function pluginSqlPrefix(pluginId: string): string {
	return `plugin_${sanitizePluginId(pluginId)}_`;
}

/**
 * Plugin databases are isolated by file, not by table prefix. The only hard limitation is that a
 * plugin must not attach another database (which would escape its own file).
 */
export function assertPluginSqlIsolated(sql: string, pluginId: string): void {
	if (/\b(?:attach|detach)\b/iu.test(sql)) {
		throw new PluginNamingError(`Plugin ${pluginId} SQL may not attach or detach databases`);
	}
	if (/\bvacuum\s+into\b/iu.test(sql)) {
		throw new PluginNamingError(`Plugin ${pluginId} SQL may not write a database file`);
	}
}
