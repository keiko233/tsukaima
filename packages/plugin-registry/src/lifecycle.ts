import type { PluginManifest } from "@tsukaima/sdk";
import { loadPluginMigrations } from "./migration-files.ts";
import { MigrationRegistry, MigrationRegistryError, type PluginMigration } from "./migrations.ts";
import {
	PluginRegistry,
	type InstalledPlugin,
	type InstallPluginOptions,
	type PluginRunMode,
} from "./registry.ts";

export const SUPPORTED_PLUGIN_API_VERSIONS = ["1"] as const;

export interface PluginLifecycleBackup {
	readonly config: Record<string, unknown>;
	readonly installed: InstalledPlugin;
	readonly storage?: unknown;
}

export interface PluginInstallState {
	readonly backup?: PluginLifecycleBackup | undefined;
	readonly failureCount: number;
	readonly installedVersion: string;
	readonly kind: PluginManifest["kind"];
	readonly manifest: PluginManifest;
	readonly quarantinedAt?: string | undefined;
	readonly quarantineReason?: string | undefined;
	readonly retainData: boolean;
	readonly updatedAt: string;
}

export interface PluginLifecycleHooks {
	readonly readConfig?: (pluginId: string) => Promise<Record<string, unknown>>;
	readonly writeConfig?: (pluginId: string, config: Record<string, unknown>) => Promise<void>;
	readonly exportStorage?: (pluginId: string) => Promise<unknown>;
	readonly importStorage?: (pluginId: string, storage: unknown) => Promise<void>;
	readonly clearStorage?: (pluginId: string) => Promise<void>;
	readonly start?: (pluginId: string) => Promise<void>;
	readonly stop?: (pluginId: string) => Promise<void>;
	readonly reload?: (pluginId: string) => Promise<void>;
}

export interface PluginLifecycleManagerOptions {
	readonly registry?: PluginRegistry;
	readonly migrations?: MigrationRegistry | undefined;
	readonly hooks?: PluginLifecycleHooks;
	readonly maxFailures?: number;
	readonly now?: () => Date;
	readonly supportedApiVersions?: readonly string[];
}

export interface PluginLifecycleUpgradeOptions {
	readonly config?: Record<string, unknown>;
	readonly grantedPermissions?: readonly string[];
	readonly runMode?: PluginRunMode;
	/** Plugin package root used to resolve the manifest's migrations directory. */
	readonly rootDir?: string;
	/** Explicit migration override (otherwise the manifest's migrations are loaded). */
	readonly migrations?: readonly PluginMigration[];
	readonly dryRunMigrations?: boolean;
}

export class PluginLifecycleError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PluginLifecycleError";
	}
}

function compareVersions(left: string, right: string): number {
	const a = left
		.split(/[^\d]+/u)
		.filter(Boolean)
		.map(Number);
	const b = right
		.split(/[^\d]+/u)
		.filter(Boolean)
		.map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return left.localeCompare(right);
}

/**
 * Install/upgrade/downgrade/quarantine/uninstall state machine. Backup/restore is delegated to
 * host hooks so the same manager works with in-memory tests and the durable server.
 */
export class PluginLifecycleManager {
	readonly registry: PluginRegistry;
	readonly migrations: MigrationRegistry | undefined;
	readonly #hooks: PluginLifecycleHooks;
	readonly #maxFailures: number;
	readonly #now: () => Date;
	readonly #supportedApiVersions: readonly string[];
	readonly #states = new Map<string, PluginInstallState>();

	constructor(options: PluginLifecycleManagerOptions = {}) {
		this.registry = options.registry ?? new PluginRegistry();
		this.migrations = options.migrations;
		this.#hooks = options.hooks ?? {};
		this.#maxFailures = Math.max(1, options.maxFailures ?? 3);
		this.#now = options.now ?? (() => new Date());
		this.#supportedApiVersions = options.supportedApiVersions ?? SUPPORTED_PLUGIN_API_VERSIONS;
	}

