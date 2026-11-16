import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

export * from "./schema.ts";

export type TsukaimaDatabase = ReturnType<typeof drizzle<typeof schema>>;

export async function openDomainDatabase(path: string): Promise<TsukaimaDatabase> {
	const database = new Database(path, { create: true });
	database.run("PRAGMA journal_mode = WAL");
	database.run("PRAGMA synchronous = NORMAL");
	database.run("PRAGMA busy_timeout = 5000");
	database.run("PRAGMA foreign_keys = ON");
	return drizzle(database, { schema });
}

export function migrateDomainDatabase(database: TsukaimaDatabase): void {
	migrate(database, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
}
