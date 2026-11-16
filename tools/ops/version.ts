#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const WORKSPACE_DIRECTORIES = ["apps", "packages", "plugins", "tools"] as const;

export interface VersionMismatch {
	readonly file: string;
	readonly version: string;
}

export interface VersionCheck {
	readonly expected: string;
	readonly mismatches: readonly VersionMismatch[];
	readonly version: string;
}

export function parseSemver(value: string): RegExpMatchArray | null {
	return SEMVER.exec(value.trim());
}

/** Existing package manifests that must carry the mainline VERSION verbatim. */
export function workspaceManifestPaths(root: string): readonly string[] {
	const paths: string[] = [];
	for (const directory of WORKSPACE_DIRECTORIES) {
		const absoluteDirectory = join(root, directory);
		if (!existsSync(absoluteDirectory)) continue;
		for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifest = join(absoluteDirectory, entry.name, "package.json");
			if (existsSync(manifest)) paths.push(manifest);
		}
	}
	return paths.toSorted();
}

export function checkManifestVersions(root: string, expected: string): VersionCheck {
	const mismatches: VersionMismatch[] = [];
	for (const path of workspaceManifestPaths(root)) {
		const manifest = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
		const version = typeof manifest.version === "string" ? manifest.version : "(missing)";
		if (version !== expected) {
			mismatches.push({ file: path.slice(root.length + 1), version });
		}
	}
	return { expected, mismatches, version: expected };
}

export function forkFileName(file: string): string {
	return file.replaceAll("\\", "/");
}

/**
 * Mainline-only version bump. It updates VERSION and every workspace package manifest together so
 * a release tag can never disagree with the packages it ships.
 */
export function bumpVersions(root: string, next: string): readonly string[] {
	if (parseSemver(next) === null) throw new Error(`not a semantic version: ${next}`);
	const changed: string[] = [];
	const versionPath = join(root, "VERSION");
	const current = readFileSync(versionPath, "utf8").trim();
	if (current === next) return changed;
	writeFileSync(versionPath, `${next}\n`);
	changed.push("VERSION");
	for (const path of workspaceManifestPaths(root)) {
		const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (manifest.version === next) continue;
		manifest.version = next;
		writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
		changed.push(forkFileName(path.slice(root.length + 1)));
	}
	return changed;
}

