# Tsukaima WebUI Editorial Redesign ("Paper & Ink Editorial")

**Status:** approved visual direction, 26 November 2026  
**Selected Prototype:** [prototypes/option-a-editorial.html](prototypes/option-a-editorial.html)  
**Archived Alternatives:** [../archive/webui-redesign-2026-11/README.md](../archive/webui-redesign-2026-11/README.md)  
**Component Architecture:** Headless `@ui-sdk/react` (project skill installed at `.agents/skills/ui-sdk/SKILL.md` and `.claude/skills/ui-sdk/SKILL.md`)

---

## 1. Why We Are Refactoring

The previous WebUI accumulated severe visual clutter ("card-in-card" / box soup) across administration and plugin views:

- **Nested borders up to 4 levels deep**: `PluginSection` (`rounded-xl border`) wrapped `StatGrid` (`rounded-lg border`), `ServerCard` / `ModelCard` (`rounded-xl border`), OAuth sub-boxes (`rounded-lg border`), and individual tool cards (`rounded-md border`).
- **Redundant headers**: Plugin pages stacked four consecutive headers (`PluginDetail` header → tab bar → `PluginPage` title → `PluginSection` title).
- **Card proliferation in Settings**: `/settings/upgrades` stacked 6 separate `<Card>` containers; `/settings/policies` wrapped 9 sections inside one monolithic card; `/settings/prompts` wrapped each template and persona in its own card (10+ cards vertically).
- **Flat surface hierarchy & inconsistent chrome**: `Card` used the same background fill as the page (`bg-background`), relying purely on `rounded-2xl` borders, mixed radii (`2xl`/`xl`/`lg`/`md`), cramped `10.5px` micro-text, and raw native `<input type="checkbox">` / `<textarea>` controls beside styled inputs.

---

## 2. Chosen Direction: Option A — Paper & Ink Editorial

Option A preserves Tsukaima's original warm-paper and mist-slate brand identity while replacing boxed UI chrome with **zero-card editorial hairline architecture**, **first-class dark and light themes**, and **distinctive custom typography**.

### Core Invariants

1. **Zero card-in-card nesting**: Settings and Plugins use **no `<Card>` wrappers**. Hierarchy comes from typographic scale, generous whitespace, and `1px` horizontal hairline rules.
2. **One merged page header**: Every Settings and Plugin view has a single page header (eyebrow path + editorial serif title + inline metadata strip + right-aligned primary toggle/actions), followed directly by underline tabs when sub-views exist.
3. **Inline expandable drawers use a 2px left guide line**: Expanding an MCP server, OpenAI model parameter block, or Policy detail group indents cleanly beside a `2px solid var(--accent)` guide line — never an inner bordered box.
4. **Borderless telemetry strips**: Replace boxed `StatGrid` tiles with horizontal KPI strips separated by `1px` vertical hairlines and tabular numerals.
5. **Dual-theme parity (Dark Mode mandatory)**: Both **Deep Ink Dark Mode** and **Warm Paper Light Mode** are first-class citizens with >= 4.5:1 text contrast and >= 3:1 control/focus contrast.

---

## 3. Distinctive Typography System

Do **not** fall back to generic system sans (`system-ui` / `Inter` alone). Bundle and self-host the editorial font stack (e.g., via `@fontsource-variable/newsreader`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, plus subsetted `Noto Serif SC` / `Noto Sans SC` WOFF2 or CSS unicode-range loading so air-gapped/self-hosted deployments work cleanly):

| Role | Font Family | Usage | Characteristics |
| :--- | :--- | :--- | :--- |
| **Display & Editorial Serif** | `Newsreader` (variable `opsz`), `Noto Serif SC` | Page titles (`h1`), section group titles (`h3`), KPI headline figures, chat reading prose | Screen-optimized optical serif; crisp editorial authority in both dark ink and warm paper |
| **UI Body Sans** | `IBM Plex Sans`, `Noto Sans SC` | Navigation, labels, preference rows, hints, tables, controls | Subtle humanist warmth with technical precision; avoids generic SaaS flatness |
| **Technical Monospace** | `IBM Plex Mono` | Model IDs, transport URIs, tool names, commit hashes, token counts, timestamps, log streams | Native pairing with IBM Plex Sans; always paired with `font-variant-numeric: tabular-nums` |

---

## 4. Dual-Theme Surface & Semantic Tokens

All components consume semantic CSS variables defined in `apps/web/src/app.css` (with `@layer ui-sdk;` declared above `@import "tailwindcss";`):

