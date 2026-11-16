import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openBunSqliteDatabase, SqliteStorage } from "@tsukaima/durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { TransientStorage, type TransientStorageOptions } from "./failure.ts";

export interface ChaoticStorageOptions extends TransientStorageOptions {
	readonly busyTimeoutMs?: number;
}

export async function openChaoticStorage(
	path: string,
	options: ChaoticStorageOptions = {},
): Promise<{ readonly storage: TransientStorage; readonly close: () => Promise<void> }> {
	const database: SqliteDatabase = await openBunSqliteDatabase(
		options.busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs: options.busyTimeoutMs },
	);
	const storage = await SqliteStorage.open(database, { prefix: "tsukaima_" });
	const chaotic = new TransientStorage(storage, options);
	return {
		storage: chaotic,
		close: async () => {
			await chaotic.close(BACKGROUND_CONTEXT);
		},
	};
}
