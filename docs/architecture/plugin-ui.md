# Plugin UI, status, and i18n

**Status:** design proposal, 13 November 2026

**Audience:** plugin authors, WebUI implementers, reviewers

**Scope:** the plugin management page, trusted React panels, status reporting, the shared UI kit, and plugin-localized strings.

This document is the implementation contract for the next plugin UI iteration. It extends
[plugin-sdk.md](plugin-sdk.md) and [web-ui.md](web-ui.md); it does not replace the manifest,
permission, or worker rules already recorded there.

## 1. Problem

The current plugin surface has three gaps:

1. `admin.plugins.list` returns manifest metadata, but the WebUI renders one generic card per
   plugin. There is no per-plugin workspace, no navigation, and no place for a plugin to show
   its own state.
2. `context.ui.register()` stores a data-only declaration. The WebUI never renders a plugin
   React component, and there is no status channel from the plugin runtime to the page.
3. The WebUI uses Paraglide for its own strings, but plugins have no supported way to ship
   translations or read the active locale. A plugin either hard-codes English or invents its own
   locale store.

## 2. Decisions at a glance

| Area           | Decision                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation     | `/plugins` becomes a two-pane route: plugin list on the left, selected plugin on the right. Deep-linkable as `/plugins/$pluginId`.                                                                                         |
| Trusted UI     | Built-in and first-party plugins may ship a React panel that is bundled into the admin app at build time.                                                                                                                  |
| Third-party UI | A third-party plugin may ship a React panel, but only when it is built into the admin bundle from the workspace. Opening it shows a confirmation warning first; runtime-installed plugins still fall back to data-only UI. |
| UI kit         | `@tsukaima/sdk/ui` exports a curated React kit that uses the host theme tokens. It is the only supported visual layer for plugin panels.                                                                                     |
| Status         | `context.ui.setStatus()` publishes a validated, bounded snapshot. The host stores it, includes it in `admin.plugins.list`, and streams `plugin.status` live events.                                                        |
| i18n           | `@tsukaima/sdk/i18n` binds a plugin's Paraglide-compiled messages to the host locale. A runtime-dictionary fallback exists for plugins without a build step.                                                                 |
| Config         | The existing JSON-schema config form moves into the shared kit and is reused by the fallback page and by custom panels.                                                                                                    |
| Isolation      | Each panel is wrapped in an error boundary and loaded lazily. One plugin cannot blank the admin page.                                                                                                                      |

## 3. Trust model

A React panel runs in the admin page with the administrator's session cookie. It can call
`fetch`, read the DOM, and use the same origin as the admin console. Treating a plugin panel as
"just a component" is therefore a privilege escalation for any plugin the administrator did not
write or review.

Three tiers are defined:

| Tier            | Who                                                           | Mechanism                                                                     | Status                |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------- |
| Built-in panel  | Built-in and first-party plugins                              | Build-time import of `src/ui.tsx`, same React tree                            | Implemented           |
| Warned panel    | Third-party plugin that ships a panel in the workspace bundle | Same build-time import, gated behind a confirmation modal                     | Implemented           |
| Declarative UI  | Third-party plugin without a bundled panel                    | Manifest `ui` entries rendered by host components; actions are namespaced RPC | Generic fallback page |
| Sandboxed panel | Runtime-installed third-party plugin                          | `<iframe sandbox>` with a scoped postMessage bridge and no admin cookie       | Future work           |

All internal plugins are expected to provide a panel. A third-party plugin that ships a panel is
treated as untrusted code: the page shows a modal that explains the panel runs with the admin
session and requires explicit confirmation before mounting. A plugin cannot opt itself into the
trusted tier through its manifest; the WebUI build decides which modules are importable.
Runtime-installed plugins are not part of the bundle and therefore use the fallback page.

## 4. Package and file layout

