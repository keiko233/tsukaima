import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bumpVersions,
	compareSemver,
	checkManifestVersions,
	assertVersionIncrease,
	parseSemver,
	workspaceManifestPaths,
} from "./version.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function repository(version = "0.1.0"): Promise<string> {
	const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-version-"));
	directories.push(root);
	await fs.writeFile(join(root, "VERSION"), `${version}\n`);
	for (const directory of ["apps/server", "packages/core", "plugins/onebot-napcat", "tools/ops"]) {
		await fs.mkdir(join(root, directory), { recursive: true });
		await fs.writeFile(
			join(root, directory, "package.json"),
			JSON.stringify({ name: directory, version }, null, "\t"),
		);
	}
	return root;
}

describe("version policy", () => {
	test("accepts semantic versions and rejects loose labels", () => {
		expect(parseSemver("0.1.0")).not.toBeNull();
		expect(parseSemver("1.2.3-rc.1+build.4")).not.toBeNull();
		expect(parseSemver("v0.1.0")).toBeNull();
		expect(parseSemver("0.1")).toBeNull();
	});

	test("requires every workspace manifest to match VERSION", async () => {
		const root = await repository();
		expect(workspaceManifestPaths(root)).toHaveLength(4);
		expect(checkManifestVersions(root, "0.1.0").mismatches).toEqual([]);
		await fs.writeFile(join(root, "apps/server/package.json"), '{"version":"0.2.0"}');
		const result = checkManifestVersions(root, "0.1.0");
		expect(result.mismatches).toEqual([{ file: "apps/server/package.json", version: "0.2.0" }]);
	});

	test("bumps VERSION and every workspace manifest together", async () => {
		const root = await repository();
		expect(() => bumpVersions(root, "0.1.0")).toThrow("must be greater");
		expect(() => bumpVersions(root, "0.0.9")).toThrow("must be greater");
		expect(() => bumpVersions(root, "0.2")).toThrow("not a semantic version");
		const changed = bumpVersions(root, "0.2.0");
		expect(changed).toContain("VERSION");
		expect(changed).toHaveLength(5);
		expect(checkManifestVersions(root, "0.2.0").mismatches).toEqual([]);
		expect(await fs.readFile(join(root, "VERSION"), "utf8")).toBe("0.2.0\n");
	});

	test("compares strict SemVer values and requires every deployment to increase", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
		expect(compareSemver("1.2.3-rc.1", "1.2.3")).toBe(-1);
		expect(compareSemver("1.2.3-rc.10", "1.2.3-rc.2")).toBe(1);
		expect(compareSemver("1.2.3-1", "1.2.3-alpha")).toBe(-1);
		expect(compareSemver("1.2.3+build.2", "1.2.3+build.1")).toBe(0);
		expect(() => assertVersionIncrease("1.2.4", "1.2.3")).not.toThrow();
		expect(() => assertVersionIncrease("1.3.0-rc.1", "1.2.9")).not.toThrow();
		expect(() => assertVersionIncrease("1.2.3", undefined)).not.toThrow();
		expect(() => assertVersionIncrease("1.2.3", "1.2.3")).toThrow("must increase");
		expect(() => assertVersionIncrease("1.2.3", "1.2.4")).toThrow("must increase");
		expect(() => assertVersionIncrease("01.2.3", undefined)).toThrow("not strict SemVer");
	});
});
