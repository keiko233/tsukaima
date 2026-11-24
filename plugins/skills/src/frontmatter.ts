import {
	SKILL_COMPATIBILITY_MAX_CHARS,
	SKILL_DESCRIPTION_MAX_CHARS,
	skillNameSchema,
	type SkillDiagnostic,
	type SkillScope,
} from "@tsukaima/contracts";
import { isPlainObject } from "es-toolkit";

export interface SkillDocument {
	readonly body: string;
	readonly frontmatter: Record<string, unknown>;
}

export type ParseSkillDocumentResult =
	| { readonly ok: true; readonly document: SkillDocument }
	| { readonly ok: false; readonly message: string };

export interface SkillFields {
	readonly allowedTools?: readonly string[];
	readonly compatibility?: string;
	readonly description: string;
	readonly env?: readonly string[];
	readonly license?: string;
	readonly metadata?: Record<string, string>;
	readonly name: string;
	readonly requires?: readonly string[];
	readonly scope?: SkillScope;
	readonly tags?: readonly string[];
	readonly version?: string;
}

const METADATA_KEY_MAX_CHARS = 64;
const METADATA_MAX_ENTRIES = 32;
const METADATA_VALUE_MAX_CHARS = 512;
const LIST_MAX_ITEMS = 16;
const LIST_ITEM_MAX_CHARS = 128;

export interface ValidationResult {
	readonly diagnostics: readonly SkillDiagnostic[];
	readonly fields?: SkillFields;
}

function parseFailure(message: string): ParseSkillDocumentResult {
	return { ok: false, message };
}

function cleanDescription(value: string): string {
	let stripped = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		stripped += code < 32 || code === 127 ? " " : char;
	}
	return stripped.replace(/\s+/gu, " ").trim();
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function scalarText(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value !== "string") return undefined;
	const cleaned = cleanDescription(value);
	return cleaned.length === 0 ? undefined : cleaned;
}

/**
 * Coerces the shapes Hermes-style metadata uses (scalars, lists, and nested maps) into a short
 * string. Nothing here is fatal: an unusable value is simply omitted from the catalog metadata.
 */
