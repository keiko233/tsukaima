import { Database } from "bun:sqlite";
import type { TsukaimaDatabase } from "@tsukaima/db";

const ALLOWED_TABLES = new Set([
	"audit_log",
	"coding_approvals",
	"coding_deployments",
	"coding_proposals",
	"coding_tasks",
	"conversations",
	"prompt_hooks",
	"schedules",
	"schedule_occurrences",
	"workspace_references",
	"workspace_sessions",
	"workspace_todos",
]);
const MAX_ROWS = 500;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_SQL_LENGTH = 8_000;

const FORBIDDEN =
	/\b(?:attach|detach|insert|update|delete|drop|alter|create|replace|vacuum|reindex|pragma)\b/iu;
const READ_QUERY = /^\s*(?:select|with)\b/iu;
const EXPLAIN_QUERY = /^\s*explain\s+query\s+plan\b/iu;

function assertReadOnly(sql: string): void {
	if (sql.length > MAX_SQL_LENGTH) throw new Error("SQL is too long");
	if (sql.includes(";")) throw new Error("Only one statement is allowed");
	if (!READ_QUERY.test(sql) && !EXPLAIN_QUERY.test(sql)) {
		throw new Error("Only SELECT, WITH, or EXPLAIN QUERY PLAN is allowed");
	}
	if (FORBIDDEN.test(sql)) throw new Error("Only read-only queries are allowed");
}

function referencedTables(sql: string): string[] {
	const tables = new Set<string>();
	const pattern = /\b(?:from|join)\s+["'`]?([a-z_][a-z0-9_]*)["'`]?/giu;
	for (const match of sql.matchAll(pattern)) {
		const table = match[1]?.toLowerCase();
		if (table !== undefined) tables.add(table);
	}
	return [...tables];
}

/**
 * Read-only diagnostics for the running domain database.
 *
 * SQLite `query_only` protects against writes, but it is not a table ACL. Queries are restricted
 * to an explicit allowlist and run against a serialized snapshot so a slow or hostile query
 * cannot hold the live database connection.
 */
export class WorkspaceSqlService {
	readonly #database: () => TsukaimaDatabase | undefined;

	constructor(options: { readonly database: () => TsukaimaDatabase | undefined }) {
		this.#database = options.database;
	}

	async schema(table?: string): Promise<Record<string, unknown>> {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		const client = database.$client as Database;
		const rows = client
			.query("select name from sqlite_master where type = 'table' order by name")
			.all() as Array<{ name: string }>;
		const allowed = rows
			.map((row) => row.name)
			.filter((name) => ALLOWED_TABLES.has(name))
			.filter((name) => table === undefined || name === table);
		return {
			tables: allowed.map((name) => ({
				columns: (
					client.query(`pragma table_info(${JSON.stringify(name)})`).all() as Array<{
						name: string;
						type: string;
					}>
				).map((column) => ({ name: column.name, type: column.type })),
				name,
			})),
		};
	}

	async query(input: {
		readonly params?: readonly unknown[];
		readonly sql: string;
	}): Promise<Record<string, unknown>> {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		const sql = input.sql.trim();
		assertReadOnly(sql);
		const tables = referencedTables(sql);
		const denied = tables.filter((table) => !ALLOWED_TABLES.has(table));
		if (denied.length > 0) throw new Error(`Table is not available: ${denied.join(", ")}`);
		const client = database.$client as Database;
		// A serialized WAL database cannot be reopened from memory; open the same file read-only
		// instead. Writes are still blocked both by the connection flag and `query_only`.
		const snapshot =
			client.filename === ":memory:"
				? Database.deserialize(client.serialize(), { readonly: true, strict: true })
				: new Database(client.filename, { readonly: true, strict: true });
		snapshot.run("pragma query_only = on");
		const startedAt = performance.now();
		try {
			// EXPLAIN QUERY PLAN is a statement prefix, not a subquery, so it runs unwrapped and
			// the row cap still bounds its output.
			const statement = EXPLAIN_QUERY.test(sql)
				? snapshot.query(sql)
				: snapshot.query(`select * from (${sql}) limit ${MAX_ROWS + 1}`);
			const rows = statement.all(...((input.params ?? []) as never[])) as unknown[];
			const truncated = rows.length > MAX_ROWS;
			const limited = rows.slice(0, MAX_ROWS);
			const text = JSON.stringify(limited);
			return {
				durationMs: Math.round(performance.now() - startedAt),
				rowCount: limited.length,
				rows:
					Buffer.byteLength(text, "utf-8") > MAX_OUTPUT_BYTES
						? limited.slice(0, Math.max(1, Math.floor(limited.length / 2)))
						: limited,
				truncated: truncated || Buffer.byteLength(text, "utf-8") > MAX_OUTPUT_BYTES,
			};
		} finally {
			snapshot.close();
		}
	}
}