	list(): readonly PluginInstallState[] {
		return [...this.#states.values()];
	}

	hydrate(states: Iterable<PluginInstallState>): void {
		for (const state of states) this.#states.set(state.manifest.name, state);
	}

	state(pluginId: string): PluginInstallState | undefined {
		return this.#states.get(pluginId);
	}

	isQuarantined(pluginId: string): boolean {
		return this.#states.get(pluginId)?.quarantinedAt !== undefined;
	}

	async install(
		manifest: PluginManifest,
		options: InstallPluginOptions = {},
	): Promise<InstalledPlugin> {
		this.#assertApiVersion(manifest);
		if (this.registry.get(manifest.name) !== undefined) {
			throw new PluginLifecycleError(`Plugin ${manifest.name} is already installed`);
		}
		const migrations = await this.#migrationsFor(manifest.name, manifest, options);
		if (options.runMode !== "worker") {
			await this.migrations?.run(manifest.name, migrations, {
				enabled: options.enabled !== false,
			});
		}
		const installed = this.registry.install(manifest, {
			...options,
			...(options.runMode === undefined && manifest.migrations !== undefined
				? { runMode: "host" }
				: {}),
		});
		this.#states.set(manifest.name, {
			failureCount: 0,
			installedVersion: manifest.version,
			kind: manifest.kind,
			manifest,
			retainData: true,
			updatedAt: this.#now().toISOString(),
		});
		await this.#hooks.writeConfig?.(manifest.name, options.config ?? {});
		return installed;
	}

	async upgrade(
		pluginId: string,
		manifest: PluginManifest,
		options: PluginLifecycleUpgradeOptions = {},
	): Promise<InstalledPlugin> {
		this.#assertApiVersion(manifest);
		if (manifest.name !== pluginId) {
			throw new PluginLifecycleError("Upgrade manifest does not match the installed plugin id");
		}
		const existing = this.registry.get(pluginId);
		if (existing === undefined) throw new PluginLifecycleError(`Unknown plugin ${pluginId}`);
		if (compareVersions(manifest.version, existing.manifest.version) <= 0) {
			throw new PluginLifecycleError(
				`Upgrade version ${manifest.version} must be newer than ${existing.manifest.version}`,
			);
		}
		return await this.#replace(pluginId, existing, manifest, options);
	}

	async downgrade(
		pluginId: string,
		manifest: PluginManifest,
		options: PluginLifecycleUpgradeOptions = {},
	): Promise<InstalledPlugin> {
		this.#assertApiVersion(manifest);
		if (manifest.name !== pluginId) {
			throw new PluginLifecycleError("Downgrade manifest does not match the installed plugin id");
		}
		const existing = this.registry.get(pluginId);
		if (existing === undefined) throw new PluginLifecycleError(`Unknown plugin ${pluginId}`);
		if (compareVersions(manifest.version, existing.manifest.version) >= 0) {
			throw new PluginLifecycleError(
				`Downgrade version ${manifest.version} must be older than ${existing.manifest.version}`,
			);
		}
		return await this.#replace(pluginId, existing, manifest, options, manifest.version);
	}

	async reload(pluginId: string): Promise<InstalledPlugin> {
		const existing = this.registry.get(pluginId);
		if (existing === undefined) throw new PluginLifecycleError(`Unknown plugin ${pluginId}`);
		if (this.isQuarantined(pluginId)) {
			throw new PluginLifecycleError(`Plugin ${pluginId} is quarantined; recover it first`);
		}
		await this.#hooks.stop?.(pluginId);
		await this.#hooks.reload?.(pluginId);
		await this.#hooks.start?.(pluginId);
		return existing;
	}

	async recover(pluginId: string): Promise<InstalledPlugin> {
		const existing = this.registry.get(pluginId);
		if (existing === undefined) throw new PluginLifecycleError(`Unknown plugin ${pluginId}`);
		const state = this.#states.get(pluginId);
		if (state !== undefined) {
			this.#states.set(pluginId, {
				...state,
				failureCount: 0,
				quarantinedAt: undefined,
				quarantineReason: undefined,
				updatedAt: this.#now().toISOString(),
			});
		}
		await this.#hooks.reload?.(pluginId);
		await this.#hooks.start?.(pluginId);
		return existing;
	}

	async uninstall(
		pluginId: string,
		options: { readonly retainData?: boolean } = {},
	): Promise<boolean> {
		const existing = this.registry.get(pluginId);
		if (existing === undefined) throw new PluginLifecycleError(`Unknown plugin ${pluginId}`);
		const retainData = options.retainData ?? true;
		await this.#hooks.stop?.(pluginId);
		if (!retainData) {
			await this.migrations?.rollbackPlugin(pluginId, { skipMissing: true });
			await this.#hooks.clearStorage?.(pluginId);
		}
		this.registry.uninstall(pluginId);
		this.#states.delete(pluginId);
		return true;
	}

	recordFailure(pluginId: string, reason: string): PluginInstallState {
		const existing = this.registry.get(pluginId);
		const state = this.#states.get(pluginId);
		const now = this.#now().toISOString();
		const failureCount = (state?.failureCount ?? 0) + 1;
		const next: PluginInstallState = {
			backup: state?.backup,
			failureCount,
			installedVersion: existing?.manifest.version ?? state?.installedVersion ?? "0.0.0",
			kind: existing?.manifest.kind ?? state?.kind ?? "third-party",
			manifest: existing?.manifest ?? (state?.manifest as PluginManifest),
			...(failureCount >= this.#maxFailures
				? { quarantinedAt: now, quarantineReason: reason }
				: {}),
			retainData: state?.retainData ?? true,
			updatedAt: now,
		};
		this.#states.set(pluginId, next);
		return next;
	}

	recordSuccess(pluginId: string): void {
		const state = this.#states.get(pluginId);
		if (state === undefined) return;
		this.#states.set(pluginId, {
			...state,
			failureCount: 0,
			quarantinedAt: undefined,
			quarantineReason: undefined,
			updatedAt: this.#now().toISOString(),
		});
	}

	async #replace(
		pluginId: string,
		existing: InstalledPlugin,
		manifest: PluginManifest,
		options: PluginLifecycleUpgradeOptions,
		rollbackToVersion?: string,
	): Promise<InstalledPlugin> {
		const backup: PluginLifecycleBackup = {
			config: options.config ?? (await this.#hooks.readConfig?.(pluginId)) ?? existing.config,
			installed: existing,
			...(this.#hooks.exportStorage === undefined
				? {}
				: { storage: await this.#hooks.exportStorage(pluginId) }),
		};
		const previousState = this.#states.get(pluginId);
		const nextState: PluginInstallState = {
			backup,
			failureCount: 0,
			installedVersion: manifest.version,
			kind: manifest.kind,
			manifest,
			retainData: previousState?.retainData ?? true,
			updatedAt: this.#now().toISOString(),
		};
		this.#states.set(pluginId, nextState);
		const migrations = await this.#migrationsFor(pluginId, manifest, options);
		let rolledBack = false;
		try {
			await this.#hooks.stop?.(pluginId);
			if (rollbackToVersion !== undefined && this.migrations !== undefined) {
				const applied = await this.migrations.list(pluginId);
				const newer = applied.filter(
					(migration) => compareVersions(migration.version, rollbackToVersion) > 0,
				);
				if (newer.length > 0) {
					await this.migrations.rollbackPlugin(pluginId, { limit: newer.length });
					rolledBack = true;
				}
			}
			await this.migrations?.run(pluginId, migrations, {
				dryRun: options.dryRunMigrations === true,
			});
			const installed = this.registry.replace(pluginId, manifest, {
				...(options.config === undefined ? {} : { config: options.config }),
				...(options.grantedPermissions === undefined
					? {}
					: { grantedPermissions: options.grantedPermissions }),
				enabled: existing.enabled,
				...(options.runMode === undefined
					? manifest.migrations !== undefined
						? { runMode: "host" }
						: {}
					: { runMode: options.runMode }),
			});
			await this.#hooks.writeConfig?.(pluginId, installed.config);
			await this.#hooks.start?.(pluginId);
			return installed;
		} catch (error) {
			// Restore the previous install, config, storage, and (when possible) migrations.
			this.registry.replace(pluginId, existing.manifest, {
				config: backup.config,
				enabled: backup.installed.enabled,
				grantedPermissions: backup.installed.grantedPermissions,
				runMode: backup.installed.runMode,
			});
			await this.#hooks.writeConfig?.(pluginId, backup.config);
			if (backup.storage !== undefined) {
				await this.#hooks.importStorage?.(pluginId, backup.storage);
			}
			if (rolledBack) {
				await this.#migrationsFor(
					pluginId,
					existing.manifest,
					options.rootDir === undefined ? {} : { rootDir: options.rootDir },
				)
					.then((restoreMigrations) => this.migrations?.run(pluginId, restoreMigrations, {}))
					.catch(() => undefined);
			}
			if (previousState === undefined) this.#states.delete(pluginId);
			else this.#states.set(pluginId, previousState);
			await this.#hooks.start?.(pluginId).catch(() => undefined);
			throw error instanceof MigrationRegistryError || error instanceof PluginLifecycleError
				? error
				: new PluginLifecycleError(
						`Plugin ${pluginId} lifecycle change failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
		}
	}

	async #migrationsFor(
		pluginId: string,
		manifest: PluginManifest,
		options: { readonly rootDir?: string; readonly migrations?: readonly PluginMigration[] },
	): Promise<readonly PluginMigration[]> {
		if (options.migrations !== undefined) return options.migrations;
		if (manifest.migrations === undefined) return [];
		if (options.rootDir === undefined) {
			throw new PluginLifecycleError(
				`Plugin ${pluginId} declares a migrations directory; pass rootDir to resolve it`,
			);
		}
		return await loadPluginMigrations(options.rootDir, manifest.migrations);
	}

	#assertApiVersion(manifest: PluginManifest): void {
		if (!this.#supportedApiVersions.includes(manifest.apiVersion)) {
			throw new PluginLifecycleError(
				`Plugin ${manifest.name} requires API ${manifest.apiVersion}; host supports ${this.#supportedApiVersions.join(", ")}`,
			);
		}
	}
}