```text
packages/sdk/
  src/index.ts                  server-safe exports (unchanged)
  src/ui/index.tsx              @tsukaima/sdk/ui
  src/ui/components/*.tsx       shared primitives
  src/ui/plugin/*.tsx           PluginPage, PluginPanel, PluginErrorBoundary
  src/i18n/index.ts             @tsukaima/sdk/i18n

plugins/onebot-napcat/
  src/ui.tsx                    trusted panel entry
  messages/en.json              plugin-local Paraglide messages
  messages/zh-cn.json
  project.inlang/settings.json

apps/web/src/
  plugins/registry.ts           generated virtual module consumer
  routes/(system)/plugins.tsx   two-pane layout
  routes/(system)/plugins.index.tsx
  routes/(system)/plugins.$pluginId.tsx
  routes/(system)/_modules/plugin-sidebar.tsx
  routes/(system)/_modules/plugin-detail.tsx
  routes/(system)/_modules/plugin-fallback.tsx

apps/server/src/services/
  plugin-status.ts              in-memory status store
```

`@tsukaima/sdk/ui` is a subpath export so server code never imports React:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./ui": "./src/ui/index.tsx",
    "./i18n": "./src/i18n/index.ts"
  },
  "peerDependencies": {
    "react": "^19.0.0"
  }
}
```

## 5. Author API

### 5.1 Server: status reporting

The server-side plugin runtime gains one UI method. It is fire-and-forget: an invalid payload is
logged and dropped, never thrown into message processing.

```ts
context.ui.setStatus({
  level: "ok",
  code: "onebot.status.connected",
  summary: "Connected to NapCat",
  metrics: { events: 1_284, reconnects: 0 },
  details: { endpoint: "ws://127.0.0.1:3001", account: "10001" },
  staleAfterMs: 30_000,
});
```

```ts
export type PluginStatusLevel = "ok" | "warning" | "error" | "unknown";

export interface PluginStatusInput {
  level: PluginStatusLevel;
  /** Optional message key the client can localize with the plugin's own catalog. */
  code?: string;
  /** Fallback text when the client has no message for `code`. */
  summary?: string;
  /** Longer diagnostic text; rendered in an expandable area. */
  message?: string;
  progress?: { current: number; total?: number; label?: string };
  metrics?: Record<string, string | number | boolean>;
  details?: Record<string, string | number | boolean | null>;
  /** The client renders a stale indicator after this long without an update. */
  staleAfterMs?: number;
}

export interface PluginStatusSnapshot extends PluginStatusInput {
  /** Stamped by the host, not by the plugin. */
  updatedAt: string;
}
```

Rules:

- The host stamps `updatedAt`; a plugin cannot backdate a status.
- `level` is the only required field. `code` is preferred for localized display; `summary` is
  the fallback.
- The serialized payload is capped at 8 KiB. `metrics` and `details` are capped at 32 keys each;
  strings are capped at 2 KiB. Oversized payloads are rejected.
- Status is in-memory health data. Durable counters belong in `context.storage`.
- `setStatus` is gated by the `ui.panel` permission.
- A plugin's status is cleared on teardown and after a worker crash.
- Secrets must never appear in status. The host rejects values that exactly match a declared
  secret value when it can resolve them; this is best-effort hardening, not a substitute for
  author discipline.

### 5.2 Client: panel entry

Trusted plugins add a browser entry that is separate from their server entry:

```tsx
// plugins/onebot-napcat/src/ui.tsx
import { definePluginUi } from "@tsukaima/sdk/ui";
import { i18n } from "./i18n.ts";
import { ConnectionPanel } from "./panels/connection.tsx";
import { EventsPanel } from "./panels/events.tsx";

export default definePluginUi({
  i18n,
  displayName: (t) => t("plugin_name"),
  description: (t) => t("plugin_description"),
  panels: [
    {
      id: "connection",
      title: (t) => t("panel_connection"),
      icon: "plug",
      component: ConnectionPanel,
    },
    {
      id: "events",
      title: (t) => t("panel_events"),
      icon: "activity",
      component: EventsPanel,
    },
  ],
});
```

`definePluginUi` is an identity helper that gives authors inference and validation. The module
must have a default export. The build-time registry reads it lazily.

### 5.3 Client: panel context

Every panel receives one context. Hooks are the preferred access path for nested components.

```ts
export interface PluginPanelContext {
  plugin: PluginSummary;
  status: PluginStatusSnapshot | null;
  rpc: {
    call<T = unknown>(method: string, input?: unknown): Promise<T>;
  };
  config: {
    value: Record<string, unknown>;
    secretsSet: readonly string[];
    save(patch: Record<string, unknown>): Promise<void>;
    saving: boolean;
  };
  i18n: PluginI18n;
  notify: {
    success(message: string, description?: string): void;
    error(message: string, description?: string): void;
    info(message: string, description?: string): void;
  };
  refresh(): Promise<void>;
}
```

```tsx
import { usePluginPanel, Button, StatusBadge, StatGrid } from "@tsukaima/sdk/ui";

