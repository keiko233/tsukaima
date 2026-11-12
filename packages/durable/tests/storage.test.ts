import { describe, expect, test } from "bun:test";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDurableStorage } from "../src/index.ts";

const cases = createStorageConformance({
	assertions: {
		deepEqual: (actual, expected) => expect(actual).toEqual(expected),
		greaterThan: (actual, expected) => expect(actual).toBeGreaterThan(expected),
		ok: (value, _message) => expect(value).toBeTrue(),
		partialDeepEqual: (actual: unknown, expected: unknown) =>
			expect(actual).toMatchObject(expected as object),
		rejects: async (operation, messageIncludes) =>
			await expect(operation).rejects.toThrow(messageIncludes),
		strictEqual: (actual, expected) => expect(actual).toBe(expected),
	},
	withStorage: async (use) => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-durable-"));
		try {
			await use(await openDurableStorage(join(directory, "durable.sqlite")));
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	},
});

describe("pi-durable Bun SQLite storage", () => {
	for (const storageCase of cases) {
		test(storageCase.name, async () => {
			await storageCase.run();
		});
	}
});
