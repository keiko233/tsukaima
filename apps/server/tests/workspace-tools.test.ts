import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDomainDatabase, migrateDomainDatabase } from "@tsukaima/db";
import { WorkspaceSqlService } from "../src/services/workspace-sql.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function service() {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-workspace-sql-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return new WorkspaceSqlService({ database: () => database });
}

describe("workspace SQL diagnostics", () => {
	test("lists only allowlisted tables and columns", async () => {
		const sql = await service();
		const schema = (await sql.schema()) as {
			tables: Array<{ columns: Array<{ name: string }>; name: string }>;
		};
		const names = schema.tables.map((table) => table.name);
		expect(names).toContain("workspace_todos");
		expect(names).toContain("coding_tasks");
		expect(names).not.toContain("users");
		expect(names).not.toContain("auth_user");
		expect(schema.tables.find((table) => table.name === "workspace_todos")?.columns).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "content" })]),
		);
	});

	test("runs bounded SELECT queries and rejects writes or denied tables", async () => {
		const sql = await service();
		const result = await sql.query({
			sql: "select count(*) as count from workspace_sessions",
		});
		expect(result.rowCount).toBe(1);
		await expect(sql.query({ sql: "delete from workspace_todos" })).rejects.toThrow(
			"Only SELECT, WITH, or EXPLAIN QUERY PLAN is allowed",
		);
		await expect(sql.query({ sql: "select * from users" })).rejects.toThrow(
			"Table is not available",
		);
		await expect(
			sql.query({ sql: "select * from workspace_todos; select * from users" }),
		).rejects.toThrow("Only one statement is allowed");
		const plan = await sql.query({ sql: "EXPLAIN QUERY PLAN select * from workspace_todos" });
		expect(plan.rowCount).toBeGreaterThan(0);
	});
});
