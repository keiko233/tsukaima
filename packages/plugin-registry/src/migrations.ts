import { createHash, randomUUID } from "node:crypto";
import {
	PluginNamingError,
	assertPluginSqlIsolated,
	pluginSqlPrefix,
	sanitizePluginId,
} from "./naming.ts";
import type { PluginDatabaseConnection, PluginDatabaseProvider } from "./plugin-database.ts";

export interface PluginMigration {
	readonly version: string;
	readonly sql: string;
	readonly rollbackSql?: string | undefined;
	readonly checksum?: string | undefined;
}

export interface PluginMigrationPlan {
	readonly pluginId: string;
	readonly migrations: readonly PluginMigration[];
	readonly enabled?: boolean;
}

export interface PluginMigrationApplyOptions {
	readonly dryRun?: boolean;
	readonly enabled?: boolean;
}

export interface AppliedPluginMigration {
	readonly appliedAt: string;
	readonly checksum: string;
	readonly durationMs: number;
	readonly pluginId: string;
	readonly rollbackSql?: string;
	readonly version: string;
}

export interface PluginMigrationRunResult {
	readonly applied: readonly AppliedPluginMigration[];
	readonly dryRun: boolean;
	readonly pending: readonly string[];
	readonly pluginId: string;
	readonly skipped: readonly string[];
}

export interface PluginRollbackOptions {
	readonly dryRun?: boolean;
	/** Roll back at most this many newest applied versions. */
	readonly limit?: number;
	/** Roll back through this version (inclusive). */
	readonly targetVersion?: string;
	readonly skipMissing?: boolean;
}

export class MigrationRegistryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MigrationRegistryError";
	}
}

export interface MigrationRegistryOptions {
	readonly databases: PluginDatabaseProvider;
	readonly now?: () => Date;
}

const LEDGER_TABLE = "_tsukaima_plugin_migrations";

interface LedgerRow {
	readonly applied_at: string;
	readonly checksum: string;
	readonly duration_ms: number;
	readonly rollback_sql: string | null;
	readonly version: string;
}

/** Stable sanitation used for plugin database file names and legacy object prefixes. */
export { pluginSqlPrefix, sanitizePluginId };
export { assertPluginSqlIsolated, assertPluginSqlIsolated as assertPluginSqlNamespaced };

