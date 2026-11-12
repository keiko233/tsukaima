import { eq } from "drizzle-orm";
import type { PluginManifest } from "@elaina/sdk";
import { type ElainaDatabase, meta } from "@elaina/db";
import { validatePluginConfig } from "@elaina/plugin-registry";

export type PluginConfigValue = Record<string, unknown>;

export interface PluginConfigView {
	readonly config: PluginConfigValue;
	readonly secretsSet: readonly string[];
}

export interface PluginSettingsStoreOptions {
	readonly database?: ElainaDatabase;
	readonly env: Record<string, string | undefined>;
}

const SETTINGS_PREFIX = "plugin-config:";

function isEmpty(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

/**
 * Per-plugin configuration with declarative environment fallbacks.
 *
 * Resolution order for a key: stored value, then the environment variable named in the
 * manifest's `configEnv` map. Clearing a stored value falls back to the environment again.
 */
export class PluginSettingsStore {
	readonly #database: ElainaDatabase | undefined;
	readonly #env: Record<string, string | undefined>;
	readonly #manifests = new Map<string, PluginManifest>();
	readonly #listeners = new Map<string, Set<(value: PluginConfigValue) => Promise<void> | void>>();

	constructor(options: PluginSettingsStoreOptions) {
		this.#database = options.database;
		this.#env = options.env;
	}

	registerManifest(manifest: PluginManifest): void {
		this.#manifests.set(manifest.name, manifest);
	}

	async read(pluginId: string): Promise<PluginConfigValue> {
		const manifest = this.#manifests.get(pluginId);
		const stored = await this.#readStored(pluginId);
		const resolved: PluginConfigValue = { ...stored };
		for (const [key, envName] of Object.entries(manifest?.configEnv ?? {})) {
			if (!isEmpty(resolved[key])) continue;
			const value = this.#env[envName];
			if (isEmpty(value)) continue;
			resolved[key] = value;
		}
		return resolved;
	}

	async write(pluginId: string, patch: PluginConfigValue): Promise<PluginConfigValue> {
		const manifest = this.#manifests.get(pluginId);
		const stored = await this.#readStored(pluginId);
		const next: PluginConfigValue = { ...stored };
		for (const [key, value] of Object.entries(patch)) {
			if (isEmpty(value)) {
				delete next[key];
			} else {
				next[key] = value;
			}
		}
		validatePluginConfig(manifest?.configSchema, next, pluginId);
		await this.#writeStored(pluginId, next);
		const resolved = await this.read(pluginId);
		for (const listener of this.#listeners.get(pluginId) ?? []) {
			await listener(resolved);
		}
		return resolved;
	}

	onChange(
		pluginId: string,
		handler: (value: PluginConfigValue) => Promise<void> | void,
	): () => void {
		const handlers = this.#listeners.get(pluginId) ?? new Set();
		handlers.add(handler);
		this.#listeners.set(pluginId, handlers);
		return () => {
			handlers.delete(handler);
		};
	}

	async publicView(pluginId: string): Promise<PluginConfigView> {
		const manifest = this.#manifests.get(pluginId);
		const resolved = await this.read(pluginId);
		const secretKeys = new Set(manifest?.secretKeys ?? []);
		const config: PluginConfigValue = {};
		const secretsSet: string[] = [];
		for (const [key, value] of Object.entries(resolved)) {
			if (secretKeys.has(key)) {
				if (!isEmpty(value)) secretsSet.push(key);
				continue;
			}
			config[key] = value;
		}
		return { config, secretsSet };
	}

	async #readStored(pluginId: string): Promise<PluginConfigValue> {
		const database = this.#database;
		if (database === undefined) return {};
		const rows = await database
			.select()
			.from(meta)
			.where(eq(meta.key, `${SETTINGS_PREFIX}${pluginId}`))
			.limit(1);
		const raw = rows[0]?.value;
		if (raw === undefined) return {};
		try {
			const parsed: unknown = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as PluginConfigValue)
				: {};
		} catch {
			return {};
		}
	}

	async #writeStored(pluginId: string, value: PluginConfigValue): Promise<void> {
		const database = this.#database;
		if (database === undefined) return;
		const key = `${SETTINGS_PREFIX}${pluginId}`;
		if (Object.keys(value).length === 0) {
			await database.delete(meta).where(eq(meta.key, key));
			return;
		}
		await database
			.insert(meta)
			.values({ key, value: JSON.stringify(value) })
			.onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } });
	}
}
