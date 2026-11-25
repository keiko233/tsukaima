# WebUI Editorial Implementation Guide (Option A + `@ui-sdk/react`)

Companion to [webui-editorial-redesign.md](webui-editorial-redesign.md) (the *what*). This file is the *how*:
phases, dependency set, token CSS, shared-primitive contract, and a strict file-ownership matrix so five
workers can run in parallel without merge conflicts or a broken build.

**Phase order is a hard gate:** Phase 2 (Foundation) lands and merges first. Only then do Batches 3A–3E start,
all branching from the Foundation commit. Workers never edit Foundation files (§1, §2, §5).

---

## 0. Repo facts workers must know (verified)

- `@ui-sdk/*` and `@fontsource*` are **not installed** yet. Foundation installs them, then reads
  `node_modules/@ui-sdk/react/docs/llms.txt` (and only the component pages needed) before wrapping anything.
  Never read `dist/*.js`.
- `apps/web/src/app.css` currently starts with `@import "tailwindcss";`, has `@source` lines for
  `packages/ui`, `packages/sdk`, `plugins`, a class-based `.dark` variant, and a Warm-Paper token set with
  extra aliases (`--neon`, `--violet`, `--glass-*`, `--chart-*`, `--log-bg`, `--accent` = mist fill,
  `--accent-fg`). Many files use `bg-accent`, `text-violet`, `text-neon`, `glass*`: these must keep working.
- Existing primitives live in `packages/ui/src/components/motion/*` (`tabs`, `select`, `switch`, `card`,
  `checkbox`, `input`, `button`, …) and are re-exported by `@tsukaima/sdk/ui` (`packages/sdk/src/ui/index.tsx`).
  Plugins import UI **only** from `@tsukaima/sdk/ui`.
- `packages/ui` exports `./components/*` → `./src/components/*`, so new files in
  `packages/ui/src/components/editorial/` are importable as `@tsukaima/ui/components/editorial/<file>` with no
  `package.json` exports change.
- Each plugin has its **own** Paraglide project (`plugins/<id>/messages`, compiled by
  `apps/web/scripts/compile-plugin-i18n.ts`). Plugin workers own their own messages dir; no collision with web.
  `plugins/self-iteration` has no `ui.tsx`: ignore it.
- **All current UI tests are SSR `renderToString` + `toContain(text)`**
  (`packages/sdk/src/ui/config-form.test.tsx`, `registry.test.tsx`, `apps/web/src/plugins/plugin-panels.test.tsx`,
  `apps/web/src/routes/(system)/_modules/memories-page.test.tsx`, plus messaging tests). ui-sdk components used
  in these paths **must render on the server** (no `window`/`document` at render) and visible text must still be
  emitted into the initial HTML. Do **not** put label/hint text behind a closed popup or lazy mount.
