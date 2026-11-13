import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql as sqlRaw } from "drizzle-orm";
import { pluginMigrations, type ElainaDatabase } from "@elaina/db";

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
	readonly database: ElainaDatabase | (() => ElainaDatabase | undefined);
}

/** Stable sanitation used for `plugin_<sanitized_id>_*` object prefixes. */
export function sanitizePluginId(pluginId: string): string {
	const value = pluginId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/gu, "_")
		.replace(/^_+|_+$/gu, "");
	if (value.length === 0) throw new MigrationRegistryError("Plugin id cannot be sanitized");
	return value;
}

export function pluginSqlPrefix(pluginId: string): string {
	return `plugin_${sanitizePluginId(pluginId)}_`;
}

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

function unquoteIdentifier(value: string): string {
	return value.replace(/^[`"[]/u, "").replace(/[`"\]]$/u, "");
}

/**
 * Validate that every DDL target uses the plugin's prefix. This is intentionally conservative:
 * plugin migrations may not create, alter, or drop core tables or another plugin's objects.
 */
export function assertPluginSqlNamespaced(sql: string, pluginId: string): void {
	if (/\b(?:attach|detach)\s+database\b/iu.test(sql)) {
		throw new MigrationRegistryError(
			`Plugin ${pluginId} migrations may not attach or detach databases`,
		);
	}
	const prefix = pluginSqlPrefix(pluginId);
	const identifier = '([`"\\[]?[A-Za-z0-9_.-]+[`"\\]]?)';
	const ddl = new RegExp(
		String.raw`\b(?:create|alter|drop)\s+(?:(?:virtual|temp|temporary)\s+)?(?:table|index|view|trigger)\s+(?:if\s+(?:not\s+)?exists\s+)?${identifier}`,
		"giu",
	);
	for (const match of sql.matchAll(ddl)) {
		const name = unquoteIdentifier(match[1] ?? "");
		if (!name.startsWith(prefix)) {
			throw new MigrationRegistryError(
				`Plugin ${pluginId} migration object ${name} must start with ${prefix}`,
			);
		}
	}
	const indexTarget =
		/\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[^\s]+\s+on\s+([`"[]?[A-Za-z0-9_.-]+[`"\]]?)/giu;
	for (const match of sql.matchAll(indexTarget)) {
		const name = unquoteIdentifier(match[1] ?? "");
		if (!name.startsWith(prefix)) {
			throw new MigrationRegistryError(
				`Plugin ${pluginId} index target ${name} must start with ${prefix}`,
			);
		}
	}
	const writes =
		/\b(?:insert\s+into|update|delete\s+from|from|join|references)\s+([`"[]?[A-Za-z0-9_.-]+[`"\]]?)/giu;
	for (const match of sql.matchAll(writes)) {
		const name = unquoteIdentifier(match[1] ?? "");
		if (name.startsWith(prefix) || /^(?:select|where|as)$/iu.test(name)) continue;
		throw new MigrationRegistryError(
			`Plugin ${pluginId} migration may only reference ${prefix}* objects (saw ${name})`,
		);
	}
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

function rowsToApplied(row: {
	appliedAt: string;
	checksum: string;
	durationMs: number;
	pluginId: string;
	rollbackSql: string | null;
	version: string;
}): AppliedPluginMigration {
	return {
		appliedAt: row.appliedAt,
		checksum: row.checksum,
		durationMs: row.durationMs,
		pluginId: row.pluginId,
		version: row.version,
		...(row.rollbackSql === null ? {} : { rollbackSql: row.rollbackSql }),
	};
}

/**
 * Applies plugin-owned journals after `migrateDomainDatabase` and before `prepare()`.
 * SQLite transactions plus the process-wide queue serialize concurrent plugin starts.
 */
export class MigrationRegistry {
	readonly #database: () => ElainaDatabase | undefined;

	constructor(options: MigrationRegistryOptions) {
		this.#database =
			typeof options.database === "function"
				? options.database
				: () => options.database as ElainaDatabase;
	}

	async run(
		pluginId: string,
		migrations: readonly PluginMigration[],
		options: PluginMigrationApplyOptions = {},
	): Promise<PluginMigrationRunResult> {
		if (options.enabled === false || options.dryRun === true) {
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
			const database = this.#requireDatabase();
			return await withMigrationLock(async () => {
				const existing = await this.#appliedRows(database, pluginId);
				const plan = this.#plan(pluginId, validated, existing);
				return {
					applied: [],
					dryRun: true,
					pending: plan.map((migration) => migration.version),
					pluginId,
					skipped: validated
						.filter((migration) => !plan.includes(migration))
						.map((migration) => migration.version),
				};
			});
		}
		const database = this.#requireDatabase();
		const validated = this.#validate(pluginId, migrations);
		return await withMigrationLock(async () => {
			const existing = await this.#appliedRows(database, pluginId);
			const plan = this.#plan(pluginId, validated, existing);
			const skipped = validated
				.filter((migration) => !plan.some((pending) => pending.version === migration.version))
				.map((migration) => migration.version);
			if (plan.length === 0) {
				return { applied: [], dryRun: false, pending: [], pluginId, skipped };
			}
			const applied: AppliedPluginMigration[] = [];
			try {
				await database.transaction((tx) => {
					for (const migration of plan) {
						const startedAt = Date.now();
						tx.run(sqlRaw.raw(migration.sql));
						const durationMs = Math.max(0, Date.now() - startedAt);
						const appliedAt = new Date().toISOString();
						const checksum = migrationChecksum(migration.sql);
						tx.insert(pluginMigrations)
							.values({
								appliedAt,
								checksum,
								durationMs,
								id: randomUUID(),
								pluginId,
								rollbackSql: migration.rollbackSql ?? null,
								status: "applied",
								version: migration.version,
							})
							.run();
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

	async list(pluginId?: string): Promise<readonly AppliedPluginMigration[]> {
		const database = this.#requireDatabase();
		const rows =
			pluginId === undefined
				? await database.select().from(pluginMigrations)
				: await database
						.select()
						.from(pluginMigrations)
						.where(eq(pluginMigrations.pluginId, pluginId));
		return rows.map(rowsToApplied);
	}

	async rollbackPlugin(
		pluginId: string,
		options: PluginRollbackOptions = {},
	): Promise<readonly string[]> {
		const database = this.#requireDatabase();
		return await withMigrationLock(async () => {
			const rows = await database
				.select()
				.from(pluginMigrations)
				.where(eq(pluginMigrations.pluginId, pluginId));
			const ordered = rows
				.map(rowsToApplied)
				.toSorted((a, b) => compareMigrationVersions(b.version, a.version));
			let selected = ordered;
			if (options.targetVersion !== undefined) {
				selected = ordered.filter(
					(row) => compareMigrationVersions(row.version, options.targetVersion as string) >= 0,
				);
			}
			if (options.limit !== undefined) selected = selected.slice(0, Math.max(0, options.limit));
			if (options.dryRun === true) return selected.map((row) => row.version);
			if (selected.some((row) => row.rollbackSql === undefined) && options.skipMissing !== true) {
				throw new MigrationRegistryError(
					`Plugin ${pluginId} does not have a rollback plan for every applied version`,
				);
			}
			await database.transaction((tx) => {
				for (const row of selected) {
					if (row.rollbackSql === undefined) continue;
					assertPluginSqlNamespaced(row.rollbackSql, pluginId);
					tx.run(sqlRaw.raw(row.rollbackSql));
					tx.delete(pluginMigrations)
						.where(
							and(
								eq(pluginMigrations.pluginId, pluginId),
								eq(pluginMigrations.version, row.version),
							),
						)
						.run();
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
			assertPluginSqlNamespaced(migration.sql, pluginId);
			if (migration.rollbackSql !== undefined) {
				assertPluginSqlNamespaced(migration.rollbackSql, pluginId);
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

	async #appliedRows(
		database: ElainaDatabase,
		pluginId: string,
	): Promise<readonly { checksum: string; version: string }[]> {
		return await database
			.select({
				checksum: pluginMigrations.checksum,
				version: pluginMigrations.version,
			})
			.from(pluginMigrations)
			.where(eq(pluginMigrations.pluginId, pluginId));
	}

	#requireDatabase(): ElainaDatabase {
		const database = this.#database();
		if (database === undefined) throw new MigrationRegistryError("Domain database is not ready");
		return database;
	}
}
