import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bumpVersions,
	checkManifestVersions,
	checkRelease,
	checkVersionAuthority,
	deploymentVersion,
	parseSemver,
	sanitizeDockerTag,
	workspaceManifestPaths,
} from "./version.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

function git(root: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

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
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "add", ".");
	git(root, "commit", "-m", "initial");
	return root;
}

describe("version authority", () => {
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

	test("rejects fork-authored version changes but accepts upstream merges", async () => {
		const root = await repository();
		git(root, "checkout", "-b", "deploy/keiko");
		await fs.writeFile(join(root, "apps/server/feature.ts"), "export const feature = true;\n");
		git(root, "add", ".");
		git(root, "commit", "-m", "feat(server): local feature");
		expect(() => checkVersionAuthority(root, "main")).not.toThrow();

		await fs.writeFile(join(root, "VERSION"), "0.2.0\n");
		git(root, "add", "VERSION");
		git(root, "commit", "-m", "chore(release): bump");
		expect(() => checkVersionAuthority(root, "main")).toThrow("must not change VERSION");
	});

	test("bumps VERSION and every workspace manifest together", async () => {
		const root = await repository();
		const changed = bumpVersions(root, "0.2.0");
		expect(changed).toContain("VERSION");
		expect(changed).toHaveLength(5);
		expect(checkManifestVersions(root, "0.2.0").mismatches).toEqual([]);
		expect(await fs.readFile(join(root, "VERSION"), "utf8")).toBe("0.2.0\n");
	});

	test("labels tagged releases and fork builds differently", async () => {
		const root = await repository();
		git(root, "tag", "-a", "v0.1.0", "-m", "release 0.1.0");
		expect(deploymentVersion(root)).toBe("0.1.0");

		await fs.writeFile(join(root, "apps/server/feature.ts"), "export const feature = true;\n");
		git(root, "add", ".");
		git(root, "commit", "-m", "feat(server): local feature");
		expect(deploymentVersion(root, { deployer: "keiko", fork: true })).toMatch(
			/^0\.1\.0-fork\.keiko\.[0-9a-f]{12}$/u,
		);
		expect(deploymentVersion(root)).toMatch(/^0\.1\.0-dev\.1\.g[0-9a-f]{12}$/u);
	});

	test("rejects tags that do not match VERSION, HEAD, or mainline", async () => {
		const root = await repository();
		git(root, "tag", "-a", "v0.1.0", "-m", "release 0.1.0");
		expect(() => checkRelease({ branch: "main", root, tag: "v0.1.0" })).not.toThrow();
		expect(() => checkRelease({ branch: "main", root, tag: "v0.2.0" })).toThrow(
			"does not match VERSION",
		);

		await fs.writeFile(join(root, "README.md"), "changed\n");
		git(root, "add", ".");
		git(root, "commit", "-m", "docs: change");
		expect(() => checkRelease({ branch: "main", root, tag: "v0.1.0" })).toThrow(
			"does not point at HEAD",
		);
	});

	test("sanitizes Docker tags and keeps them within the registry limit", () => {
		expect(sanitizeDockerTag("0.1.0-fork.keiko/../abc")).toBe("0.1.0-fork.keiko-..-abc");
		expect(sanitizeDockerTag("x".repeat(300))).toHaveLength(128);
	});
});