function git(root: string, args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

function tryGit(root: string, args: readonly string[]): string | undefined {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function refExists(root: string, ref: string): boolean {
	return tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== undefined;
}

function versionFiles(root: string): readonly string[] {
	return [
		"VERSION",
		...workspaceManifestPaths(root).map((path) => forkFileName(path.slice(root.length + 1))),
	];
}

function requireCleanVersionFiles(root: string): void {
	const files = versionFiles(root);
	const dirty = tryGit(root, ["status", "--porcelain", "--", ...files]);
	if (dirty !== undefined && dirty.length > 0) {
		throw new Error(
			`version files have uncommitted changes:\n${dirty}\nCommit or revert them before validating a release.`,
		);
	}
}

/**
 * A fork may merge upstream version bumps, but it may not author one. Only non-merge commits on
 * the fork side of `upstreamRef..HEAD` that touch a version file are rejected.
 */
export function checkVersionAuthority(root: string, upstreamRef: string): void {
	if (!refExists(root, upstreamRef)) {
		throw new Error(`upstream ref ${upstreamRef} is not available; run git fetch --all --tags`);
	}
	requireCleanVersionFiles(root);
	const files = versionFiles(root);
	const authored = tryGit(root, [
		"log",
		"--no-merges",
		"--format=%h %s",
		`${upstreamRef}..HEAD`,
		"--",
		...files,
	]);
	if (authored !== undefined && authored.length > 0) {
		throw new Error(
			[
				`Fork-authored commits must not change VERSION or workspace package versions:`,
				authored,
				"",
				"Version releases are produced only on the mainline. Merge upstream/main instead, then",
				"retry. If this fork is the mainline, pass --mainline to check explicitly.",
			].join("\n"),
		);
	}
}

function latestVersionTag(root: string): string | undefined {
	return tryGit(root, ["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0"]);
}

export function shortSha(root: string): string {
	return git(root, ["rev-parse", "--short=12", "HEAD"]);
}

export function exactVersionTag(root: string, version: string): string | undefined {
	const tag = tryGit(root, [
		"describe",
		"--tags",
		"--exact-match",
		"--match",
		`v${version}`,
		"HEAD",
	]);
	return tag === `v${version}` ? tag : undefined;
}

export function sanitizeDockerTag(value: string): string {
	return value
		.replaceAll(/[^A-Za-z0-9_.-]/gu, "-")
		.replaceAll(/-+/gu, "-")
		.slice(0, 128);
}

export function deploymentVersion(
	root: string,
	options: {
		readonly deployer?: string;
		readonly fork?: boolean;
	} = {},
): string {
	const version = readFileSync(join(root, "VERSION"), "utf8").trim();
	const tag = exactVersionTag(root, version);
	if (tag !== undefined) return version;
	const sha = shortSha(root);
	if (options.fork === true || options.deployer !== undefined) {
		const deployer = sanitizeDockerTag(options.deployer ?? "local");
		return sanitizeDockerTag(`${version}-fork.${deployer}.${sha}`);
	}
	const latest = latestVersionTag(root);
	const count =
		latest === undefined
			? tryGit(root, ["rev-list", "--count", "HEAD"])
			: tryGit(root, ["rev-list", "--count", `${latest}..HEAD`]);
	return sanitizeDockerTag(`${version}-dev.${count ?? "0"}.g${sha}`);
}

export interface ReleaseCheckOptions {
	readonly allowDetached?: boolean;
	readonly branch: string;
	readonly root: string;
	readonly tag: string;
}

export function checkRelease(options: ReleaseCheckOptions): void {
	const version = readFileSync(join(options.root, "VERSION"), "utf8").trim();
	if (parseSemver(version) === null) {
		throw new Error(`VERSION is not semantic: ${version}`);
	}
	const expectedTag = `v${version}`;
	if (options.tag !== expectedTag) {
		throw new Error(`release tag ${options.tag} does not match VERSION (${expectedTag})`);
	}
	const branch = tryGit(options.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const detachedRelease = options.allowDetached === true && branch === "HEAD";
	if (!detachedRelease && branch !== options.branch) {
		throw new Error(
			`release must be tagged from ${options.branch}, not ${branch ?? "detached HEAD"}`,
		);
	}
	const tagCommit = tryGit(options.root, ["rev-list", "-n", "1", options.tag]);
	if (tagCommit === undefined) throw new Error(`tag ${options.tag} does not exist locally`);
	const head = git(options.root, ["rev-parse", "HEAD"]);
	if (tagCommit !== head) throw new Error(`tag ${options.tag} does not point at HEAD`);
	const main = refExists(options.root, "origin/main") ? "origin/main" : "main";
	if (!refExists(options.root, main)) throw new Error(`mainline ref ${main} is missing`);
	const onMainline =
		spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", main], {
			cwd: options.root,
		}).status === 0;
	if (!onMainline) {
		throw new Error(`${options.tag} is not on ${main}; releases ship from mainline only`);
	}
	const latest = latestVersionTag(options.root);
	if (latest !== options.tag) {
		throw new Error(
			`release tag ${options.tag} is not the newest version tag (${latest ?? "none"})`,
		);
	}
	checkManifestVersions(options.root, version);
}

function usage(): string {
	return `Usage: bun tools/ops/version.ts <command> [options]

Commands:
  show [--deployer <name>] [--fork]   Print the version used for an image/build.
  bump <X.Y.Z>                        Mainline-only VERSION + workspace version bump.
  check [--upstream <ref>]            Validate VERSION, workspace manifests, and fork authority.
  release-check --tag <vX.Y.Z>        Validate a mainline release tag (also checks origin/main).
                     [--allow-detached]  CI checks out a tag in detached HEAD.
  workspace-paths                     Print manifest paths validated by check.

Policy: VERSION and workspace package versions are owned by mainline. A fork may merge upstream
version commits but must not author version-file changes.`;
}

function option(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, "../..");
	const argv = process.argv.slice(2);
	const command = argv[0] ?? "show";
	try {
		if (command === "show") {
			const deployer = option(argv, "--deployer");
			console.log(
				deploymentVersion(root, {
					...(deployer === undefined ? {} : { deployer }),
					fork: argv.includes("--fork"),
				}),
			);
		} else if (command === "bump") {
			const next = argv[1];
			if (next === undefined)
				throw new Error("bump requires a semantic version, for example 0.1.1");
			const branch = tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
			if (branch !== "main") throw new Error(`version bumps happen on main, not ${branch}`);
			const dirty = tryGit(root, ["status", "--porcelain"]);
			if (dirty !== undefined && dirty.length > 0) {
				throw new Error("commit or stash changes before bumping versions");
			}
			const changed = bumpVersions(root, next);
			console.log(changed.length === 0 ? `already at ${next}` : `bumped:\n${changed.join("\n")}`);
		} else if (command === "check") {
			const version = readFileSync(join(root, "VERSION"), "utf8").trim();
			if (parseSemver(version) === null) throw new Error(`VERSION is not semantic: ${version}`);
			const result = checkManifestVersions(root, version);
			if (result.mismatches.length > 0) {
				throw new Error(
					[
						`workspace manifests disagree with VERSION ${version}:`,
						...result.mismatches.map((entry) => `  ${entry.file}: ${entry.version}`),
						"Mainline owns version bumps; do not edit these files on a fork.",
					].join("\n"),
				);
			}
			const upstream = option(argv, "--upstream");
			if (upstream !== undefined && !argv.includes("--mainline")) {
				checkVersionAuthority(root, upstream);
			}
			console.log(
				`version ${version} is consistent${upstream === undefined ? "" : ` with ${upstream}`}`,
			);
		} else if (command === "release-check") {
			const tag = option(argv, "--tag");
			if (tag === undefined) throw new Error("release-check requires --tag vX.Y.Z");
			checkRelease({
				allowDetached: argv.includes("--allow-detached"),
				branch: option(argv, "--branch") ?? "main",
				root,
				tag,
			});
			console.log(`release ${tag} is valid`);
		} else if (command === "workspace-paths") {
			for (const path of workspaceManifestPaths(root))
				console.log(forkFileName(path.slice(root.length + 1)));
		} else if (command === "help" || command === "--help" || command === "-h") {
			console.log(usage());
		} else {
			throw new Error(`unknown command: ${command}\n\n${usage()}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
