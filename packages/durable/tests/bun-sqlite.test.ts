import { describe, expect, test } from "bun:test";
import { openBunSqliteDatabase } from "../src/bun-sqlite.ts";

describe("Bun SQLite adapter", () => {
	test("executes reads and writes", async () => {
		const database = await openBunSqliteDatabase({ path: ":memory:" });
		await database.exec("CREATE TABLE examples (id INTEGER PRIMARY KEY, value TEXT)");
		await database.run("INSERT INTO examples (id, value) VALUES (?, ?)", 1, "first");
		const row = await database.get<{ id: number; value: string }>(
			"SELECT id, value FROM examples WHERE id = ?",
			1,
		);
		expect(row).toEqual({ id: 1, value: "first" });
		await database.close();
	});

	test("rolls back failed transactions", async () => {
		const database = await openBunSqliteDatabase({ path: ":memory:" });
		await database.exec("CREATE TABLE examples (id INTEGER PRIMARY KEY)");
		await expect(
			database.transaction(async (tx) => {
				await tx.run("INSERT INTO examples (id) VALUES (?)", 1);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await database.get("SELECT id FROM examples")).toBeUndefined();
		await database.close();
	});
});
