import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

export { SqliteStorage };
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openBunSqliteDatabase } from "./bun-sqlite.ts";

export async function openDurableStorage(path: string): Promise<SqliteStorage> {
	const database = await openBunSqliteDatabase({ path });
	return await SqliteStorage.open(database, { prefix: "tsukaima_" });
}

export { BACKGROUND_CONTEXT };