export function ConnectionPanel() {
  const { status, rpc, i18n, notify } = usePluginPanel();
  const [reconnecting, setReconnecting] = useState(false);

  return (
    <PluginSection title={i18n.t("connection_title")}>
      <StatusBadge status={status} />
      <StatGrid
        items={[
          { label: i18n.t("events"), value: status?.metrics?.events ?? "—" },
          { label: i18n.t("reconnects"), value: status?.metrics?.reconnects ?? "—" },
        ]}
      />
      <Button
        disabled={reconnecting}
        onClick={async () => {
          setReconnecting(true);
          try {
            await rpc.call("reconnect");
            notify.success(i18n.t("reconnect_started"));
          } catch (error) {
            notify.error(i18n.t("reconnect_failed"), String(error));
          } finally {
            setReconnecting(false);
          }
        }}
      >
        {i18n.t("reconnect")}
      </Button>
    </PluginSection>
  );
}
```

`rpc.call("reconnect")` invokes `admin.plugins.rpc` with `{ method: "<pluginId>.reconnect" }`.
The host validates that the method belongs to the plugin whose panel is mounted.

### 5.4 Client: config form

The kit exports a presentational form driven by the manifest's `configSchema`:

```tsx
<PluginConfigForm
  schema={plugin.configSchema}
  value={config.value}
  secretsSet={config.secretsSet}
  secretKeys={plugin.secretKeys}
  saving={config.saving}
  onSave={config.save}
  translate={(key) => i18n.t(key)}
  groups={[
    { titleKey: "group_connection", keys: ["mode", "wsUrl", "accessToken"] },
    { titleKey: "group_behaviour", keys: ["replyAsQuote", "splitMaxChars"] },
  ]}
  labels={{ save: i18n.t("save"), configured: i18n.t("configured") }}
