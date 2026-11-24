import { z } from "zod";

/** A skill name is a directory name and the `skill://<name>/SKILL.md` authority. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1_024;
export const SKILL_COMPATIBILITY_MAX_CHARS = 500;
/** Upper bound of one on-disk SKILL.md document. */
export const SKILL_DOCUMENT_MAX_BYTES = 256 * 1_024;
/** The body is truncated to this many characters before it reaches a model. */
export const SKILL_BODY_MAX_CHARS = 32_000;
export const SKILL_RESOURCE_MAX_BYTES = 64 * 1_024;
export const SKILL_RESOURCE_LIST_MAX = 100;
export const SKILL_MAX_SKILLS = 200;
/** Hard ceiling for the whole rendered catalog section. */
export const SKILLS_TURN_CONTEXT_MAX_CHARS = 8_000;

export const skillNameSchema = z
	.string()
	.min(1)
	.max(SKILL_NAME_MAX_CHARS)
	.regex(SKILL_NAME_PATTERN, "Skill names are lowercase kebab-case");

/** Chat and workspace are the two execution surfaces a skill may be offered on. */
export const skillSurfaceSchema = z.enum(["chat", "workspace"]);

export type SkillSurface = z.infer<typeof skillSurfaceSchema>;

/** Access scope controlling whether everyone or only administrators may use a skill. */
export const skillScopeSchema = z.enum(["everyone", "admin"]);

export type SkillScope = z.infer<typeof skillScopeSchema>;

export const skillDiagnosticLevelSchema = z.enum(["warning", "error"]);

export const skillDiagnosticCodeSchema = z.enum([
	"root_missing",
	"root_not_directory",
	"root_unreadable",
	"escapes_root",
	"missing_skill_md",
	"too_large",
	"not_utf8",
	"invalid_frontmatter",
	"duplicate_name",
	"limit_reached",
	"name_missing",
	"name_invalid",
	"name_directory_mismatch",
	"description_missing",
	"description_too_long",
]);

export type SkillDiagnosticCode = z.infer<typeof skillDiagnosticCodeSchema>;

export const skillDiagnosticSchema = z.object({
	code: skillDiagnosticCodeSchema,
	level: skillDiagnosticLevelSchema,
	/** Human-readable, bounded, and never derived from an absolute path. */
	message: z.string().min(1),
	name: z.string().min(1).optional(),
	/** Zero-based index of the configured root that produced this diagnostic. */
	rootIndex: z.number().int().nonnegative().optional(),
});

export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>;

export const skillSummarySchema = z.object({
	allowedTools: z.array(z.string()).optional(),
	compatibility: z.string().optional(),
	description: z.string(),
	enabled: z.boolean(),
	fingerprint: z.string(),
	license: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	name: skillNameSchema,
	scope: skillScopeSchema.default("admin"),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillResourceSchema = z.object({
	bytes: z.number().int().nonnegative(),
	path: z.string().min(1),
});

export type SkillResource = z.infer<typeof skillResourceSchema>;

export const skillsSnapshotSchema = z.object({
	diagnostics: z.array(skillDiagnosticSchema),
	roots: z.number().int().nonnegative(),
	skills: z.array(skillSummarySchema),
	updatedAtMs: z.number().int().nonnegative(),
	version: z.number().int().nonnegative(),
});

export type SkillsSnapshot = z.infer<typeof skillsSnapshotSchema>;

export const skillDetailSchema = skillSummarySchema.extend({
	body: z.string(),
	resources: z.array(skillResourceSchema),
});

export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillNameInputSchema = z.object({ name: skillNameSchema });

export type SkillNameInput = z.infer<typeof skillNameInputSchema>;

export const skillsTurnContextInputSchema = z.object({
	isAdmin: z.boolean().default(false),
	surface: skillSurfaceSchema,
});

export type SkillsTurnContextInput = z.infer<typeof skillsTurnContextInputSchema>;

export const skillsTurnContextResultSchema = z.object({ text: z.string().optional() });

export type SkillsTurnContextResult = z.infer<typeof skillsTurnContextResultSchema>;
