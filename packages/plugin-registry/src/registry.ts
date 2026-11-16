import { readFile } from "node:fs/promises";
import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk";
import type { PluginMigration } from "./migrations.ts";
import { validatePluginConfig } from "./config.ts";

export type PluginRunMode = "host" | "worker";

export interface InstalledPlugin {
	config: Record<string, unknown>;
	enabled: boolean;
	grantedPermissions: readonly string[];
	manifest: PluginManifest;
	runMode: PluginRunMode;
}

export interface InstallPluginOptions {
	config?: Record<string, unknown>;
	enabled?: boolean;
	grantedPermissions?: readonly string[];
	/** Plugin package root, used to resolve manifest-declared migration files. */
	rootDir?: string;
	/** Explicit migrations, overriding the manifest's migration directory. */
	migrations?: readonly PluginMigration[];
	runMode?: PluginRunMode;
}

export class PluginRegistryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PluginRegistryError";
	}
}

export class PluginRegistry {
	readonly #plugins = new Map<string, InstalledPlugin>();

	get size(): number {
		return this.#plugins.size;
	}

	list(): readonly InstalledPlugin[] {
		return [...this.#plugins.values()];
	}

	get(pluginId: string): InstalledPlugin | undefined {
		return this.#plugins.get(pluginId);
	}

	async loadManifest(input: unknown): Promise<PluginManifest> {
		const result = pluginManifestSchema.safeParse(input);
		if (!result.success) {
			throw new PluginRegistryError(`Invalid plugin manifest: ${result.error.message}`);
		}
		return result.data;
	}

	async loadManifestFile(path: string): Promise<PluginManifest> {
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			throw new PluginRegistryError(`Cannot read plugin manifest at ${path}`, { cause: error });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			throw new PluginRegistryError(`Invalid JSON in plugin manifest at ${path}`, { cause: error });
		}
		return this.loadManifest(parsed);
	}

	install(manifest: PluginManifest, options: InstallPluginOptions = {}): InstalledPlugin {
		if (this.#plugins.has(manifest.name)) {
			throw new PluginRegistryError(`Plugin ${manifest.name} is already installed`);
		}
		const grantedPermissions = options.grantedPermissions ?? [];
		const undeclared = grantedPermissions.filter(
			(permission) => !manifest.permissions.includes(permission),
		);
		if (undeclared.length > 0) {
			throw new PluginRegistryError(
				`Plugin ${manifest.name} has grants not declared in its manifest: ${undeclared.join(", ")}`,
			);
		}
		validatePluginConfig(manifest.configSchema, options.config ?? {}, manifest.name);
		const runMode = options.runMode ?? (manifest.kind === "third-party" ? "worker" : "host");
		const installed: InstalledPlugin = {
			config: options.config ?? {},
			enabled: options.enabled ?? true,
			grantedPermissions,
			manifest,
			runMode,
		};
		this.#plugins.set(manifest.name, installed);
		return installed;
	}

	/** Replace an installed plugin manifest/config while preserving install identity. */
	replace(
		pluginId: string,
		manifest: PluginManifest,
		options: InstallPluginOptions = {},
	): InstalledPlugin {
		const existing = this.#plugins.get(pluginId);
		if (existing === undefined) {
			throw new PluginRegistryError(`Unknown plugin ${pluginId}`);
		}
		if (manifest.name !== pluginId) {
			throw new PluginRegistryError(`Manifest name ${manifest.name} does not match ${pluginId}`);
		}
		const grantedPermissions = options.grantedPermissions ?? existing.grantedPermissions;
		const undeclared = grantedPermissions.filter(
			(permission) => !manifest.permissions.includes(permission),
		);
		if (undeclared.length > 0) {
			throw new PluginRegistryError(
				`Plugin ${manifest.name} has grants not declared in its manifest: ${undeclared.join(", ")}`,
			);
		}
		const config = options.config ?? existing.config;
		validatePluginConfig(manifest.configSchema, config, manifest.name);
		const installed: InstalledPlugin = {
			config,
			enabled: options.enabled ?? existing.enabled,
			grantedPermissions,
			manifest,
			runMode: options.runMode ?? existing.runMode,
		};
		this.#plugins.set(pluginId, installed);
		return installed;
	}

	setEnabled(pluginId: string, enabled: boolean): InstalledPlugin {
		const installed = this.#plugins.get(pluginId);
		if (installed === undefined) {
			throw new PluginRegistryError(`Unknown plugin ${pluginId}`);
		}
		const next: InstalledPlugin = { ...installed, enabled };
		this.#plugins.set(pluginId, next);
		return next;
	}

	uninstall(pluginId: string): void {
		if (!this.#plugins.delete(pluginId)) {
			throw new PluginRegistryError(`Unknown plugin ${pluginId}`);
		}
	}
}
