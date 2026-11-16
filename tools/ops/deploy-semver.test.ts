import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const helper = join(import.meta.dir, "../../ops/deploy/semver.sh");

function compare(left: string, right: string): number {
	const result = spawnSync(
		"bash",
		["-c", 'source "$1"; semver_compare "$2" "$3"', "semver", helper, left, right],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return Number(result.stdout.trim());
}

function valid(version: string): boolean {
	const result = spawnSync(
		"bash",
		["-c", 'source "$1"; semver_valid "$2"', "semver", helper, version],
		{ encoding: "utf8" },
	);
	return result.status === 0;
}

describe("deployment SemVer helper", () => {
	test("matches SemVer precedence for releases, prereleases, and build metadata", () => {
		expect(compare("1.2.3", "1.2.3")).toBe(0);
		expect(compare("1.3.0", "1.2.9")).toBe(1);
		expect(compare("1.2.3-rc.1", "1.2.3")).toBe(-1);
		expect(compare("1.2.3-rc.10", "1.2.3-rc.2")).toBe(1);
		expect(compare("1.2.3-1", "1.2.3-alpha")).toBe(-1);
		expect(compare("1.2.3+build.2", "1.2.3+build.1")).toBe(0);
	});

	test("rejects loose or malformed versions", () => {
		expect(valid("1.2.3")).toBe(true);
		expect(valid("1.2.3-rc.1+build.5")).toBe(true);
		expect(valid("v1.2.3")).toBe(false);
		expect(valid("1.2")).toBe(false);
		expect(valid("01.2.3")).toBe(false);
		expect(valid("1.2.3-")).toBe(false);
	});
});
