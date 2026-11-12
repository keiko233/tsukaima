import { Database } from "bun:sqlite";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

export interface BunSqliteDatabaseOptions {
	readonly path: string;
	readonly busyTimeoutMs?: number;
}

type Operation = () => unknown;

function toOptional<T>(value: T | null): T | undefined {
	return value === null ? undefined : value;
}

class BunSqliteExecutor implements SqliteExecutor {
	protected readonly database: Database;
	private readonly queue: Promise<unknown> = Promise.resolve();

	constructor(database: Database) {
		this.database = database;
	}

	async exec(sql: string): Promise<void> {
		await this.enqueue(() => {
			this.database.run(sql);
		});
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		await this.enqueue(() => {
			this.database.query(sql).run(...params);
		});
	}

	async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		return await this.enqueue(() => {
			const statement = this.database.query(sql);
			statement.run(...params);
			return Number(
				(this.database.query("SELECT changes() AS changes").get() as { changes?: number } | null)
					?.changes ?? 0,
			);
		});
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return await this.enqueue(() =>
			toOptional(this.database.query(sql).get(...params) as T | null),
		);
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return await this.enqueue(() => this.database.query(sql).all(...params) as T[]);
	}

	protected enqueue<T>(operation: Operation): Promise<T> {
		const run = async () => operation() as T,
			result = this.queue.then(run, run);
		(this as unknown as { queue: Promise<unknown> }).queue = result.catch(() => undefined);
		return result;
	}
}

export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
	private closed = false;

	async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		if (this.closed) {
			throw new Error("SQLite database is closed");
		}

		return await this.enqueue(async () => {
			const transaction: SqliteExecutor = {
				all: async <TRow extends object>(sql: string, ...params: SqliteValue[]) =>
					this.database.query(sql).all(...params) as TRow[],
				exec: async (sql: string) => {
					this.database.exec(sql);
				},
				get: async <TRow extends object>(sql: string, ...params: SqliteValue[]) =>
					toOptional(this.database.query(sql).get(...params) as TRow | null),
				run: async (sql: string, ...params: SqliteValue[]) => {
					this.database.query(sql).run(...params);
				},
				runCounted: async (sql: string, ...params: SqliteValue[]) => {
					const statement = this.database.query(sql);
					statement.run(...params);
					return Number(
						(
							this.database.query("SELECT changes() AS changes").get() as {
								changes?: number;
							} | null
						)?.changes ?? 0,
					);
				},
			};

			this.database.run("BEGIN IMMEDIATE");
			try {
				const result = await callback(transaction);
				this.database.run("COMMIT");
				return result;
			} catch (error) {
				this.database.run("ROLLBACK");
				throw error;
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		await this.enqueue(() => {
			this.closed = true;
			this.database.close();
		});
	}
}

export async function openBunSqliteDatabase(
	options: BunSqliteDatabaseOptions,
): Promise<BunSqliteDatabase> {
	const database = new Database(options.path, { create: true });
	database.run("PRAGMA journal_mode = WAL");
	database.run("PRAGMA synchronous = NORMAL");
	database.run(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
	database.run("PRAGMA foreign_keys = ON");
	return new BunSqliteDatabase(database);
}
