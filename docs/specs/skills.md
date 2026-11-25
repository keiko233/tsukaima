# Agent Skills spec

## Outcome

The `skills` built-in plugin discovers Agent Skills from one or more configured folders, injects a
bounded catalog into every model turn, and exposes two read-only text tools:

- `load_skill` (canonical `skills.load`) loads `SKILL.md` by name, or lists available skills when
  called without a name.
- `read_skill_resource` (canonical `skills.read_resource`) reads one bundled text file inside a
  skill directory.

Skills are instructions, not executables. The loader never runs scripts, never installs
dependencies, and never grants a model unrestricted filesystem access.

## Plugin identity

`@tsukaima-plugin/skills`, plugin id `skills`, kind `builtin`. It declares `ui.panel`, `tools`, and
`audit.write`. It has no database migrations, no `storage` permission, no `fs.watch`, and no
per-conversation enable/disable in v1.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `paths` | string array | `[]` | Skill roots. Defaults to `<TSUKAIMA_DATA_DIR>/skills` when empty; `TSUKAIMA_SKILLS_PATHS` is the environment fallback and accepts the platform path delimiter and newlines. |
| `disabled` | string array | `[]` | Skill names that stay in the catalog but are not offered to models. |
| `scope` | `"admin" \| "everyone"` | `"admin"` | Default access scope for skills without a per-skill override. |
| `everyoneSkills` | string array | `[]` | Skill names usable by everyone even when the default scope is `"admin"`. |
| `adminSkills` | string array | `[]` | Skill names restricted to administrators even when the default scope is `"everyone"`. |
| `surfaces` | `("chat" \| "workspace")[]` | both | Execution surfaces that receive the catalog and the tools. |
| `allowResources` | boolean | `true` | Enables `read_skill_resource` and the resource sentence in the catalog. |
| `maxCatalogChars` | integer 500..8000 | `4000` | Maximum rendered catalog length. |
| `refreshIntervalSeconds` | integer 5..3600 | `30` | Background rescan interval for stale catalogs. |

Missing or invalid values fall back to defaults; configuration errors never break plugin setup.

## Folder layout

```text
<skills-root>/
  pdf-forms/
    SKILL.md
    templates/
      basic.txt
  release-notes/
    SKILL.md
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: pdf-forms
description: Fill and validate PDF forms.
license: MIT
compatibility: any
metadata:
  owner: synthetic
allowed-tools: read_file write_file
---
# Instructions
```

The directory name is the canonical skill name unless the document name differs, which emits a
warning and loads under the document name. Discovery is depth 1 under each root; hidden
directories, `node_modules`, duplicates after the first occurrence, and catalogs beyond 200 skills
are skipped with diagnostics.

## Security model

- Every requested resource path must be relative, contain no `..` or hidden segment, and stay
  inside the skill's real directory after `realpath`.
- Symlinked skill directories that escape their configured root are rejected.
- `SKILL.md` is capped at 256 KiB; bundled resources are capped at 64 KiB; both must be valid
  UTF-8 without NUL bytes.
- The model-facing location is always `skill://<name>/SKILL.md`. Absolute paths are never shown
  to the model, written to diagnostics, or written to logs.
- Resource denials are audited as `skills.resource.denied`. An `absolute_path` denial omits the
  requested path from the audit payload.
- Ordinary chat and workspace turns receive only these read-only loaders; no coding execution
  tools are added by this plugin.

## Turn context

The catalog is a new `skills` section rendered after sticker hints and before prompt hooks. It is
exempt from the general turn budget and hard-capped at 8000 characters:

```text
Agent skills are available on demand. When a request clearly matches a skill's description, call load_skill with that name before acting, then follow the loaded instructions. Do not claim to use a skill you have not loaded. Bundled files can be read with read_skill_resource.
<available_skills>
- name: pdf-forms
  description: Fill and validate PDF forms.
  location: skill://pdf-forms/SKILL.md
</available_skills>
```

The `Bundled files can be read with read_skill_resource.` sentence is omitted when resources are
disabled. Descriptions replace `<` and `>` with `‹` and `›`; entries are truncated whole with a
final `(+N more skills not shown; call load_skill without a name to list all.)` line.

A synthetic local layout for tests and documentation is `/synthetic/skills`.
