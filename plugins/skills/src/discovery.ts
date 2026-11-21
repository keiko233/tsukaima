import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	SKILL_DOCUMENT_MAX_BYTES,
	SKILL_MAX_SKILLS,
	SKILL_RESOURCE_LIST_MAX,
	type SkillDiagnostic,
	type SkillResource,
} from "@tsukaima/contracts";
import type { SkillsConfig } from "./config.ts";
import { parseSkillDocument, validateSkillFields, type SkillFields } from "./frontmatter.ts";
import {
	isInside,
	readFileInside,
	resolveEntryInside,
	resolveInside,
	type PathFailure,
} from "./paths.ts";

export interface SkillRecord {
	readonly allowedTools?: readonly string[];
	readonly compatibility?: string;
	readonly description: string;
	/** Real path of the skill directory; never exposed outside the plugin runtime. */
	readonly directory: string;
	readonly enabled: boolean;
	readonly fingerprint: string;
	readonly license?: string;
	readonly metadata?: Record<string, string>;
	readonly name: string;
	readonly rootIndex: number;
}

export interface ScanResult {
	readonly diagnostics: readonly SkillDiagnostic[];
	readonly roots: number;
	readonly scannedAtMs: number;
	readonly skills: readonly SkillRecord[];
}

export interface ScanOptions {
	readonly maxSkills?: number;
}

export interface SkillResourceListing {
	readonly resources: readonly SkillResource[];
	readonly truncated: boolean;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { readonly code?: unknown }).code)
		: undefined;
}

function skillDiagnostic(
	code: SkillDiagnostic["code"],
	level: SkillDiagnostic["level"],
	message: string,
	rootIndex: number,
	name?: string,
): SkillDiagnostic {
	return {
		code,
		level,
		message,
		rootIndex,
		...(name === undefined ? {} : { name }),
	};
}

function documentDiagnostic(
	rootIndex: number,
	directoryName: string,
	reason: PathFailure,
): SkillDiagnostic {
	// Path details are deliberately not interpolated: diagnostics may reach the WebUI and logs.
	switch (reason) {
		case "too_large":
			return skillDiagnostic(
				"too_large",
				"error",
				"SKILL.md exceeds the 256 KiB document limit",
				rootIndex,
				directoryName,
			);
		case "not_text":
			return skillDiagnostic(
				"not_utf8",
				"error",
				"SKILL.md is not valid UTF-8 text",
				rootIndex,
				directoryName,
			);
		case "escapes_root":
			return skillDiagnostic(
				"escapes_root",
				"error",
				"SKILL.md resolves outside its skill directory",
				rootIndex,
				directoryName,
			);
		default:
			return skillDiagnostic(
				"missing_skill_md",
				"warning",
				"skill directory has no readable SKILL.md",
				rootIndex,
				directoryName,
			);
	}
}

/** Builds the record used by the catalog after a document passed parsing and validation. */
function recordFor(
	fields: SkillFields,
	input: {
		readonly directory: string;
		readonly enabled: boolean;
		readonly fingerprint: string;
		readonly rootIndex: number;
	},
): SkillRecord {
	return {
		description: fields.description,
		directory: input.directory,
		enabled: input.enabled,
		fingerprint: input.fingerprint,
		name: fields.name,
		rootIndex: input.rootIndex,
		...(fields.allowedTools === undefined ? {} : { allowedTools: fields.allowedTools }),
		...(fields.compatibility === undefined ? {} : { compatibility: fields.compatibility }),
		...(fields.license === undefined ? {} : { license: fields.license }),
		...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
	};
}