/>
```

The host wrapper supplies the oRPC mutation; the plugin does not need to know the API shape.

Supported field shapes: `string`, `number`/`integer`, `boolean`, string `enum`, arrays of
strings (edited as a comma-separated list), nested `object` with scalar properties, and
`anyOf`/`oneOf` `boolean | { … }` unions (rendered as a switch whose object branch appears when
the switch is on). Any other shape renders the current JSON with an explanation instead of
being silently dropped.

Every field must be labelled and explained. The schema carries the copy, not the form:

```json
{
  "type": "string",
  "title": "WebSocket URL",
  "titleKey": "config_ws_url",
  "description": "NapCat forward WebSocket address…",
  "descriptionKey": "config_ws_url_hint"
}
```

- `title`/`description` are the English fallback shown by the host's generic plugin page.
- `titleKey`/`descriptionKey` are keys in the plugin's own Paraglide catalog; `translate`
  resolves them, and a key that is missing from the catalog falls back to the literal.
- `enumLabels` maps each `enum` value to a message key, so a mode reads "Forward (Tsukaima
  connects out)" instead of the raw value.
- `default` is used as the enum placeholder and as the initial switch state, so an unset
  field never renders as an empty "Select".
- Arrays of strings, numbers, and nested object properties accept the same three keys.

A field that the runtime does not read yet (for example a legacy key kept for migration)
must say so in its `description` rather than implying that it takes effect.

## 6. Host API

### 6.1 Build-time UI registry

Workspace plugins declare their browser entry in `package.json`:

```json
{
  "name": "@tsukaima-plugin/onebot-napcat",
  "tsukaima": {
    "id": "onebot-napcat",
    "ui": "./src/ui.tsx"
  }
}
```

The WebUI resolves entries with `import.meta.glob("../../../../plugins/*/src/ui.tsx")` and a lazy
import per plugin id. Missing entries are a normal state, not an error: the generic fallback page
is shown. The `tsukaima` field documents intent for tooling and future runtime installation; the
glob is what actually bundles code into the admin app today.

Implementation notes:

- A browser panel must import only browser-safe SDK subpaths (`@tsukaima/sdk/ui`,
  `@tsukaima/sdk/i18n`, `@tsukaima/sdk/model-capabilities`). The `@tsukaima/sdk` barrel also
  exports host bridges that use `node:crypto`; Vite externalizes that builtin, and the panel
  then fails on load. `apps/web/src/plugins/plugin-browser-imports.test.ts` walks the value
  import graph of every panel entry and rejects the barrel or a `node:` builtin.
- `resolve.dedupe: ["react", "react-dom"]` is required so workspace packages share the host
  React instance.
- Tailwind must scan the kit and plugin UI sources. Add to `apps/web/src/app.css`:
  `@source "../../../packages/sdk/src/ui";` and `@source "../../../plugins";`.
- The registry only includes plugins that are part of the workspace build. A plugin installed at
  runtime without a rebuilt WebUI falls back to the generic page.

### 6.2 Status store and live events

The host owns one in-memory store:

```ts
export class PluginStatusStore {
  set(pluginId: string, status: PluginStatusSnapshot): void;
  clear(pluginId: string): void;
  get(pluginId: string): PluginStatusSnapshot | undefined;
  list(): ReadonlyMap<string, PluginStatusSnapshot>;
  subscribe(listener: (pluginId: string, status: PluginStatusSnapshot | null) => void): () => void;
}
```

`PluginHost` creates a `LocalUiBridge` per plugin with an `onStatus` sink that writes to the
store. `TsukaimaLifecycle` exposes `pluginStatuses()` and `subscribePluginStatus()` for the event
stream.

`admin.plugins.list` rows gain:

```ts
{
  status: PluginStatusSnapshot | null;
  permissions: string[];
  tools: string[];
  rpcMethods: string[];
}
```

Live event contract:

```ts
export const livePluginStatusEventSchema = liveEventTimestampSchema.extend({
  type: z.literal("plugin.status"),
  pluginId: z.string().min(1),
  status: pluginStatusSnapshotSchema.nullable(),
});
```

On connect, the event stream publishes one `plugin.status` event per plugin after the normal
`snapshot`. The WebUI updates the `admin.plugins.list` query cache in place; it does not refetch
the whole list for every status tick.

### 6.3 RPC scoping

`admin.plugins.rpc` already audits every call. Add an optional `pluginId` to the input:

```ts
export const pluginRpcInputSchema = z.object({
  pluginId: z.string().min(1).optional(),
  input: z.unknown().optional(),
  method: z.string().min(1),
});
```

When `pluginId` is present, the host requires `method.startsWith(`${pluginId}.`)` and rejects
anything else. The SDK's `rpc.call` always sends it. Direct admin clients may omit it for
backward compatibility.

## 7. WebUI

### 7.1 Route structure

```text
/plugins                  layout: sidebar + <Outlet />
/plugins                  index: redirect to first plugin, or empty state
/plugins/$pluginId        detail: header + tabs + panel
```

The plugin route is full-bleed inside the admin shell (like `/diagnostics`) so the two panes can
own their scroll containers and separators. It does not use the centered `max-w-5xl` wrapper.

### 7.2 Layout

```text
┌──────────────────────┬──────────────────────────────────────────────┐
│ 插件                 │ onebot-napcat                 [ok] v0.1.0    │
│ 查看已安装插件…      │ 类型 builtin · 运行模式 host · 已启用        │
│ ┌──────────────────┐ │                                              │
│ │ ● onebot-napcat  │ │  [连接]  [事件]                              │
│ │   已连接 · 1,284 │ │  ┌────────────────────────────────────────┐  │
│ └──────────────────┘ │  │ 连接状态                               │  │
│ ┌──────────────────┐ │  │ StatusBadge · metrics · actions        │  │
│ │ ○ openai-…       │ │  └────────────────────────────────────────┘  │
│ │   未配置         │ │                                              │
│ └──────────────────┘ │                                              │
└──────────────────────┴──────────────────────────────────────────────┘
```

Sidebar:

- Header: title and one-line description.
- Search: filters by display name and plugin id.
- One item per installed plugin, including disabled plugins.
- Item anatomy: status dot, display name, one-line status summary, optional kind/version on the
  second line, selected background.
- Status dot: green `ok`, amber `warning`, red `error`, gray `unknown`, muted `disabled`.
- `aria-current="page"` on the selected item; the list is a `nav` with a list of links.
- Loading: skeleton rows. Error: retry card. Empty: the existing `plugins_empty` message.

Detail:

- Sticky header: display name, description, status badge, version, kind, run mode, enabled.
- Actions: "Refresh status" and "Open settings" (links to `/settings`); no fake enable toggle.
- If the plugin exports panels: tabs for each panel, then the active panel.
- If not: generic fallback.
- Unknown plugin id: not-found state with a link back to `/plugins`.
- Mobile: the sidebar becomes the list view; selecting a plugin replaces it with the detail and a
  back button.

### 7.3 Generic fallback

Every plugin gets a useful page even without a custom panel:

1. Status card: level, localized `code` or `summary`, `message`, progress, metrics, details,
   last update, stale indicator.
2. "No custom UI" empty state with a short explanation.
3. Config form from `configSchema`, if present.
4. Manifest facts: permissions, tools, RPC methods, model providers.

This is also the rendering for third-party plugins without a bundled panel, and for a
third-party plugin whose panel the administrator declined to open.

### 7.4 Panel rendering

```tsx
<PluginPanelBoundary pluginId={plugin.id} resetKey={panel.id}>
  <Suspense fallback={<PluginPanelSkeleton />}>
    <Panel />
  </Suspense>
