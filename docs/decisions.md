# Decision log

## 2026-11-12

| Question | Decision |
| --- | --- |
| Runtime | Bun |
| Migration scope | Current DSH only; AstrBot is not migrated |
| Downtime | Allowed |
| Deployment | Agent produces artifacts/proposals; administrator applies them to a deployment branch and builds the image on the host. |
| WebUI authorization | Single administrator |
| OneBot mode | Tsukaima actively connects to NapCat WebSocket (forward WS) |
| Project name | `tsukaima` |
| Migration scripts | Private scripts/docs allowed; LLM-assisted compression is allowed through Magpie |

## 2026-11-13

| Question | Decision |
| --- | --- |
| WebUI authentication | Better Auth 1.7 with SQLite-backed users and sessions; native auth routes and single-admin bootstrap |
| Auth audit actor | `AuditEntry` accepts optional `actorId`/`actorKind`; Better Auth hooks and admin RPC write the real actor |

## 2026-11-13 (plugin UI)

| Question | Decision |
| --- | --- |
| Plugin custom UI | Built-in and first-party plugins ship trusted build-time React panels; third-party panels are allowed but gated behind an explicit confirmation modal |
| Shared UI kit | Extract the beUI component set into `packages/ui` (`@tsukaima/ui`); `@tsukaima/sdk/ui` composes it for plugin panels |
| Plugin i18n | Hybrid: `bindParaglide` for compiled plugin inlang projects, `createDictionaryI18n` as a no-build fallback |
| Plugin enable/disable | Persisted in the domain `meta` table, applied immediately through `admin.plugins.setEnabled` |

## 2026-11-16

| Question | Decision |
| --- | --- |
| Chat vs. repository execution | Separate `chat` and `workspace` session surfaces; chat can spawn/control workspaces but never receives coding tools |
| Workspace repository scope | Coding task plus the running process repository root; mutations remain inside governed worktrees |
| Session communication | One shared service for `queue` (next loop step), `interrupt`, and `follow-up` across chat and workspace |
| Durable context injection | `prompt_hooks` supports one-shot context, recurring runtime notices, and post-restart reserved turns |
| Restart/update | One-minute graceful maintenance window injected into every chat prompt; process exits 75 with a restart-intent file for the host supervisor |