async function scanRoot(
	config: SkillsConfig,
	root: string,
	rootIndex: number,
	seen: Set<string>,
	maxSkills: number,
	state: { limitReached: boolean },
	skills: SkillRecord[],
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	let rootReal: string;
	try {
		const info = await stat(root);
		if (!info.isDirectory()) {
			diagnostics.push(
				skillDiagnostic(
					"root_not_directory",
					"warning",
					"configured skill root is not a directory",
					rootIndex,
				),
			);
			return;
		}
		rootReal = await realpath(root);
	} catch (error) {
		diagnostics.push(
			skillDiagnostic(
				errorCode(error) === "ENOENT" ? "root_missing" : "root_unreadable",
				"warning",
				errorCode(error) === "ENOENT"
					? "configured skill root does not exist"
					: "configured skill root is not readable",
				rootIndex,
			),
		);
		return;
	}

	let entries: Dirent[];
	try {
		entries = await readdir(rootReal, { withFileTypes: true });
	} catch {
		diagnostics.push(
			skillDiagnostic(
				"root_unreadable",
				"warning",
				"configured skill root is not readable",
				rootIndex,
			),
		);
		return;
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		let directory: string;
		try {
			directory = await realpath(join(rootReal, entry.name));
			const info = await stat(directory);
			if (!info.isDirectory()) continue;
		} catch {
			continue;
		}
		if (!isInside(rootReal, directory)) {
			diagnostics.push(
				skillDiagnostic(
					"escapes_root",
					"warning",
					"skill directory resolves outside its configured root",
					rootIndex,
					entry.name,
				),
			);
			continue;
		}

		const marked = await resolveInside(directory, "SKILL.md");
		if (!marked.ok) {
			diagnostics.push(documentDiagnostic(rootIndex, entry.name, marked.reason));
			continue;
		}
		const document = await readFileInside(directory, "SKILL.md", SKILL_DOCUMENT_MAX_BYTES);
		if (!document.ok) {
			diagnostics.push(documentDiagnostic(rootIndex, entry.name, document.reason));
			continue;
		}
		const parsed = parseSkillDocument(document.value.text);
		if (!parsed.ok) {
			diagnostics.push(
				skillDiagnostic("invalid_frontmatter", "error", parsed.message, rootIndex, entry.name),
			);
			continue;
		}
		const validated = validateSkillFields(parsed.document.frontmatter, entry.name);
		for (const diagnostic of validated.diagnostics) {
			diagnostics.push({ ...diagnostic, rootIndex });
		}
		if (validated.fields === undefined) continue;
		const fields = validated.fields;
		if (seen.has(fields.name)) {
			diagnostics.push(
				skillDiagnostic(
					"duplicate_name",
					"warning",
					"another skill already uses this name; the first one wins",
					rootIndex,
					fields.name,
				),
			);
			continue;
		}
		if (skills.length >= maxSkills) {
			if (!state.limitReached) {
				state.limitReached = true;
				diagnostics.push(
					skillDiagnostic(
						"limit_reached",
						"warning",
						`skill catalog stopped at ${maxSkills} entries`,
						rootIndex,
					),
				);
			}
			continue;
		}
		seen.add(fields.name);
		skills.push(
			recordFor(fields, {
				directory,
				enabled: !config.disabled.has(fields.name),
				fingerprint: `${document.value.text.length}:${String(Bun.hash(document.value.text))}`,
				rootIndex,
			}),
		);
	}
}

/**
 * Discovers depth-1 skill directories under every configured root. This function never throws:
 * a broken root or skill becomes a bounded diagnostic and the rest of the catalog still loads.
 */
export async function scanSkillRoots(
	config: SkillsConfig,
	options: ScanOptions = {},
): Promise<ScanResult> {
	const maxSkills = options.maxSkills ?? SKILL_MAX_SKILLS;
	const skills: SkillRecord[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const seen = new Set<string>();
	const state = { limitReached: false };
	for (const [rootIndex, root] of config.paths.entries()) {
		try {
			await scanRoot(config, root, rootIndex, seen, maxSkills, state, skills, diagnostics);
		} catch {
			diagnostics.push(
				skillDiagnostic(
					"root_unreadable",
					"warning",
					"configured skill root could not be scanned",
					rootIndex,
				),
			);
		}
	}
	return {
		diagnostics,
		roots: config.paths.length,
		scannedAtMs: Date.now(),
		skills,
	};
}

/**
 * Lists bundled resource files up to three path segments deep. Hidden entries, SKILL.md, and
 * node_modules are skipped; every candidate still goes through the root-containment check.
 */
export async function walkSkillResources(directoryReal: string): Promise<SkillResourceListing> {
	const resources: SkillResource[] = [];
	let truncated = false;
	const walk = async (relative: string, depth: number): Promise<void> => {
		if (truncated) return;
		const target = relative.length === 0 ? directoryReal : join(directoryReal, relative);
		let entries: Dirent[];
		try {
			entries = await readdir(target, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
			if (depth === 1 && entry.name === "SKILL.md") continue;
			const resolved = await resolveEntryInside(directoryReal, child);
			if (!resolved.ok) continue;
			const info = await stat(resolved.value.real).catch(() => undefined);
			if (info === undefined) continue;
			if (info.isDirectory()) {
				if (depth < 3) await walk(child, depth + 1);
				continue;
			}
			if (!info.isFile()) continue;
			resources.push({ bytes: info.size, path: child });
			if (resources.length >= SKILL_RESOURCE_LIST_MAX) {
				truncated = true;
				return;
			}
		}
	};
	await walk("", 1);
	resources.sort((left, right) => left.path.localeCompare(right.path));
	return { resources, truncated };
}