</PluginPanelBoundary>
```

- Each panel gets its own error boundary. A thrown render error shows a compact error card with
  the plugin id and a retry button; the rest of the admin page stays usable.
- The panel is keyed by `plugin.id + panel.id` so switching tabs remounts state deliberately.
- The panel context is a React context; `usePluginPanel()` throws a clear error outside it.
- Lazy import failure is caught by the boundary and shows the same retry card.

## 8. i18n

### 8.1 Host locale

The host locale remains the Paraglide runtime in `apps/web`. `getLocale()` is the single source
of truth. The plugin shell passes `{ locale, i18n }` into each panel.

The existing `applyLocale` currently reloads the document through Paraglide's default
`setLocale` behavior. A reload is acceptable for phase 1: the plugin tree re-initializes with
the new locale. If the host later switches to `reload: false`, the plugin shell must subscribe
to a locale store and re-render; the context is already designed for that.

### 8.2 Paraglide binding (preferred)

Each plugin owns an inlang project and compiles to its own `src/paraglide` folder. The SDK binds
that compiled runtime to the host locale:

```ts
// plugins/onebot-napcat/src/i18n.ts
import { bindParaglide } from "@tsukaima/sdk/i18n";
import { m } from "./paraglide/messages.js";
import * as runtime from "./paraglide/runtime.js";