- Cards remaining in scope: `<Card>` is used in 8 files, all under `apps/web/src/routes/(system)/_modules/`
  (`runtime-maintenance-card`, `policy-defaults-card`, `memories-page`, `github-card`, `settings-page`,
  `prompt-settings`, `repository-status-card`, `upgrade-center`). Goal: zero `<Card>` in Settings/Plugins.
  `memories-page.tsx` keeps a hairline list (it's 3E).
- Formatting: tabs, 100 cols (`.oxfmtrc.json`). Run `bun run format:check` and `bun run lint`.

---

## 1. Phase 2 Foundation (one owner, merges before Phase 3)

### 1.1 Packages

```sh
bun add --cwd packages/ui @ui-sdk/core @ui-sdk/react
bun add --cwd apps/web @fontsource-variable/newsreader @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono \
	@fontsource/noto-serif-sc @fontsource/noto-sans-sc
bun install --frozen-lockfile   # verify lockfile is committed and consistent
```

- `@ui-sdk/*` is a dependency of `packages/ui` only (wrappers live there; `sdk` and `plugins` consume through
  `@tsukaima/ui` / `@tsukaima/sdk/ui`). If `@ui-sdk/react` declares `react` peers, they already match.
- Fonts are `apps/web` dependencies (app-level concern, imported from CSS/`main.tsx`). Plugins never import fonts.
- Pin exact versions in `package.json` (repo pins `zod`, `better-auth` etc. exactly; new `@ui-sdk/*` should be
  `^`-free until proven stable).

### 1.2 Font strategy (offline / self-hosted safe)

Fontsource packages ship woff2 inside `node_modules`; Vite hashes and emits them into `dist`, so no CDN/network
is needed at runtime. For CJK, `@fontsource/noto-*-sc` ships **unicode-range slices** (browser downloads only
slices actually used), so we never ship one 8 MB file.

Import in `apps/web/src/main.tsx` **above** `import "./app.css"` (Foundation edits `main.tsx`):

```ts
import "@fontsource-variable/newsreader/index.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/noto-serif-sc/500.css";
import "@fontsource/noto-serif-sc/600.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
```

(Verify exact file names in `node_modules/@fontsource*/` after install, adjust to what exists; do not import
`latin`-only files for the CJK families.) Stacks always end in system CJK fallbacks so a missing slice degrades
gracefully:

```css
--font-serif: "Newsreader Variable", "Noto Serif SC", "Songti SC", "Source Han Serif SC", Georgia, serif;
--font-sans:  "IBM Plex Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--font-mono:  "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
```

Gate: `bun run --filter '@tsukaima/web' build` must succeed with the network disabled and `dist` must contain the
woff2 assets (no `fonts.googleapis.com` anywhere: `grep -R googleapis apps/web/dist apps/web/index.html`).

### 1.3 `apps/web/src/app.css` structure (Foundation owns the whole file)

Order is mandatory:

```css
@layer ui-sdk;
@import "tailwindcss";
@source "../../../packages/ui/src";
@source "../../../packages/sdk/src";
@source "../../../plugins";

@custom-variant dark (&:where(.dark, .dark *));
```

Then, in this order: `:root` (light), `.dark`, `@theme inline`, `@theme` (keep existing marquee/shimmer
keyframes untouched), `@layer base`, `@layer utilities` (keep every existing utility: `.glass*`,
`.message-markdown*`, `.runtime-log-token`, `.workspace-git-code`, scrollbar rules), reduced-motion block.

**Tokens (from the approved design, §4 of redesign doc).** Canonical names are the design names; legacy names are
aliases so nothing breaks mid-migration.

```css
:root {
	/* Warm Paper */
	--paper: #f7f5f0;   --side: #efece6;   --rail: #e8e4dd;
	--ink: #1f2328;     --ink-soft: #3a3e44;
	--muted-ink: #68645d; --faint: #8e8980;
	--line: rgb(31 35 40 / 0.09);  --line2: rgb(31 35 40 / 0.17);
	--accent-ink: #48667b;           /* slate-blue: tabs, rails, focus */
	--sage: #3b6b51; --amber: #8e6514; --terra: #b4453c;

	/* Legacy / shadcn-style aliases (do not remove) */
	--background: var(--paper);        --foreground: var(--ink);
	--sidebar: var(--side);            --card: #fbfaf7;  --card-foreground: var(--ink);
	--popover: var(--paper);           --popover-foreground: var(--ink);
	--muted: var(--side);              --muted-foreground: var(--muted-ink);
	--border: var(--line);             --border-strong: var(--line2);  --input: var(--line2);
	--ring: var(--accent-ink);
	--primary: var(--ink);             --primary-foreground: var(--paper);
	--secondary: var(--card);          --secondary-foreground: var(--ink);
	--success: var(--sage);  --warning: var(--amber);  --danger: var(--terra);
	--destructive: var(--terra);       --destructive-foreground: #fff;
	--neon: var(--sage);               --violet: var(--accent-ink);
	/* --accent: see gotcha G2 */
	--accent: var(--accent-ink);       --accent-fg: #fff;  --accent-foreground: var(--accent-fg);
	/* keep unchanged: --glass-*, --chart-*, --log-bg (retune --log-bg to #fbfaf7 / #0f1114) */
	color-scheme: light;
}
.dark {
	--paper: #131518;   --side: #181b1f;   --rail: #0f1114;
	--ink: #ece8e0;     --ink-soft: #cfcbc2;
	--muted-ink: #9a958c; --faint: #6e6b64;
	--line: rgb(236 232 224 / 0.085);  --line2: rgb(236 232 224 / 0.16);
	--accent-ink: #8faec4;
	--sage: #7bb395; --amber: #d7ab57; --terra: #e27c72;
	--card: #181b1f;  --primary-foreground: #131518;  --destructive-foreground: #131518;
	--accent-fg: #131518;
	color-scheme: dark;
}
```

Aliases referencing `var(--paper)` etc. are declared once in `:root` and resolve per-theme because custom
properties inherit; only redeclare an alias in `.dark` when its value is *not* a pure var() reference.
Keep all existing `--chart-*`, `--glass-*`, `--log-bg` values in both themes (retune `--log-bg` only).

`@theme inline` additions on top of the existing `--color-*` map (keep every existing line):

```css
--font-serif: ...; --font-sans: ...; --font-mono: ...;   /* utilities: font-serif / font-sans / font-mono */
--color-paper: var(--paper);   --color-ink: var(--ink);   --color-ink-soft: var(--ink-soft);
--color-faint: var(--faint);   --color-rail: var(--rail);
--color-line: var(--line);     --color-line2: var(--line2);
--color-sage: var(--sage);     --color-amber: var(--amber); --color-terra: var(--terra);
--color-danger: var(--danger);
```

`@layer base`: `body { font-family: var(--font-sans); font-size: 13.5px; }`, `h1,h2,h3 { font-family:
var(--font-serif) }` is **not** global (use `font-serif` explicitly); add `.tabular { font-variant-numeric:
tabular-nums }` only if Tailwind `tabular-nums` is insufficient (it is sufficient; skip). Add global
`:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }` for ui-sdk parts.

ui-sdk styling hooks (in `@layer ui-sdk`-adjacent unlayered Tailwind, **not** inside `@layer ui-sdk`): wrappers
style via Tailwind `data-[open]:`, `data-[selected]:`, `data-[checked]:`, `data-[pressed]:` variants and
`[data-slot=...]` selectors. Do not import `@ui-sdk/core/web.css` (we style ourselves; the declared empty layer
exists so any library defaults sit below Tailwind).

### 1.4 Other Foundation-only files

- `apps/web/src/main.tsx` (font imports only), `apps/web/index.html` (`<html lang>` untouched; no font links).
- `apps/web/messages/en.json` + `zh-cn.json`: **the only time these are edited** (see §4).
- `packages/ui/package.json`, `bun.lock`, `apps/web/package.json`.
- `packages/ui/src/components/editorial/*` and `packages/ui/src/index.ts` export additions (§2).
- `packages/sdk/src/ui/*` (§3) and `packages/sdk/src/ui/index.tsx` exports.

Foundation gate: `bun run typecheck && bun run lint && bun run format:check && bun test &&
bun run --filter '@tsukaima/web' build`.

---

## 2. Shared primitives contract: `packages/ui/src/components/editorial/`

All files `"use client"`, import ui-sdk **from subpath entries only** (`@ui-sdk/react/tabs`, …), style from
`data-slot`/state attributes, never hand-roll `role=`. Export each from `packages/ui/src/index.ts` and (for plugin
use) re-export from `packages/sdk/src/ui/index.tsx`. These APIs are frozen when Foundation merges; Batch workers
**consume, never modify** them. If a worker needs a variation, pass `className` or compose, and report it.

| File | Export(s) | Backing | Contract |
| :-- | :-- | :-- | :-- |
| `tabs.tsx` | `EditorialTabs`, `EditorialTabsList`, `EditorialTabsTrigger`, `EditorialTabsContent` | `@ui-sdk/react/tabs` | Underline style: 1px `--line` baseline, active = `data-[selected]` → `text-ink` + 2px `--accent` underline. Controlled via `value`/`onValueChange`. Keep API close to existing `motion/tabs` (`value`, `onValueChange`, `children`) so swaps are mechanical. |
| `switch.tsx` | `EditorialSwitch` | `@ui-sdk/react/switch` | Same props as existing `motion/switch` (`checked`, `onCheckedChange`, `disabled`, `aria-label`). |
| `select.tsx` | `EditorialSelect` | `@ui-sdk/react/select` | Compact trigger (hairline `--line2` border, 28px). API mirrors existing `Select`/`SelectItem` composition (see `packages/ui/src/components/motion/select.tsx`) so consumers only change import path. |
| `disclosure.tsx` | `Disclosure`, `DisclosureTrigger`, `DisclosurePanel` | `@ui-sdk/react/accordion` | Single-item expandable; panel has the 2px accent left rail. Basis for `ExpandableRow`. |
| `dialog.tsx` | `EditorialDialog` parts | `@ui-sdk/react/dialog` | Replaces `routes/_modules/ui/modal.tsx` internals later; modal.tsx itself is Foundation-deferred (not in any batch). |
| `popover.tsx` | `EditorialPopover` parts | `@ui-sdk/react/popover` | Thin; used by app-rail "More" menu (3E). |
| `page-header.tsx` | `EditorialPageHeader` | pure | Props `{ eyebrow?, title, meta?: ReactNode, actions?, tabs?: ReactNode }`. Serif `text-2xl` title, eyebrow `text-[11px] uppercase tracking-[0.14em] text-faint`, `meta` inline strip, `actions` right-aligned, `tabs` rendered flush under with the baseline hairline. `as` heading level via `headingLevel?: 1 \| 2` (default 1; **2 when embedded in PluginDetail**). |
| `group.tsx` | `EditorialGroup` | pure | `{ title, description?, actions?, children }` → `border-t border-border pt-5` + uppercase muted heading + right action slot. |
| `preference-row.tsx` | `PreferenceRow` | pure | `{ label, hint?, htmlFor?, children, align? }`; grid `[minmax(0,1fr)_auto]`, row bottom hairline `border-b border-border/70 last:border-b-0`, `py-3`. Control sits right; collapses to stacked under `sm`. |
| `kpi-strip.tsx` | `KpiStrip` | pure | `{ items: {label, value, tone?}[] }`; flex, `divide-x divide-border`, `font-serif text-xl tabular-nums` values, uppercase `text-[11px]` labels, no border/background. Wraps to 2-col grid under `sm`. |
| `expandable-row.tsx` | `ExpandableRow` | `Disclosure` | `{ summary: ReactNode, open?, defaultOpen?, onOpenChange?, children }`. Row = hairline-separated button; panel = `ml-1 border-l-2 border-[var(--accent)] pl-4 py-3`. **No `border`/`bg` on the panel.** |
| `segmented-control.tsx` | `SegmentedControl` | `@ui-sdk/react/` radio-group or toggle-group entry (check docs; no hand-rolled `radiogroup`) | `{ value, onValueChange, options: {value,label}[], size? }`. Used for Settings enum choices and capability pills. |

Do not delete or restyle `packages/ui/src/components/motion/*` in this refactor: other (non-redesigned) screens
(`log-panel`, composer, workspace inspector) still import them. Old and new coexist; batches migrate their own
files only.

---

## 3. `@tsukaima/sdk/ui` backwards-compatible overhaul (Foundation owns; exports/props unchanged)

Props stay source-compatible (declarative-registry and 6 plugins depend on them). Visuals only, plus additive props.

| Component | Change |
| :-- | :-- |
| `PluginSection` | Remove `rounded-xl border bg-card/40` and the `border-b` title bar and `p-4` body padding. New: `<section className="border-t border-border pt-5 first:border-t-0 first:pt-0">`; header row = uppercase `text-[11px] tracking-[0.14em] text-muted-foreground` title (render `h3`), `description` as `text-xs` under it, `actions` right; body `pt-3`. Optional new prop `bare?: boolean` is **not** added. |
| `PluginPage` | New prop `embedded?: boolean` (default `true`; PluginDetail always embeds). When embedded: no `h2` page title block, only an optional compact sub-header (`description` + `actions` on one line, `text-sm text-muted-foreground`); `title` rendered as visually-hidden `h2` (`sr-only`) so heading outline and SSR text still contain it (tests assert titles like "Channel status"). `embedded={false}` keeps the editorial `h2` serif title. |
| `Stat` / `StatGrid` | No border/bg. `StatGrid` → flex row `divide-x divide-border`, wrap on small; `Stat` → label uppercase `text-[11px]`, value `font-serif text-xl tabular-nums truncate`. Same `items` prop. |
| `PluginConfigForm` (`config-form.tsx`) | Rows → `PreferenceRow`-style horizontal layout (label+hint left, control right). `Field` wrapper keeps `label/hint/error/required` props. Nested `object` and boolean-`detail` branches: replace every `rounded-lg border` box with `ml-1 border-l-2 border-[var(--accent)] pl-4`. Native `Switch`/`Select`/`Input` swapped to `EditorialSwitch`/`EditorialSelect` and kept `Input`. Preserve exactly: label/hint/enum-label text output, the `t:`-prefixed i18n keys, "Edit this in JSON" fallback text, `Stored`/`Missing` secret status text. |
| `Alert` | `border-l-2` tone rail + `bg-transparent`/`bg-muted/30`; keep `role="alert"` (danger) / `role="status"` and icons. No full rounded box border. |
| `EmptyState` | No dashed rounded box; centered text with top hairline `border-t border-border`, serif title. |
| `KeyValueList` | Rows with `border-b border-border/60`, `dt` `text-muted-foreground`, mono values opt-in via `className`. Same `items` prop. |
| `CodeBlock` | `rounded-sm`, 1px `--line` border *only* (no inner nested boxes), `bg-muted/50`, `font-mono`. |
| `StatusBadge` / `StatusDot` | Flat: drop pill border; dot + `text-xs`, optional hairline underline-free. Keep `label`, `disabled`, `stale` semantics and `"· stale"` text. |
| `ProgressBar` | Keep; thin track `h-1`, `rounded-none`. `role="progressbar"` here is native-semantic on a non-ui-sdk component; leave as is (ui-sdk lacks a plain meter we need). |
| `index.tsx` | Add exports for all `Editorial*`/structural helpers (§2) **additively**; leave every existing export. |

**Tests that must keep passing unchanged:** `packages/sdk/src/ui/config-form.test.tsx` (labels, `t:config_*`,
"Stored"/"Missing", "Edit this in JSON", no raw key in `>key<`), `packages/sdk/src/ui/registry.test.tsx`,
`apps/web/src/plugins/plugin-panels.test.tsx` (EN+ZH strings for "Channel status", "WebSocket URL", "Reply with a
quote", "Reconnect backoff", "Connection", "Models", "Discover models", "fast-chat", "Fast Chat"; not `>wsUrl<`),
`apps/web/src/routes/(system)/_modules/memories-page.test.tsx`, and
`apps/web/src/routes/_modules/policy/conversation-policy-fields.test.ts`.
Foundation adds new tests: `packages/ui/src/components/editorial/*.test.tsx` (SSR render + keyboard via
`createAgent`/testing-library only if already installed; else SSR `renderToString`) and a PluginSection/StatGrid
SSR markup test asserting **no** `rounded-xl` / `bg-card` classes.

---

## 4. i18n rule (prevents `messages/*.json` collisions)

1. **Batches 3A–3E must not edit `apps/web/messages/en.json` or `zh-cn.json`.** Reuse existing `m.*()` keys only.
2. If a worker finds it needs a genuinely new key, it must **not** add it. Instead it uses the nearest existing key
   and appends a line to its PR description under "Needs new i18n key: `key` – EN – ZH". Foundation (or a final
   single integration commit after all five batches) adds all of those at once, then workers' follow-up replaces
   fallbacks.
3. Foundation pre-adds the keys that structural redesign certainly needs (all both locales, alphabetical per file
   conventions): `settings_policy_jump_to` (jump tabs label), `settings_unsaved_changes`, `common_collapse`,
   `common_expand`, `settings_upgrade_strip_label`. Adjust after reading the existing key naming in the json;
   every key added to en.json must be added to zh-cn.json in the same commit. Run
   `bun run --filter '@tsukaima/web' check:i18n` and `lint:i18n`.
4. Plugin batches (3C `mcp`/`openai-compatible`, 3D others) own their plugin's `plugins/<id>/messages/*.json`
   exclusively; no cross-plugin key edits. After editing, run `bun run --filter '@tsukaima/web' i18n:plugins`
   (output `src/paraglide` is generated/ignored per repo; do not hand-edit).
5. Never hardcode user-visible English strings in new markup.

---

## 5. Parallel batch ownership matrix (zero overlap)

Legend: `S` = `apps/web/src/routes/(system)/_modules/`, `R` = `apps/web/src/routes/`. Every worker may **only**
create/edit the files listed in its row. Anything else (including a neighbouring batch's file, Foundation files,
`messages/*.json`, `route-tree.gen.ts`) → do not touch; report instead.

### Batch 3A: Settings Core
Owns: `S/settings-layout.tsx`, `S/page-header.tsx`, `S/settings-page.tsx`, `S/prompt-settings.tsx`,
`S/runtime-maintenance-card.tsx`.

- `page-header.tsx`: becomes a thin wrapper over `EditorialPageHeader` (keep its current export name and props so
  3B/3C/3E importers keep compiling; add optional `tabs`, `meta`, `eyebrow`). **3A must keep the existing call
  signature backward compatible** because 3B/3C import it concurrently.
- `settings-layout.tsx`: single-line sidebar rows (drop 2-line descriptions), reuse `AdminShell` sidebar width
  tokens (do not edit `admin-shell.tsx`; consume its exported API as-is), underline `EditorialTabs` for sub-views.
- `settings-page.tsx` (General): `Card`s → `EditorialGroup` + `PreferenceRow` + `EditorialSelect`/`EditorialSwitch`/
  `SegmentedControl`. Zero `<Card>`.
- `prompt-settings.tsx`: 10+ stacked cards → split list (templates/personas) + one flat editor pane
  (`font-mono` textarea with hairline). Zero `<Card>`.
- `runtime-maintenance-card.tsx`: card → `EditorialGroup` rows; keep filename/exports (route `settings.maintenance.tsx`
  imports it).
- **Do NOT touch:** any 3B file, `settings.*.tsx` route files except none (3A edits no route file; routes only
  import 3A modules by existing names), `plugin-*`, shell, messages.
- Tests: `bun test "apps/web/src/routes/(system)"` and `bun run --filter '@tsukaima/web' typecheck`.

### Batch 3B: Settings Policies & Upgrades
Owns: `S/policy-defaults-card.tsx`, `apps/web/src/routes/_modules/policy/conversation-policy-fields.tsx`,
`S/upgrade-center.tsx`, `S/repository-status-card.tsx`, `S/github-card.tsx`, `R/(system)/settings.upgrades.tsx`.

- Policies: sticky category jump tabs, hairline `PreferenceRow` rows, floating unsaved bar (`Reset` · `Override
  All` · `Save`). Keep exported prop types and the pure helpers `policy-patch.ts` + test untouched (`policy-patch.ts`
  and `conversation-policy-fields.test.ts` are read-only for everyone; if a prop contract change is needed, keep
  the old one).
- Upgrades: 6 cards → one top `KpiStrip` (Version | Branch | Commit | Tree | Upstream | GitHub) + action row
  (Fetch / Restart / Upgrade) + flat history / CI run tables (hairline rows, mono hashes). `repository-status-card`
  and `github-card` become section components (`EditorialGroup`) but keep file names + exports.
- **Do NOT touch:** `page-header.tsx` (consume only), 3A files, plugin files, shell.
- Tests: `bun test apps/web/src/routes/_modules/policy "apps/web/src/routes/(system)"`; `bun run
  --filter '@tsukaima/web' typecheck`. Restart/upgrade flows must keep their confirm dialogs & audit calls
  (AGENTS.md: observable/resumable restart): UI-only change, no behaviour change.

### Batch 3C: Plugin Host + MCP + OpenAI-Compatible
Owns: `S/plugin-layout.tsx`, `S/plugin-detail.tsx`, `S/plugin-route.tsx`, `plugins/mcp/src/ui.tsx`,
`plugins/mcp/messages/*`, `plugins/openai-compatible/src/ui.tsx`, `plugins/openai-compatible/messages/*`.

- Plugin host: one canonical header (`EditorialPageHeader`, eyebrow `Plugins / <id>`, serif name, status +
  version meta, enable switch in `actions`) + `EditorialTabs` underline bar. Panels render `PluginPage embedded`
  (default) beneath, so there is exactly **one** title. Remove duplicated sidebar width classes (`w-60 lg:w-64`)
  in favour of shell tokens.
- `mcp/ui.tsx`: `ServerCard` (rounded-xl border) → hairline `ExpandableRow`; OAuth strip, `KeyValueList`, 2-col
  mono tool index inside the single left-rail panel. **No nested bordered box** inside the expanded panel.
- `openai-compatible/ui.tsx`: Endpoint / API key as `PreferenceRow`s; model list = hairline rows; capability
  toggles as `SegmentedControl`/pill toggle set (`Tools`, `Reasoning`, `Image`, `Audio`, `Sidechat`);
  parameters in `ExpandableRow` grid. `ModelCard` removed.
- Preserve text asserted by `plugin-panels.test.tsx` ("Models", "Discover models", "fast-chat", "Fast Chat").
- **Do NOT touch:** `packages/sdk/**` (use only public exports from `@tsukaima/sdk/ui`), other plugins, 3A/3B files.
- Tests: `bun test apps/web/src/plugins plugins/mcp plugins/openai-compatible packages/sdk`; typecheck.

### Batch 3D: Remaining Plugins
Owns: `plugins/onebot-napcat/src/ui.tsx` (+`messages/*`), `plugins/proactive-scheduler/src/ui.tsx`
(+`messages/*`), `plugins/skills/src/ui.tsx` (+`messages/*`), `plugins/sticker-meme/src/ui.tsx` (+`messages/*`).

- Apply the same grammar: `PluginSection` hairline groups, `StatGrid` KPI strip, `ExpandableRow`, flat tables.
  Remove local `rounded-*` `border` containers that wrap other bordered items (grep `rounded-` / `border ` in each
  file; 2230-line `sticker-meme/ui.tsx` is the long pole: split work internally by section, keep one file).
- onebot-napcat panel text asserted in `plugin-panels.test.tsx` (EN+ZH) must survive.
- Never include real sticker libraries / QQ ids / chat content in fixtures or copy (AGENTS.md privacy).
- **Do NOT touch:** 3C plugins, `packages/*`, `apps/web/**` (including its tests; if a test asserts classes,
  report instead of editing).
- Tests: `bun test plugins/onebot-napcat plugins/proactive-scheduler plugins/skills plugins/sticker-meme
  apps/web/src/plugins`; typecheck.

### Batch 3E: Shell, Directory, Tasks, Memories, Chat / Inspector
Owns:
`R/_modules/shell/admin-shell.tsx`, `R/_modules/shell/app-rail.tsx`, `R/_modules/shell/chat-sidebar.tsx`,
`R/_modules/directory/{directory-page,group-detail-page,user-detail-page,request-detail-page}.tsx`,
`S/memories-page.tsx`, `S/memory-rows.tsx`, `R/(tasks)/_modules/tasks-page.tsx`,
`R/(messaging)/_modules/{chat-page,context-panel-view,session-inspector-sidebar}.tsx`.

- Shell: 52px `--rail` app rail with 2px `--accent` left active indicator; theme toggle, Logs (`Ctrl+\``) and
  More (`EditorialPopover`) at the bottom. `AdminShell` exposes the one shared resizable sidebar API
  that 3A/3C consume; **3E must not rename or change `AdminShell`'s existing public props/exports**: only add
  optional ones (3A/3C code compiles against the pre-change API in parallel).
- `memories-page.tsx` drops `<Card>` (hairline rows) and **must keep** the strings/structure asserted by
  `memories-page.test.tsx`.
- Chat/Inspector: serif reading prose via `font-serif` on message body only (do not touch
  `.message-markdown` CSS, that's Foundation), left-ruled mono tool rows, recessed inspector with a segmented
  token bar + tabular table. Keep `context-panel.test.tsx`, `session-inspector.test.tsx`, `run-steps.test.tsx`,
  `live-run-message.test.tsx`, `tool-call-row.test.tsx`, `message-composer.test.tsx` green: they are in neighbouring
  files 3E does **not** own, so changes in owned files must not alter props those files pass.
- **Do NOT touch:** `tool-call-row.tsx`, `run-steps.tsx`, `message-composer.tsx`, `live-run-message.tsx`,
  `context-panel.tsx`, `session-inspector.tsx`, `log-panel.tsx`, `chat-tree.tsx`, other sidebars
  (`groups/requests/users/workspace-sidebar.tsx`), `primitives.tsx`, `request-meta.tsx`, `modal.tsx`: unowned,
  frozen for this refactor.
- Tests: `bun test "apps/web/src/routes"`; typecheck.

### Overlap proof
Union of the five lists + Foundation list has no shared path. Cross-batch **imports** are allowed only against
files whose *public API is frozen*: `page-header.tsx` (3A; backward-compatible), `AdminShell` (3E; additive-only),
`@tsukaima/ui` editorial exports and `@tsukaima/sdk/ui` (Foundation; frozen).

---

## 6. Worker finish checklist (every batch, every item)

- [ ] **Zero `<Card>`/`CardContent`** imports in the files you own for Settings/Plugins (`grep -n "Card" <files>`).
- [ ] **No box-in-box:** no element with `border` + `rounded` inside another element with `border`; expandable
      panels use only the 2px left rail. Allowed borders: hairline `border-t/b` dividers, input/select controls,
      `CodeBlock`.
- [ ] No leftover `bg-card/40`, `rounded-xl`, `rounded-2xl` containers, no `10.5px` micro-text (≥ 11px).
- [ ] Colors only through tokens (`text-muted-foreground`, `border-border`, `var(--accent)`); no raw hex.
      Verify light **and** dark: text ≥ 4.5:1, control/focus edges ≥ 3:1 (check in real browser at both themes;
      jsdom can't).
- [ ] Mono + `tabular-nums` for ids, hashes, URLs, counts, timestamps; serif only for titles/KPI values.
- [ ] Use editorial/ui-sdk primitives for tabs, switches, selects, dialogs, popovers: no hand-written
      `role="tablist|switch|listbox|dialog|menu|radiogroup"`, no native `<input type="checkbox">`.
- [ ] Every control has an accessible name (label part or `aria-label`); lists keyed by id/value, never index.
- [ ] Tabs for indentation; `bun run format:check` and `bun run lint` clean for your files.
- [ ] `exactOptionalPropertyTypes`: never pass `prop={maybeUndefined}` to optional props; use conditional spread
      `{...(x === undefined ? {} : { prop: x })}`.
- [ ] No new comments except non-obvious invariants (browser quirk, trade-off); no JSDoc on app code; no license
      headers.
- [ ] i18n: no new keys in `apps/web/messages/*` (see §4); no hardcoded English; plugin batches keep EN+ZH in
      plugin messages in sync.
- [ ] No behaviour/RPC/contract changes; no ad-hoc SQL; no new API shapes (AGENTS.md).
- [ ] Privacy: synthetic data only in tests/fixtures; no real hosts, IDs, chat text.
- [ ] Ran your batch's targeted tests + `bun run typecheck` (root) and report each command with exit code, plus
      anything unverified (visual check in both themes via `bun run --filter '@tsukaima/web' dev` at 127.0.0.1:7421).

Final integration (single owner, after all batches merge): `bun run check`, `bun run --filter '@tsukaima/web' build`,
`bun run check:i18n`, grep gates (`<Card` in `(system)/` and plugins = 0, `rounded-xl border` in
`packages/sdk/src/ui` = 0), and screenshot pass of Settings (General / Policies / Prompts / Upgrades / Maintenance),
Plugins (each of 6), Directory, Tasks, Memories, Chat + Inspector in light and dark.

---

## 7. Critical gotchas

- **G1 SSR tests:** every current UI test is `renderToString` text matching. ui-sdk wrappers must SSR cleanly;
  verify with a smoke test in Foundation *before* the batches fan out. If `@ui-sdk/react/select` renders option
  text only when open, keep a `title`/visible value text so existing assertions don't regress or update the
  Foundation test, never the batch tests.
- **G2 `--accent` meaning changes:** today `--accent` is a light mist **fill** (`bg-accent`) with
  `--accent-foreground` dark text; the design makes `--accent` the saturated slate-blue **ink** (`#48667b` /
  `#8faeC4`). Foundation must grep `bg-accent|text-accent|border-accent` across `apps/` `packages/` `plugins/` and
  confirm contrast (white `--accent-fg` on `#48667b` OK; on dark `#8faec4` use `--accent-fg: #131518`). If many
  low-emphasis `bg-accent` hovers exist, introduce `--accent-soft: color-mix(in oklab, var(--accent) 14%, transparent)`
  and map `--color-accent` to it, keeping `--color-ring`/rails on the strong value.
- **G3 `@layer ui-sdk;` must be line 1** of `app.css`, before `@import "tailwindcss"` (layer order is first-declared).
- **G4 Plugin i18n is per plugin** (own Paraglide compile): plugin batches don't collide with web messages but
  must run `i18n:plugins`; generated `src/paraglide` output is not hand-edited.
- **G5 `route-tree.gen.ts`** is generated by the router plugin during build/dev; no worker commits changes to it
  (3B edits `settings.upgrades.tsx` content only, no route path changes).
- **G6 Frozen-API cross-imports** (`page-header`, `AdminShell`) are the only intra-batch coupling; additive-only
  changes there.
- **G7 `packages/ui` motion components stay:** other unredesigned screens still import them. Do not delete.
- **G8 Fonts offline:** verify build offline and absence of external font URLs; CJK uses unicode-range slices.
- **G9 Heading duplication:** `PluginPage` is embedded in `PluginDetail`; render its title `sr-only` (tests expect
  the title text), never as a second visible `h2`.
- **G10 Deployment & release:** no worker touches `ops/deploy/*`, `VERSION`, or `CHANGELOG.md`.
