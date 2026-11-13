# Decision log

## 2026-11-12

| Question | Decision |
| --- | --- |
| Runtime | Bun |
| Migration scope | Current DSH only; AstrBot is not migrated |
| Downtime | Allowed |
| Deployment | Option C: agent produces artifacts/proposals; administrator applies. Local development first, GHCR later. |
| WebUI authorization | Single administrator |
| OneBot mode | Elaina actively connects to NapCat WebSocket (forward WS) |
| Project name | `elaina-chatbot` |
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
| Shared UI kit | Extract the beUI component set into `packages/ui` (`@elaina/ui`); `@elaina/sdk/ui` composes it for plugin panels |
| Plugin i18n | Hybrid: `bindParaglide` for compiled plugin inlang projects, `createDictionaryI18n` as a no-build fallback |
| Plugin enable/disable | Persisted in the domain `meta` table, applied immediately through `admin.plugins.setEnabled` |