export const i18n = bindParaglide({
  messages: m,
  runtime,
  locales: ["en", "zh-cn"],
  baseLocale: "en",
});
```

`bindParaglide`:

1. Calls `runtime.overwriteGetLocale(() => activeLocale)`.
2. Calls `runtime.overwriteSetLocale(() => {})` so a plugin cannot change the host locale.
3. Returns a `PluginI18nSource` whose `bind(locale)` returns:

```ts
interface PluginI18n {
  locale: string;
  locales: readonly string[];
  t(key: string, params?: Record<string, string | number>): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
}
```

`t` calls the compiled message function, so keys and parameters are type-checked at the author
site. Missing keys fall back to the plugin base locale, then to the key itself. In development,
the SDK logs a warning once per missing key.

Build integration: the WebUI Vite config adds one `paraglideVitePlugin` instance per workspace
plugin that has `project.inlang`, with `outdir: "<plugin>/src/paraglide"` and
`strategy: ["baseLocale"]`. The host locale is forced by `overwriteGetLocale`, so the plugin
runtime does not do its own detection. If multiple instances collide on virtual module ids, fall
back to a prebuild script that compiles each plugin before the WebUI build.

### 8.3 Runtime dictionary fallback

Third-party plugins and quick prototypes may skip the build step:

```ts
export default definePluginUi({
  messages: {
    en: { plugin_name: "My plugin", save: "Save" },
    "zh-cn": { plugin_name: "我的插件", save: "保存" },
  },
  panels: [{ id: "main", title: (t) => t("plugin_name"), component: Main }],
});
```

The dictionary path supports `{name}` interpolation, base-locale fallback, and the same
`PluginI18n` interface. It does not support ICU plurals; use Paraglide when plurals or
compile-time key checking matter.

### 8.4 Status localization

Status is produced on the server, which does not know the browser locale. A plugin therefore
reports a stable `code` plus optional `params`; the client resolves it with the plugin's `t` and
falls back to `summary`. The sidebar uses the same resolution so status text is localized even
before a panel mounts.

### 8.5 Host strings

Add host messages for the new chrome:

```text
plugins_sidebar_title
plugins_search_placeholder
plugins_status_ok / warning / error / unknown / disabled
plugins_status_never
plugins_status_updated
plugins_status_stale
plugins_no_custom_ui
plugins_open_settings
plugins_refresh_status
plugins_panel_error
plugins_panel_retry
plugins_unknown
plugins_back
plugins_facts_permissions
plugins_facts_tools
plugins_facts_rpc
plugins_facts_providers
```

## 9. UI kit

The kit lives under `packages/sdk/src/ui`. It must not import `@/` aliases, app hooks, or the
app's React Query client. It depends only on React, the host theme tokens, and its own styles.
This keeps the kit usable from a plugin workspace package without pulling in the app shell.

| Component                                                                                  | Purpose                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `PluginPage`                                                                               | Panel page shell: title, description, actions, content spacing |
| `PluginSection`                                                                            | Titled content card                                            |
| `PluginToolbar`                                                                            | Right-aligned action row                                       |
| `StatusBadge` / `StatusDot`                                                                | Status level with label and optional stale marker              |
| `ProgressBar`                                                                              | Determinate or indeterminate progress                          |
| `Stat` / `StatGrid`                                                                        | Metric tiles                                                   |
| `KeyValueList`                                                                             | Definition list for details                                    |
| `DataTable`                                                                                | Typed columns, empty state, row actions                        |
| `EmptyState`                                                                               | Icon, title, description, optional action                      |
| `Alert`                                                                                    | Info/success/warning/danger banner                             |
| `Button` / `IconButton`                                                                    | Primary, secondary, ghost, danger; loading state               |
| `Field`                                                                                    | Label, hint, error, required marker                            |
| `Input` / `TextArea` / `SecretInput` / `NumberInput`                                       | Form controls                                                  |
| `Switch` / `Select` / `Checkbox`                                                           | Boolean and choice controls                                    |
| `Tabs`                                                                                     | Simple accessible tab list for panels                          |
| `CodeBlock` / `LogView`                                                                    | Read-only diagnostics                                          |
| `Spinner` / `Skeleton`                                                                     | Loading states                                                 |
| `RelativeTime`                                                                             | Locale-aware timestamp                                         |
| `PluginConfigForm`                                                                         | JSON-schema config form                                        |
| `usePluginPanel` / `usePluginRpc` / `usePluginConfig` / `usePluginI18n` / `usePluginToast` | Context hooks                                                  |

Rules:

- All colors, borders, radii, and spacing come from the host CSS variables (`--background`,
  `--card`, `--border`, `--primary`, `--danger`, `--success`, `--warning`, etc.). No hard-coded
  palette values.
- Every interactive element has a visible focus ring and an accessible name.
- Loading, empty, error, and disabled states are part of the component API, not an afterthought.
- Motion is optional and respects `prefers-reduced-motion`; the kit does not require `motion`.

Phase 1 implements the kit as a small, token-based layer. Phase 2 may extract the app's beUI
primitives into a shared `@tsukaima/ui` package and make the kit a re-export. Until then, the kit
must stay visually aligned by using the same token recipes and by reviewing both surfaces
together.

## 10. Permissions and security

- `ui.panel` is required for `context.ui.setStatus`, trusted panel registration, and declarative
  UI contributions. Built-in manifests add it.
- Trusted panels are code-reviewed workspace modules. The WebUI never imports a URL, a remote
  module, or a plugin-provided string as JavaScript.
- Third-party plugins cannot inject React in phase 1. Their `ui` declarations remain data and
  are rendered by host components.
- Status payloads are validated against a shared Zod schema, bounded in size, and stripped of
  non-serializable values.
- RPC calls are namespaced and audited. The SDK sends `pluginId`; the host rejects a method
  outside that namespace.
- Panels run in an error boundary; a crash is contained to the selected panel.
- No secrets in status. Config secrets continue to follow the existing `secretKeys` /
  `secretsSet` rules and are never returned to the client.

## 11. Migration plan

1. **Contracts and status store.** Add the status schema, `plugin.status` live event, plugin row
   fields, RPC `pluginId`, and the in-memory store. Add `ui.panel` to built-in manifests.
2. **Two-pane plugin page.** Add the layout, sidebar, detail route, search, fallback page, and
   config form reuse. This ships a usable page before any custom panel exists.
3. **SDK UI kit.** Add `@tsukaima/sdk/ui`, the Vite registry plugin, Tailwind sources, React
   dedupe, and the panel context/error boundary.
4. **First panels.** Add `onebot-napcat/src/ui.tsx` (connection status, metrics, reconnect
   action) and `openai-compatible/src/ui.tsx` (connection settings, model discovery, multi-model
   enablement, capability metadata, and reasoning defaults).
5. **Plugin i18n.** Add `@tsukaima/sdk/i18n`, the Paraglide binding, per-plugin inlang projects,
   and localized panel chrome for both built-ins.
6. **Third-party declarative UI.** Extend the manifest UI schema with layout primitives
   (`status`, `stats`, `table`, `form`, `actions`) rendered by the host. Keep the iframe tier
   separate.

Each phase is independently shippable. Phases 1–2 do not require the SDK UI kit, and phase 3
does not require plugin i18n.

## 12. Resolved decisions

1. **Third-party React.** Custom panels are supported for workspace-built plugins, with a
   confirmation modal for `kind: "third-party"`. Runtime-installed panels remain out of scope
   until an iframe sandbox and postMessage bridge exist.
2. **UI kit source.** The existing beUI components were extracted into `packages/ui`
   (`@tsukaima/ui`); `@tsukaima/sdk/ui` composes that kit for plugin panels.
3. **i18n authoring.** Hybrid: `bindParaglide` for compiled plugin projects (both built-ins use
   it) and `createDictionaryI18n` for plugins without a build step.
4. **Enable/disable.** `admin.plugins.setEnabled` persists the choice in the domain `meta` table
   and starts or stops the plugin immediately. The detail page exposes it as a toggle.
5. **Status durability.** Status stays in memory and is cleared on teardown; durable facts belong
   in plugin storage.

## 13. Declarative component registry (Phase 3)

The fallback tier now has a named host registry in `packages/sdk/src/ui/registry.tsx`:
`approval-card`, `memory-review`, `sticker-grid`, `task-list`, `task-graph`, `diagnostic-card`,
and `settings-form`, plus a generic `fallback` card. Manifest `ui` entries may declare `version`,
`slot`, `requiredPermissions`, `i18nKeys`, and a data `schema`. Rendering checks the host UI
version, slot, and the plugin's granted permissions; unknown names and incompatible versions render
the generic card instead of blanking the page. Trusted `src/ui.tsx` panels remain the build-time
React tier and are unaffected.

## 14. Implemented surface

- `admin.plugins.list` rows: `status`, `permissions`, `tools`, `rpcMethods`.
- `admin.plugins.setEnabled`, and `admin.plugins.rpc` with an optional `pluginId` namespace check.
- `plugin.status` live events, including a per-plugin snapshot on connect.
- `context.ui.setStatus` with schema validation, 8 KiB payload cap, and 32-key `metrics`/`details`
  caps.
- `/plugins` and `/plugins/$pluginId` with a plugin list, search, status dots, detail header,
  status card, config form, manifest facts, panel tabs, and error boundaries.
- `@tsukaima/sdk/ui` and `@tsukaima/sdk/i18n`, plus panels for `onebot-napcat` and
  `openai-compatible`.
