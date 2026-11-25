import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeVersion } from "../src/version.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function checkout(version?: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-version-"));
	directories.push(directory);
	if (version !== undefined) await writeFile(join(directory, "VERSION"), version);
	return directory;
}

describe("runtimeVersion", () => {
	test("prefers the live VERSION file over the injected environment value", async () => {
		const directory = await checkout("9.9.9\n");
		expect(runtimeVersion({ TSUKAIMA_VERSION: "1.2.3" }, directory)).toBe("9.9.9");
	});

	test("falls back to TSUKAIMA_VERSION when VERSION is missing", async () => {
		const directory = await checkout();
		expect(runtimeVersion({ TSUKAIMA_VERSION: "1.2.3" }, directory)).toBe("1.2.3");
	});

	test("falls back to TSUKAIMA_VERSION when VERSION is empty", async () => {
		const directory = await checkout("\n");
		expect(runtimeVersion({ TSUKAIMA_VERSION: "1.2.3" }, directory)).toBe("1.2.3");
	});

	test("uses the bundled fallback when neither source is available", async () => {
		const directory = await checkout();
		expect(runtimeVersion({}, directory)).toBe("0.1.0");
	});
});