| Token | Light ("Warm Paper") | Dark ("Deep Ink") | Role |
| :--- | :--- | :--- | :--- |
| `--paper` / `--background` | `#F7F5F0` | `#131518` | Primary content canvas |
| `--side` / `--sidebar` | `#EFECE6` | `#181B1F` | Contextual sidebar & inspector surface |
| `--rail` | `#E8E4DD` | `#0F1114` | Leftmost 52px primary app rail |
| `--ink` / `--foreground` | `#1F2328` | `#ECE8E0` | Primary text & high-contrast actions |
| `--ink-soft` | `#3A3E44` | `#CFCBC2` | Reading prose & expanded details |
| `--muted` / `--muted-foreground` | `#68645D` | `#9A958C` | Secondary labels & hints |
| `--faint` | `#8E8980` | `#6E6B64` | Section eyebrows, counters, chevrons |
| `--line` / `--border` | `rgba(31, 35, 40, 0.09)` | `rgba(236, 232, 224, 0.085)` | Primary hairline dividers |
| `--line2` / `--border-strong` | `rgba(31, 35, 40, 0.17)` | `rgba(236, 232, 224, 0.16)` | Input borders, table header rules |
| `--accent` / `--ring` | `#48667B` | `#8FAEC4` | Mist slate-blue active tabs, focus rings, guide rails |
| `--sage` / `--success` | `#3B6B51` | `#7BB395` | Connected, healthy, applied |
| `--amber` / `--warning` | `#8E6514` | `#D7AB57` | Auth required, deferred, behind upstream |
| `--terra` / `--destructive` | `#B4453C` | `#E27C72` | Errors, rolled back, destructive actions |

---

## 5. Surface-by-Surface Refactor Blueprint

### 5.1 Application Shell (`apps/web/src/routes/_modules/shell/`)
- Unify Settings and Plugins sidebars into the same `AdminShell` sidebar width/resize architecture as Chats/Workspace/Tasks/Directory (remove duplicated `w-60 lg:w-64` ad-hoc sidebars).
- Clean 52px App Rail with left-edge `2px` slate-blue active indicator and direct Theme toggle + Logs (`Ctrl+\``) + More menu at the bottom.
- Simplify Settings sidebar items to crisp single-line rows (drop noisy two-line descriptions under every sidebar link).

### 5.2 Shared Plugin UI Kit (`packages/sdk/src/ui/` & `apps/web/src/routes/(system)/_modules/plugin-detail.tsx`)
- Replace bordered `<PluginSection>` boxes with typographic hairline sections (`border-t border-border`, uppercase muted heading + right-aligned inline action link).
- Replace boxed `<StatGrid>` tiles with a borderless horizontal KPI strip separated by vertical hairlines (`1px solid var(--line)`).
- Collapse `PluginDetail` + `PluginPage` duplicate headers into ONE canonical plugin header + `@ui-sdk/react/tabs` underline tab bar.
- Flatten `PluginConfigForm` nested object / boolean-detail branches to use `2px` left-rail indentation instead of nested rounded borders.

### 5.3 Plugin Panels (`plugins/*/src/ui.tsx`)
- **MCP Servers (`plugins/mcp`)**: Flat hairline-divided server rows; clicking expands inline beside a `2px` accent rail showing OAuth action strip, key-value metadata, and a 2-column monospace tool index (zero nested cards).
- **OpenAI-Compatible (`plugins/openai-compatible`)**: Inline horizontal Endpoint / API Key preference rows above a searchable flat model list with interactive capability toggle pills (`Tools`, `Reasoning`, `Image`, `Audio`, `Sidechat`) and expandable inline parameter grid.
- **OneBot/NapCat, Proactive Scheduler, Skills, Sticker Meme**: Adopt the same hairline section + KPI strip + flat expandable row grammar.

### 5.4 Settings (`apps/web/src/routes/(system)/`)
- **General**: Horizontal preference rows (label + one-line hint on left, compact `@ui-sdk/react` `Select` / `Switch` / segmented control on right) grouped under serif section headers.
- **Policies**: Sticky category jump tabs (borrowed from Precision Studio's scanability) + clean hairline rows + floating unsaved-changes bar (`Reset` · `Override All` · `Save`).
- **Prompts & Personas**: Split selector list + clean monospace/editorial document editor (replacing 10+ stacked cards).
- **Upgrades & Git / Maintenance**: Collapse 6 cards into ONE top hairline status strip (`Version | Branch | Commit | Tree | Upstream | GitHub | Fetch / Restart / Upgrade`) above a clean flat history & CI runs table.

### 5.5 Chat & Context Inspector (`apps/web/src/routes/(messaging)/`)
- Clean editorial message rhythm with serif body readability (`Newsreader` / `Noto Serif SC`) or crisp sans option, left-ruled monospace tool-call activity rows, and a recessed right Context Inspector with segmented horizontal token bar + tabular breakdown table.

---

## 6. `@ui-sdk/react` Migration Strategy

Follow `.agents/skills/ui-sdk/SKILL.md`:

1. Install `@ui-sdk/core` and `@ui-sdk/react` into `packages/ui` (and export styled Tsukaima wrappers from `@tsukaima/ui` and `@tsukaima/sdk/ui`).
2. Add `@layer ui-sdk;` at line 1 of `apps/web/src/app.css` above `@import "tailwindcss";`.
3. Import each primitive from its subpath entry (`@ui-sdk/react/tabs`, `@ui-sdk/react/select`, `@ui-sdk/react/switch`, `@ui-sdk/react/accordion`, `@ui-sdk/react/dialog`, `@ui-sdk/react/popover`, `@ui-sdk/react/field`, `@ui-sdk/react/toast`).
4. Style via `data-slot` and state attributes (`data-open`, `data-selected`, `data-checked`) without hand-rolling ARIA roles.
5. Wire `createAgent()` from `@ui-sdk/react/agent` in tests and optional WebMCP diagnostics so UI regressions can be verified cleanly with keyboard, focus, and agent-action tests.
