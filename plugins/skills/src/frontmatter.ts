import {
	SKILL_COMPATIBILITY_MAX_CHARS,
	SKILL_DESCRIPTION_MAX_CHARS,
	skillNameSchema,
	type SkillDiagnostic,
} from "@tsukaima/contracts";

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
	readonly license?: string;
	readonly metadata?: Record<string, string>;
	readonly name: string;
}

export interface ValidationResult {
	readonly diagnostics: readonly SkillDiagnostic[];
	readonly fields?: SkillFields;
}

function parseFailure(message: string): ParseSkillDocumentResult {
	return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const metadata: Record<string, string> = {};
	if (isPlainObject(frontmatter.metadata)) {
		for (const [key, value] of Object.entries(frontmatter.metadata)) {
			if (typeof value === "string") metadata[key] = value;
		}
	}
	const allowedTools =
		typeof frontmatter["allowed-tools"] === "string"
			? frontmatter["allowed-tools"].split(/\s+/u).filter((entry) => entry.length > 0)
			: undefined;

	return {
		diagnostics,
		fields: {
			description,
			name,
			...(allowedTools === undefined || allowedTools.length === 0 ? {} : { allowedTools }),
			...(compatibility === undefined ? {} : { compatibility }),
			...(license === undefined ? {} : { license }),
			...(Object.keys(metadata).length === 0 ? {} : { metadata }),
		},
	};
}
