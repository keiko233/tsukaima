#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Render and prepend one release section to CHANGELOG.md.
 *
 * The publish workflow calls this after bumping VERSION, so the changelog, the tag, and the GitHub
 * release all describe the same commit range. Conventional-commit prefixes decide the group;
 * `chore` is skipped so release bumps and housekeeping do not appear as user-visible changes.
 */

export const CHANGELOG_HEADER = `# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).
`;

export interface ChangelogCommit {
	readonly hash: string;
	readonly subject: string;
}

export interface ParsedSubject {
	readonly scope?: string;
	readonly text: string;
	readonly type: string;
}

export type ChangeGroup = "added" | "changed" | "fixed" | "skip";

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?!?:\s*(?<text>.+)$/u;

export function parseSubject(subject: string): ParsedSubject {
	const trimmed = subject.trim();
	const match = CONVENTIONAL.exec(trimmed);
	const groups = match?.groups;
	if (groups === undefined || groups.type === undefined || groups.text === undefined) {
		return { text: trimmed, type: "other" };
	}
	return {
		...(groups.scope === undefined ? {} : { scope: groups.scope }),
		text: groups.text,
		type: groups.type,
	};
}

export function classify(type: string): ChangeGroup {
	switch (type) {
		case "feat":
			return "added";
		case "fix":
			return "fixed";
		case "chore":
			return "skip";
		case "build":
		case "ci":
		case "docs":
		case "perf":
		case "refactor":
		case "revert":
		case "style":
		case "test":
			return "changed";
		default:
			return "changed";
	}
}

const GROUP_TITLES: readonly [Exclude<ChangeGroup, "skip">, string][] = [
	["added", "Added"],
	["changed", "Changed"],
	["fixed", "Fixed"],
];

export function renderSection(input: {
	readonly commits: readonly ChangelogCommit[];
	readonly date: string;
	readonly version: string;
}): string {
	const groups: Record<"added" | "changed" | "fixed", string[]> = {
		added: [],
		changed: [],
		fixed: [],
	};
	for (const commit of input.commits) {
		if (commit.hash.length === 0 || commit.subject.trim().length === 0) continue;
		const parsed = parseSubject(commit.subject);
		const group = classify(parsed.type);
		if (group === "skip") continue;
		const label = parsed.scope === undefined ? parsed.text : `${parsed.scope}: ${parsed.text}`;
		groups[group].push(`- ${label} (${commit.hash})`);
	}
	const lines = [`## [${input.version}] - ${input.date}`, ""];
	for (const [group, title] of GROUP_TITLES) {
		const entries = groups[group];
		if (entries.length === 0) continue;
		lines.push(`### ${title}`, ...entries, "");
	}
	if (lines.length === 2) lines.push("- No user-visible changes.", "");
	return lines.join("\n").trimEnd();
}

/** Insert or replace one version section, newest first, below the file header. */
export function insertSection(existing: string, version: string, section: string): string {
	const base = existing.trim().length === 0 ? CHANGELOG_HEADER : existing;
	const clean = section.trim();
	const marker = `## [${version}]`;
	const start = base.indexOf(marker);
	if (start !== -1) {
		const rest = base.slice(start);
		const next = rest.indexOf("\n## [", marker.length);
		const before = base.slice(0, start);
		const after = next === -1 ? "" : rest.slice(next + 1);
		return `${before}${clean}\n\n${after}`.trimEnd() + "\n";
	}
	const first = base.indexOf("\n## [");
	if (first === -1) return `${base.trimEnd()}\n\n${clean}\n`;
	const head = base.slice(0, first + 1);
	const tail = base.slice(first + 1);
	return `${head}${clean}\n\n${tail}`.trimEnd() + "\n";
}

function option(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

function usage(): string {
	return `Usage: bun tools/ops/changelog.ts <version> [options]

Options:
  --since <ref>        Start of the commit range (default: the whole history).
  --until <ref>        End of the commit range (default: HEAD).
  --date <YYYY-MM-DD>  Section date (default: today in UTC).
  --notes-file <path>  Also write the rendered section to this file.

The section is prepended to CHANGELOG.md; an existing section for the same version is replaced.`;
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, "../..");
	const argv = process.argv.slice(2);
	const version = argv[0];
	if (version === undefined || version.startsWith("-")) {
		console.error(usage());
		process.exit(1);
	}
	const since = option(argv, "--since");
	const until = option(argv, "--until") ?? "HEAD";
	const date = option(argv, "--date") ?? new Date().toISOString().slice(0, 10);
	const notesFile = option(argv, "--notes-file");
	const range = since === undefined ? until : `${since}..${until}`;
	const output = execFileSync("git", ["log", range, "--no-merges", "--pretty=format:%h%x1f%s"], {
		cwd: root,
		encoding: "utf8",
	});
	const commits: ChangelogCommit[] = output
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const [hash, subject] = line.split("\u001f");
			return { hash: hash ?? "", subject: subject ?? "" };
		})
		.filter((commit) => !commit.subject.startsWith("chore(release)"));
	const section = renderSection({ commits, date, version });
	const path = join(root, "CHANGELOG.md");
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	writeFileSync(path, insertSection(existing, version, section));
	if (notesFile !== undefined) writeFileSync(resolve(root, notesFile), `${section}\n`);
	console.log(section);
}
