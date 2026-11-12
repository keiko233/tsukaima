# Decision log

## 2026-11-12

| Question | Decision |
| --- | --- |
| Runtime | Bun |
| Migration scope | Current DSH only; AstrBot is not migrated |
| Downtime | Allowed |
| Deployment | Option C: agent produces artifacts/proposals; administrator applies. Local development first, GHCR later. |
| WebUI authorization | Single administrator |
| OneBot mode | Tsukaima actively connects to NapCat WebSocket (forward WS) |
| Project name | `tsukaima-chatbot` |
| Migration scripts | Private scripts/docs allowed; LLM-assisted compression is allowed through Magpie |

## 2026-11-13

| Question | Decision |
| --- | --- |
| WebUI authentication | Better Auth 1.7 with SQLite-backed users and sessions; native auth routes and single-admin bootstrap |
| Auth audit actor | `AuditEntry` accepts optional `actorId`/`actorKind`; Better Auth hooks and admin RPC write the real actor |
