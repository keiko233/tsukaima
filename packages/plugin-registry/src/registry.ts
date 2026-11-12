import { readFile } from "node:fs/promises";
import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk";

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

	uninstall(pluginId: string): void {
		if (!this.#plugins.delete(pluginId)) {
			throw new PluginRegistryError(`Unknown plugin ${pluginId}`);
		}
	}
}
