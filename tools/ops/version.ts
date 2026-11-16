#!/usr/bin/env bun
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

function comparePrerelease(left: string | undefined, right: string | undefined): number {
	if (left === undefined && right === undefined) return 0;
	if (left === undefined) return 1;
	if (right === undefined) return -1;
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index] ?? "";
		const rightPart = rightParts[index] ?? "";
		const leftNumeric = /^\d+$/u.test(leftPart);
		const rightNumeric = /^\d+$/u.test(rightPart);
		if (leftNumeric && rightNumeric) {
			const difference = Number(leftPart) - Number(rightPart);
			if (difference !== 0) return difference < 0 ? -1 : 1;
			continue;
		}
		if (leftNumeric) return -1;
		if (rightNumeric) return 1;
		if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
	}
	if (leftParts.length === rightParts.length) return 0;
	return leftParts.length < rightParts.length ? -1 : 1;
}

/** Compare two strict SemVer values. Build metadata is ignored for precedence. */
export function compareSemver(left: string, right: string): number {
	const leftMatch = parseSemver(left);
	const rightMatch = parseSemver(right);
	if (leftMatch === null) throw new Error(`not a semantic version: ${left}`);
	if (rightMatch === null) throw new Error(`not a semantic version: ${right}`);
	for (const index of [1, 2, 3] as const) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return comparePrerelease(leftMatch[4], rightMatch[4]);
}

/**
 * Every deployment must increase VERSION in strict SemVer order. The first deployment has no
 * previous version and is accepted as-is.
 */
export function assertVersionIncrease(current: string, previous?: string): void {
	if (parseSemver(current) === null) {
		throw new Error(`VERSION is not strict SemVer: ${current}`);
	}
	const normalizedPrevious = previous?.trim();
	if (normalizedPrevious === undefined || normalizedPrevious === "") return;
	if (parseSemver(normalizedPrevious) === null) {
		throw new Error(`previous deployed VERSION is not strict SemVer: ${normalizedPrevious}`);
	}
	if (compareSemver(current, normalizedPrevious) <= 0) {
		throw new Error(
			`VERSION must increase for every deployment (deployed: ${normalizedPrevious}, local: ${current})`,
		);
	}
}

/** Existing package manifests that must carry the workspace VERSION verbatim. */
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
 * Strict deployment bump. It updates VERSION and every workspace package manifest together so a
 * built image can never disagree with the packages it ships.
 */
export function bumpVersions(root: string, next: string): readonly string[] {
	if (parseSemver(next) === null) throw new Error(`not a semantic version: ${next}`);
	const changed: string[] = [];
	const versionPath = join(root, "VERSION");
	const current = readFileSync(versionPath, "utf8").trim();
	if (parseSemver(current) === null) throw new Error(`VERSION is not strict SemVer: ${current}`);
	if (compareSemver(next, current) <= 0) {
		throw new Error(`next version ${next} must be greater than current VERSION ${current}`);
	}
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

function usage(): string {
	return `Usage: bun tools/ops/version.ts <command> [options]

Commands:
  show                                Print the current VERSION.
  bump <X.Y.Z>                        Update VERSION and every workspace manifest together.
  check                               Validate VERSION and workspace manifest consistency.
  require-bump [--previous <version>] Fail unless VERSION is a strict SemVer increase.
  workspace-paths                     Print manifest paths validated by check.

Policy: every deployment increases VERSION using strict SemVer. Images are built from that
version; there is no tag-triggered release pipeline.`;
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
			console.log(readFileSync(join(root, "VERSION"), "utf8").trim());
		} else if (command === "bump") {
			const next = argv[1];
			if (next === undefined)
				throw new Error("bump requires a semantic version, for example 0.1.1");
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
						"Run `bun run version:bump <X.Y.Z>` to update VERSION and every manifest together.",
					].join("\n"),
				);
			}
			console.log(`version ${version} is consistent`);
		} else if (command === "require-bump") {
			const version = readFileSync(join(root, "VERSION"), "utf8").trim();
			assertVersionIncrease(version, option(argv, "--previous"));
			console.log(`version ${version} is a valid deployment bump`);
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
