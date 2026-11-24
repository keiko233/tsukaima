import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
	SKILL_DOCUMENT_MAX_BYTES,
	SKILL_MAX_SKILLS,
	SKILL_RESOURCE_LIST_MAX,
	SKILL_RESOURCE_MAX_BYTES,
	type SkillDiagnostic,
	type SkillResource,
	type SkillScope,
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

/** Container directories above a leaf skill are categories; cap the tree to stay bounded. */
const MAX_SKILL_DIRECTORY_DEPTH = 4;
/** Resource listing includes `scripts/` and `references/` at their natural depth. */
const MAX_RESOURCE_DIRECTORY_DEPTH = 3;

export interface SkillRecord {
	readonly allowedTools?: readonly string[];
	/** Slash-separated container path between the root and the skill, if any. */
	readonly category?: string;
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
	readonly scope: SkillScope;
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

export interface WalkSkillResourcesOptions {
	readonly allowResources?: boolean;
	readonly maxBytes?: number;
	readonly maxEntries?: number;
}

interface ScanState {
	limitReached: boolean;
	readonly visited: Set<string>;
}

interface DirectoryContentsResult {
	readonly childDirectories: number;
	readonly found: number;
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

function categoryFor(rootReal: string, directoryReal: string): string | undefined {
	const parent = dirname(directoryReal);
	const rel = relative(rootReal, parent);
	if (rel.length === 0 || rel.startsWith("..")) return undefined;
	const normalized = rel.split(sep).join("/");
	return normalized.length === 0 ? undefined : normalized;
}

/** Fail-closed scope precedence: explicit admin override > everyone override > frontmatter > default. */
function resolveSkillScope(
	name: string,
	frontmatterScope: SkillScope | undefined,
	config: SkillsConfig,
): SkillScope {
	if (config.adminSkills.has(name)) return "admin";
	if (config.everyoneSkills.has(name)) return "everyone";
	if (frontmatterScope !== undefined) return frontmatterScope;
	return config.scope;
}

/** Builds the record used by the catalog after a document passed parsing and validation. */
function recordFor(
	fields: SkillFields,
	input: {
		readonly category: string | undefined;
		readonly directory: string;
		readonly enabled: boolean;
		readonly fingerprint: string;
		readonly rootIndex: number;
		readonly scope: SkillScope;
	},
): SkillRecord {
	return {
		description: fields.description,
		directory: input.directory,
		enabled: input.enabled,
		fingerprint: input.fingerprint,
		name: fields.name,
		rootIndex: input.rootIndex,
		scope: input.scope,
		...(fields.allowedTools === undefined ? {} : { allowedTools: fields.allowedTools }),
		...(input.category === undefined ? {} : { category: input.category }),
		...(fields.compatibility === undefined ? {} : { compatibility: fields.compatibility }),
		...(fields.license === undefined ? {} : { license: fields.license }),
		...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
		...(fields.tags === undefined ? {} : { tags: fields.tags }),
		...(fields.version === undefined ? {} : { version: fields.version }),
		...(fields.requires === undefined ? {} : { requires: fields.requires }),
		...(fields.env === undefined ? {} : { env: fields.env }),
	};
}

function isSkippedDirectory(name: string): boolean {
	return name.startsWith(".") || name === "node_modules";
}

async function readDirectoryEntries(directoryReal: string): Promise<Dirent[]> {
	try {
		const entries = await readdir(directoryReal, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		return entries;
	} catch {
		return [];
	}
}

/**
 * Scans direct children of `parentReal`. Each child may be a skill leaf or a category container;
 * a container is only reported as missing when it has no skill and no nested directory at all.
 */
async function scanDirectoryContents(
	config: SkillsConfig,
	rootReal: string,
	rootIndex: number,
	parentReal: string,
	depth: number,
	state: ScanState,
	skills: SkillRecord[],
	diagnostics: SkillDiagnostic[],
	maxSkills: number,
): Promise<DirectoryContentsResult> {
	const entries = await readDirectoryEntries(parentReal);
	let childDirectories = 0;
	let found = 0;
	for (const entry of entries) {
		if (isSkippedDirectory(entry.name)) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		let directory: string;
		try {
			directory = await realpath(join(parentReal, entry.name));
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
		// Visiting a real directory once prevents symlink cycles and duplicate category walks.
		if (state.visited.has(directory)) continue;
		state.visited.add(directory);
		childDirectories += 1;
		found += await scanCandidateDirectory(
			config,
			rootReal,
			rootIndex,
			directory,
			entry.name,
			depth,
			state,
			skills,
			diagnostics,
			maxSkills,
		);
	}
	return { childDirectories, found };
}

async function scanCandidateDirectory(
	config: SkillsConfig,
	rootReal: string,
	rootIndex: number,
	directory: string,
	directoryName: string,
	depth: number,
	state: ScanState,
	skills: SkillRecord[],
	diagnostics: SkillDiagnostic[],
	maxSkills: number,
): Promise<number> {
	const marked = await resolveInside(directory, "SKILL.md");
	if (!marked.ok) {
		if (marked.reason !== "not_found") {
			diagnostics.push(documentDiagnostic(rootIndex, directoryName, marked.reason));
			return 0;
		}
		if (depth >= MAX_SKILL_DIRECTORY_DEPTH) return 0;
		const contents = await scanDirectoryContents(
			config,
			rootReal,
			rootIndex,
			directory,
			depth + 1,
			state,
			skills,
			diagnostics,
			maxSkills,
		);
		if (contents.found === 0 && contents.childDirectories === 0) {
			diagnostics.push(documentDiagnostic(rootIndex, directoryName, "not_found"));
		}
		return contents.found;
	}
	const document = await readFileInside(directory, "SKILL.md", SKILL_DOCUMENT_MAX_BYTES);
	if (!document.ok) {
		diagnostics.push(documentDiagnostic(rootIndex, directoryName, document.reason));
		return 0;
	}
	const parsed = parseSkillDocument(document.value.text);
	if (!parsed.ok) {
		diagnostics.push(
			skillDiagnostic("invalid_frontmatter", "error", parsed.message, rootIndex, directoryName),
		);
		return 0;
	}
	const validated = validateSkillFields(parsed.document.frontmatter, directoryName);
	for (const diagnostic of validated.diagnostics) {
		diagnostics.push({ ...diagnostic, rootIndex });
	}
	if (validated.fields === undefined) return 0;
	const fields = validated.fields;
	if (skills.some((skill) => skill.name === fields.name)) {
		diagnostics.push(
			skillDiagnostic(
				"duplicate_name",
				"warning",
				"another skill already uses this name; the first one wins",
				rootIndex,
				fields.name,
			),
		);
		return 1;
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
		return 1;
	}
	skills.push(
		recordFor(fields, {
			category: categoryFor(rootReal, directory),
			directory,
			enabled: !config.disabled.has(fields.name),
			fingerprint: `${document.value.text.length}:${String(Bun.hash(document.value.text))}`,
			rootIndex,
			scope: resolveSkillScope(fields.name, fields.scope, config),
		}),
	);
	return 1;
}

async function scanRoot(
	config: SkillsConfig,
	root: string,
	rootIndex: number,
	state: ScanState,
	maxSkills: number,
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
	state.visited.add(rootReal);
	try {
		await scanDirectoryContents(
			config,
			rootReal,
			rootIndex,
			rootReal,
			1,
			state,
			skills,
			diagnostics,
			maxSkills,
		);
	} catch {
		diagnostics.push(
			skillDiagnostic(
				"root_unreadable",
				"warning",
				"configured skill root is not readable",
				rootIndex,
			),
		);
	}
}

/**
 * Discovers skill leaves under every configured root. Both `<root>/<skill>/SKILL.md` and
 * Hermes-style `<root>/<category>/<skill>/SKILL.md` layouts are supported. This function never
 * throws: a broken root, category, or skill becomes a bounded diagnostic and the rest of the
 * catalog still loads.
 */
export async function scanSkillRoots(
	config: SkillsConfig,
	options: ScanOptions = {},
): Promise<ScanResult> {
	const maxSkills = options.maxSkills ?? SKILL_MAX_SKILLS;
	const skills: SkillRecord[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const state: ScanState = { limitReached: false, visited: new Set<string>() };
	for (const [rootIndex, root] of config.paths.entries()) {
		try {
			await scanRoot(config, root, rootIndex, state, maxSkills, skills, diagnostics);
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
 * Lists bundled resource files. Hidden entries, SKILL.md, and node_modules are skipped; every
 * candidate still goes through the root-containment check. `scripts/` and `references/` are
 * ordinary directories, so their files are included. Oversized files are not listed because
 * `read_skill_resource` could not return them. Pass `allowResources: false` to list nothing.
 */
export async function walkSkillResources(
	directoryReal: string,
	options: WalkSkillResourcesOptions = {},
): Promise<SkillResourceListing> {
	if (options.allowResources === false) return { resources: [], truncated: false };
	const maxBytes = options.maxBytes ?? SKILL_RESOURCE_MAX_BYTES;
	const maxEntries = options.maxEntries ?? SKILL_RESOURCE_LIST_MAX;
	const resources: SkillResource[] = [];
	let truncated = false;
	const walk = async (relativePath: string, depth: number): Promise<void> => {
		if (truncated) return;
		const target = relativePath.length === 0 ? directoryReal : join(directoryReal, relativePath);
		let entries: Dirent[];
		try {
			entries = await readdir(target, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (isSkippedDirectory(entry.name)) continue;
			const child = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
			if (depth === 1 && entry.name === "SKILL.md") continue;
			const resolved = await resolveEntryInside(directoryReal, child);
			if (!resolved.ok) continue;
			const info = await stat(resolved.value.real).catch(() => undefined);
			if (info === undefined) continue;
			if (info.isDirectory()) {
				if (depth < MAX_RESOURCE_DIRECTORY_DEPTH) await walk(child, depth + 1);
				continue;
			}
			if (!info.isFile() || info.size > maxBytes) continue;
			resources.push({ bytes: info.size, path: child });
			if (resources.length >= maxEntries) {
				truncated = true;
				return;
			}
		}
	};
	await walk("", 1);
	resources.sort((left, right) => left.path.localeCompare(right.path));
	return { resources, truncated };
}
