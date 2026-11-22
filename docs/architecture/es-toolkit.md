# es-toolkit conventions

## Purpose

Tsukaima manipulates plain JS objects heavily: unpacking patches, merging policy layers (global → persona → conversation), normalising config/frontmatter/RPC payloads, and shaping records for persistence. Hand-rolled `Object.fromEntries(Object.entries(...).filter(...))` chains, spread cascades and per-file `isRecord` guards made that code hard to follow. We standardise on [`es-toolkit`](https://es-toolkit.dev) for these operations.

## Rules

1. Import named helpers from the package root: `import { omitBy, isPlainObject } from "es-toolkit";`. Never import `es-toolkit/compat` (lodash-compat shims are slower and hide semantic differences).
2. The version is pinned exactly in every `package.json` that uses it; bump it everywhere at once.
3. Prefer a helper over a hand-written loop only when it reads better. Do not wrap trivial code.
4. Keep Zod (`packages/contracts`) as the schema/validation source of truth; es-toolkit is for shaping data, not validating wire input.
5. Prefer native APIs when equivalent (`structuredClone`, `Array.prototype.flatMap`, `Object.groupBy`) — don't add an es-toolkit call just to replace a native one.

## Cheat sheet

| Intent | Instead of | Use |
| --- | --- | --- |
| Drop `undefined` fields from a patch | `Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))` | `omitBy(p, isUndefined)` |
| Keep only matching keys | `Object.fromEntries(Object.entries(o).filter(...))` | `pickBy(obj, predicate)` |
| Drop keys | rest-destructuring / delete loops | `omit(obj, ["a", "b"])` |
| Keep keys | manual pick | `pick(obj, ["a", "b"])` |
| Transform values / keys | `Object.fromEntries(Object.entries(o).map(...))` | `mapValues` / `mapKeys` |
| Non-mutating deep merge | nested spreads with `??` | `toMerged(base, patch)` / `toMergedWith` |
| Dedupe | `Array.from(new Set(xs))` | `uniq` / `uniqBy` |
| Index / group / split | reduce boilerplate | `keyBy`, `groupBy`, `partition`, `chunk` |
| Drop falsy | `.filter(Boolean)` | `compact` |
| Bounds | `Math.min(Math.max(x, lo), hi)` | `clamp(x, lo, hi)` |
| Deep equality | `JSON.stringify(a) === JSON.stringify(b)` | `isEqual(a, b)` |
| Plain-object guard | per-file `isRecord` copies | `isPlainObject` (see caveat) or one shared local guard |
| Wait | hand-written `sleep` | `delay(ms, { signal })` |

## Semantics to keep in mind

- **Patch contract:** in policy/config patches `undefined` means "keep the base value" and `null` means "clear the override". `omitBy(patch, isUndefined)` implements the first; handle `null` explicitly after merging.
- **Arrays are replaced, not merged index-wise**, in our patch semantics. es-toolkit's deep merge merges arrays by index; use `toMergedWith` with a customizer that returns the patch array, or merge sections explicitly.
- **Mutation:** `merge`/`mergeWith` mutate the target; use `toMerged`/`toMergedWith` or start from `{}`.
- **`isPlainObject` vs `isRecord`:** `isPlainObject` rejects class instances, `Map`, `Date`. Use it for JSON/config-shaped data. If a site can legitimately receive class instances, keep an explicit guard. `isPlainObject` narrows to `Record<PropertyKey, any>`; shared local guards keep the narrower `Record<string, unknown>` predicate at call sites.
- **`exactOptionalPropertyTypes`:** helpers such as `omitBy`/`pickBy` return partial types; never introduce `{ key: undefined }` for optional keys.
- **Order:** helpers preserve insertion order, but sites that persist or hash order-sensitive output (prompts, cache keys) must be verified by tests before changing.

## Where it is used

Workspace packages that depend on `es-toolkit`:

- `apps/server` — conversation policy merge, shared record guards, log-field normalization, collection bounds/dedupe.
- `packages/migration` — one shared `isRecord` guard (`src/guards.ts`), secret redaction shaping, snapshot/pipeline fingerprints, dedupe.
- `packages/sdk` — RPC/plugin bridge record guards and plugin config form guards.
- `plugins/mcp`, `plugins/onebot-napcat`, `plugins/proactive-scheduler`, `plugins/skills`, `plugins/sticker-meme` — plugin-local record guards plus their merge, masking, dedupe, and bounds helpers.

Deliberately excluded:

- `packages/contracts` — Zod is the schema/validation source of truth; no object-shaping dependency.
- `packages/db` — Drizzle schema, migrations, and snapshots are generated or ORM-shaped.
- `apps/web`, `packages/ui` — no current site justified a new browser/runtime dependency; native array/object APIs remain clear there.
- `packages/core`, `packages/coding`, `packages/plugin-registry`, `packages/durable`, `packages/cache`, `packages/chaos`, `tools/migration` — remaining candidates are isolated one-line guards or native calls; adding a dependency per package would not pay for itself.
- `e2e` — two local timer helpers; e2e scripts stay on host builtins instead of taking a root runtime dependency.