export function migrationChecksum(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

function versionParts(version: string): (number | string)[] {
	return version
		.split(/(\d+)/u)
		.filter((part) => part.length > 0)
		.map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
}

/** Numeric-aware deterministic version order (`1.10` > `1.9`). */
export function compareMigrationVersions(left: string, right: string): number {
	const a = versionParts(left);
	const b = versionParts(right);
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const x = a[index];
		const y = b[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (typeof x === "number" && typeof y === "number") {
			if (x !== y) return x - y;
			continue;
		}
		const comparison = String(x).localeCompare(String(y));
		if (comparison !== 0) return comparison;
	}
	return 0;
}

let migrationQueue: Promise<unknown> = Promise.resolve();

async function withMigrationLock<T>(task: () => Promise<T>): Promise<T> {
	const previous = migrationQueue;
	const current = previous.catch(() => undefined).then(task);
	migrationQueue = current.then(
		() => undefined,
		() => undefined,
	);
	return await current;
}

function rowToApplied(pluginId: string, row: LedgerRow): AppliedPluginMigration {
	return {
		appliedAt: row.applied_at,
		checksum: row.checksum,
		durationMs: row.duration_ms,
		pluginId,
		version: row.version,
		...(row.rollback_sql === null ? {} : { rollbackSql: row.rollback_sql }),
	};
}

function ensureLedger(database: PluginDatabaseConnection): void {
	database.exec(
		`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
	version TEXT PRIMARY KEY NOT NULL,
	checksum TEXT NOT NULL,
	rollback_sql TEXT,
	applied_at TEXT NOT NULL,
	duration_ms INTEGER NOT NULL
);`,
	);
}

function readLedger(database: PluginDatabaseConnection): readonly LedgerRow[] {
	return database.query<LedgerRow>(
		`SELECT version, checksum, rollback_sql, applied_at, duration_ms FROM ${LEDGER_TABLE}`,
	);
}

function assertIsolated(sql: string, pluginId: string): void {
	try {
		assertPluginSqlIsolated(sql, pluginId);
	} catch (error) {
		if (error instanceof PluginNamingError) {
			throw new MigrationRegistryError(error.message, { cause: error });
		}
		throw error;
	}
}

/**
 * Applies plugin-owned journals inside each plugin's own SQLite file.
 *
 * The ledger lives in that file too, so a plugin database is self-contained and deleting it
 * removes both its schema and its migration history. The process-wide queue serializes plugin
 * starts, and every migration batch runs in one SQLite transaction.
 */
export class MigrationRegistry {
	readonly #databases: PluginDatabaseProvider;
	readonly #now: () => Date;

	constructor(options: MigrationRegistryOptions) {
		this.#databases = options.databases;
		this.#now = options.now ?? (() => new Date());
	}

	async run(
		pluginId: string,
		migrations: readonly PluginMigration[],
		options: PluginMigrationApplyOptions = {},
	): Promise<PluginMigrationRunResult> {
		const validated = this.#validate(pluginId, migrations);
		if (options.enabled === false) {
			return {
				applied: [],
				dryRun: false,
				pending: [],
				pluginId,
				skipped: validated.map((migration) => migration.version),
			};
		}
		return await withMigrationLock(async () => {
			const database = await this.#databases.open(pluginId);
			ensureLedger(database);
			const existing = readLedger(database);
			const plan = this.#plan(pluginId, validated, existing);
			const skipped = validated
				.filter((migration) => !plan.some((pending) => pending.version === migration.version))
				.map((migration) => migration.version);
			if (options.dryRun === true) {
				return {
					applied: [],
					dryRun: true,
					pending: plan.map((migration) => migration.version),
					pluginId,
					skipped,
				};
			}
			if (plan.length === 0) {
				return { applied: [], dryRun: false, pending: [], pluginId, skipped };
			}
			const applied: AppliedPluginMigration[] = [];
			try {
				database.transaction(() => {
					for (const migration of plan) {
						const startedAt = Date.now();
						database.exec(migration.sql);
						const durationMs = Math.max(0, Date.now() - startedAt);
						const appliedAt = this.#now().toISOString();
						const checksum = migrationChecksum(migration.sql);
						database.query(
							`INSERT INTO ${LEDGER_TABLE}
	(version, checksum, rollback_sql, applied_at, duration_ms)
	VALUES (?, ?, ?, ?, ?)`,
							[migration.version, checksum, migration.rollbackSql ?? null, appliedAt, durationMs],
						);
						applied.push({
							appliedAt,
							checksum,
							durationMs,
							pluginId,
							version: migration.version,
							...(migration.rollbackSql === undefined
								? {}
								: { rollbackSql: migration.rollbackSql }),
						});
					}
				});
			} catch (error) {
				throw error instanceof MigrationRegistryError
					? error
					: new MigrationRegistryError(
							`Plugin ${pluginId} migration failed: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
			}
			return { applied, dryRun: false, pending: [], pluginId, skipped };
		});
	}

	/** Apply several plugin plans in deterministic plugin-id order. */
	async migrate(
		plans: readonly PluginMigrationPlan[],
		options: PluginMigrationApplyOptions = {},
	): Promise<readonly PluginMigrationRunResult[]> {
		const results: PluginMigrationRunResult[] = [];
		for (const plan of plans.toSorted((a, b) => a.pluginId.localeCompare(b.pluginId))) {
			results.push(
				await this.run(plan.pluginId, plan.migrations, {
					...options,
					...(plan.enabled === undefined ? {} : { enabled: plan.enabled }),
				}),
			);
		}
		return results;
	}

	async list(pluginId: string): Promise<readonly AppliedPluginMigration[]> {
		const database = await this.#databases.open(pluginId);
		ensureLedger(database);
		return readLedger(database).map((row) => rowToApplied(pluginId, row));
	}

	async rollbackPlugin(
		pluginId: string,
		options: PluginRollbackOptions = {},
	): Promise<readonly string[]> {
		return await withMigrationLock(async () => {
			const database = await this.#databases.open(pluginId);
			ensureLedger(database);
			const ordered = readLedger(database)
				.map((row) => rowToApplied(pluginId, row))
				.toSorted((a, b) => compareMigrationVersions(b.version, a.version));
			let selected = ordered;
			if (options.targetVersion !== undefined) {
				const targetVersion = options.targetVersion;
				selected = ordered.filter(
					(row) => compareMigrationVersions(row.version, targetVersion) >= 0,
				);
			}
			if (options.limit !== undefined) selected = selected.slice(0, Math.max(0, options.limit));
			if (options.dryRun === true) return selected.map((row) => row.version);
			if (selected.some((row) => row.rollbackSql === undefined) && options.skipMissing !== true) {
				throw new MigrationRegistryError(
					`Plugin ${pluginId} does not have a rollback plan for every applied version`,
				);
			}
			database.transaction(() => {
				for (const row of selected) {
					if (row.rollbackSql === undefined) continue;
					assertIsolated(row.rollbackSql, pluginId);
					database.exec(row.rollbackSql);
					database.query(`DELETE FROM ${LEDGER_TABLE} WHERE version = ?`, [row.version]);
				}
			});
			return selected.map((row) => row.version);
		});
	}

	async rollback(
		pluginId: string,
		versionOrOptions?: string | PluginRollbackOptions,
	): Promise<readonly string[]> {
		return await this.rollbackPlugin(
			pluginId,
			typeof versionOrOptions === "string"
				? { targetVersion: versionOrOptions }
				: (versionOrOptions ?? {}),
		);
	}

	#validate(pluginId: string, migrations: readonly PluginMigration[]): readonly PluginMigration[] {
		const seen = new Set<string>();
		const sorted = migrations.toSorted((a, b) => compareMigrationVersions(a.version, b.version));
		for (const migration of sorted) {
			if (seen.has(migration.version)) {
				throw new MigrationRegistryError(
					`Plugin ${pluginId} declares duplicate migration version ${migration.version}`,
				);
			}
			seen.add(migration.version);
			const checksum = migrationChecksum(migration.sql);
			if (migration.checksum !== undefined && migration.checksum !== checksum) {
				throw new MigrationRegistryError(
					`Plugin ${pluginId} migration ${migration.version} checksum does not match its SQL`,
				);
			}
			assertIsolated(migration.sql, pluginId);
			if (migration.rollbackSql !== undefined) {
				assertIsolated(migration.rollbackSql, pluginId);
			}
		}
		return sorted;
	}

	#plan(
		pluginId: string,
		migrations: readonly PluginMigration[],
		existing: readonly { checksum: string; version: string }[],
	): readonly PluginMigration[] {
		const applied = new Map(existing.map((row) => [row.version, row]));
		const maxApplied = existing
			.map((row) => row.version)
			.toSorted(compareMigrationVersions)
			.at(-1);
		const plan: PluginMigration[] = [];
		for (const migration of migrations) {
			const row = applied.get(migration.version);
			if (row !== undefined) {
				const checksum = migrationChecksum(migration.sql);
				if (row.checksum !== checksum) {
					throw new MigrationRegistryError(
						`Plugin ${pluginId} migration ${migration.version} checksum drifted after it was applied`,
					);
				}
				continue;
			}
			if (maxApplied !== undefined && compareMigrationVersions(migration.version, maxApplied) < 0) {
				throw new MigrationRegistryError(
					`Plugin ${pluginId} migration ${migration.version} is older than applied ${maxApplied}`,
				);
			}
			plan.push(migration);
		}
		return plan;
	}
}

/** Stable identifier used by callers that need a random ledger value. */
export function pluginMigrationId(): string {
	return randomUUID();
}