function metadataValue(value: unknown): string | undefined {
	const scalar = scalarText(value);
	if (scalar !== undefined) return scalar.slice(0, METADATA_VALUE_MAX_CHARS);
	if (Array.isArray(value)) {
		const items = value
			.map((entry) => metadataValue(entry))
			.filter((entry): entry is string => entry !== undefined)
			.slice(0, LIST_MAX_ITEMS);
		return items.length === 0 ? undefined : items.join(", ").slice(0, METADATA_VALUE_MAX_CHARS);
	}
	if (isPlainObject(value)) {
		try {
			const serialized = JSON.stringify(value);
			return serialized === undefined ? undefined : serialized.slice(0, METADATA_VALUE_MAX_CHARS);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function listText(
	value: unknown,
	options: { readonly splitWhitespace?: boolean } = {},
): string[] | undefined {
	const parts: string[] = [];
	const addText = (text: string): void => {
		for (const piece of text.split(/[,\n]+/u)) {
			const words = options.splitWhitespace === true ? piece.split(/\s+/u) : [piece];
			for (const word of words) {
				const trimmed = word.trim();
				if (trimmed.length === 0) continue;
				const capped = trimmed.slice(0, LIST_ITEM_MAX_CHARS);
				if (!parts.includes(capped)) parts.push(capped);
				if (parts.length >= LIST_MAX_ITEMS) return;
			}
		}
	};
	const add = (entry: unknown): void => {
		const text = scalarText(entry);
		if (text === undefined) return;
		addText(text);
	};
	const source = Array.isArray(value)
		? value
		: value === undefined || value === null
			? []
			: [value];
	for (const entry of source) {
		if (parts.length >= LIST_MAX_ITEMS) break;
		add(entry);
	}
	return parts.length === 0 ? undefined : parts;
}

function allowedToolsValue(value: unknown): string[] | undefined {
	const parts = listText(value);
	if (parts === undefined) return undefined;
	// `allowed-tools` is often whitespace-separated; tags/requires keep their internal spaces.
	const expanded = parts
		.flatMap((entry) => entry.split(/\s+/u))
		.filter((entry) => entry.length > 0);
	const unique = [...new Set(expanded)];
	return unique.length === 0 ? undefined : unique;
}

/**
 * Parses one SKILL.md document: a leading `---` fence, a YAML mapping, and a Markdown body.
 * Error messages are fixed strings; file contents never appear in diagnostics or logs.
 */
export function parseSkillDocument(input: string): ParseSkillDocumentResult {
	const text = input.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
	if (!text.startsWith("---\n"))
		return parseFailure("SKILL.md must start with a --- frontmatter fence");
	const closing = text.indexOf("\n---", 3);
	if (closing < 0) return parseFailure("SKILL.md frontmatter is not closed with a --- line");
	const closingLineEnd = text.indexOf("\n", closing + 1);
	const closingLine =
		closingLineEnd < 0 ? text.slice(closing + 1) : text.slice(closing + 1, closingLineEnd);
	if (closingLine.trimEnd() !== "---") {
		return parseFailure("SKILL.md frontmatter is not closed with a --- line");
	}
	const yamlText = text.slice(4, closing);
	let parsed: unknown;
	try {
		parsed = yamlText.trim().length === 0 ? {} : (Bun.YAML.parse(yamlText) as unknown);
	} catch {
		return parseFailure("SKILL.md frontmatter is not valid YAML");
	}
	if (!isPlainObject(parsed)) {
		return parseFailure("SKILL.md frontmatter must be a YAML mapping");
	}
	const bodyStart = closingLineEnd < 0 ? text.length : closingLineEnd + 1;
	const body = text.slice(bodyStart).replace(/^(?:[ \t]*\n)+/u, "");
	return { ok: true, document: { body, frontmatter: parsed } };
}

function diagnostic(
	code: SkillDiagnostic["code"],
	level: SkillDiagnostic["level"],
	message: string,
	name?: string,
): SkillDiagnostic {
	return { code, level, message, ...(name === undefined ? {} : { name }) };
}

/**
 * Validates the fields the loader depends on. A bad name or missing description is fatal;
 * a directory/name mismatch and an over-long description are warnings that still load.
 */
export function validateSkillFields(
	frontmatter: Record<string, unknown>,
	directoryName: string,
): ValidationResult {
	const diagnostics: SkillDiagnostic[] = [];
	const rawName = frontmatter.name;
	let name: string | undefined;
	if (typeof rawName !== "string" || rawName.trim().length === 0) {
		diagnostics.push(
			diagnostic("name_missing", "error", "SKILL.md is missing a name", directoryName),
		);
	} else {
		const parsed = skillNameSchema.safeParse(rawName.trim());
		if (!parsed.success) {
			diagnostics.push(
				diagnostic(
					"name_invalid",
					"error",
					"SKILL.md name must be lowercase kebab-case with at most 64 characters",
					directoryName,
				),
			);
		} else {
			name = parsed.data;
			if (name !== directoryName) {
				diagnostics.push(
					diagnostic(
						"name_directory_mismatch",
						"warning",
						"SKILL.md name does not match its directory; the document name is used",
						name,
					),
				);
			}
		}
	}

	const rawDescription = frontmatter.description;
	let description: string | undefined;
	if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
		diagnostics.push(
			diagnostic("description_missing", "error", "SKILL.md is missing a description", name),
		);
	} else {
		description = cleanDescription(rawDescription);
		if (description.length === 0) {
			diagnostics.push(
				diagnostic("description_missing", "error", "SKILL.md is missing a description", name),
			);
		} else if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
			description = description.slice(0, SKILL_DESCRIPTION_MAX_CHARS);
			diagnostics.push(
				diagnostic(
					"description_too_long",
					"warning",
					"SKILL.md description was truncated to 1024 characters",
					name,
				),
			);
		}
	}

	if (name === undefined || description === undefined) {
		return { diagnostics };
	}

	const license = stringValue(frontmatter.license);
	const compatibility = stringValue(frontmatter.compatibility)?.slice(
		0,
		SKILL_COMPATIBILITY_MAX_CHARS,
	);
	const version = scalarText(frontmatter.version)?.slice(0, LIST_ITEM_MAX_CHARS);
	const tags = listText(frontmatter.tags, { splitWhitespace: true });
	const requires = listText(frontmatter.requires);
	const env = listText(frontmatter.env);
	const metadata: Record<string, string> = {};
	if (isPlainObject(frontmatter.metadata)) {
		for (const [key, value] of Object.entries(frontmatter.metadata)) {
			if (Object.keys(metadata).length >= METADATA_MAX_ENTRIES) break;
			const cleanKey = scalarText(key)?.slice(0, METADATA_KEY_MAX_CHARS);
			const cleanValue = metadataValue(value);
			if (cleanKey === undefined || cleanValue === undefined) continue;
			metadata[cleanKey] = cleanValue;
		}
	}
	const recognized: readonly [string, readonly string[] | undefined, unknown][] = [
		["version", version === undefined ? undefined : [version], frontmatter.version],
		["tags", tags, frontmatter.tags],
		["requires", requires, frontmatter.requires],
		["env", env, frontmatter.env],
	];
	for (const [key, list, raw] of recognized) {
		if (metadata[key] !== undefined && metadata[key].length > 0) continue;
		const text = list === undefined ? metadataValue(raw) : list.join(", ");
		if (text !== undefined && text.length > 0) {
			metadata[key] = text.slice(0, METADATA_VALUE_MAX_CHARS);
		}
	}
	const allowedTools = allowedToolsValue(frontmatter["allowed-tools"] ?? frontmatter.allowed_tools);
	const rawScope = stringValue(frontmatter.scope)?.toLowerCase();
	const scope: SkillScope | undefined =
		rawScope === "everyone" || rawScope === "admin" ? rawScope : undefined;

	return {
		diagnostics,
		fields: {
			description,
			name,
			...(allowedTools === undefined ? {} : { allowedTools }),
			...(compatibility === undefined ? {} : { compatibility }),
			...(env === undefined ? {} : { env }),
			...(license === undefined ? {} : { license }),
			...(Object.keys(metadata).length === 0 ? {} : { metadata }),
			...(requires === undefined ? {} : { requires }),
			...(scope === undefined ? {} : { scope }),
			...(tags === undefined ? {} : { tags }),
			...(version === undefined ? {} : { version }),
		},
	};
}
