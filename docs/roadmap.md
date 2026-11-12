# Roadmap

## Phase 0 — Design lock

- [x] Capture requirements and decisions.
- [x] Define runtime, domain model, plugin, migration, and self-iteration architecture.
- [ ] Review documents and adjust open points.

## Phase 1 — Core skeleton

1. Scaffold Bun monorepo and CI.
2. Implement startup lifecycle with database migration and readiness gates.
3. Implement `BunSqliteStorage` adapter and storage conformance tests.
4. Create `pi-durable` host service with fake model.
5. Define `MessageEnvelope`, `MessagePart`, conversation policy, and activity aggregation.
6. Implement admin HTTP/WebSocket skeleton.

## Phase 2 — Channels and chat

1. Implement OneBot v11 outbound WebSocket channel.
2. Normalize NapCat events into envelopes.
3. Implement user/conversation resolution and group/private routing.
4. Implement reply/mention/media handling and outbound send actions.
5. Add durable steering/follow-up behavior.

## Phase 3 — Persona, memory, models

1. Implement model registry and Magpie provider.
2. Implement capability policies and usage accounting.
3. Import/seed persona records.
4. Implement scoped memory storage, retrieval, and extraction.
5. Add memory admin/review UI.

## Phase 4 — Plugins and WebUI

1. Implement plugin manifest, registry, permission checks, and worker runtime.
2. Implement plugin tool/hook/UI bridges.
3. Build IM-style WebUI conversation surface.
4. Add admin panels for plugins, personas, memory, policies, and audit.
5. Implement sticker/meme and search plugins.

## Phase 5 — Self-iteration

1. Implement coding runner and worktree policy.
2. Add test/build/diff tools and approval gates.
3. Implement deployment proposal records.
4. Add reload/restart and rollback workflow.
5. Add audit and task graph visualization.

## Phase 6 — Migration and cutover

1. Implement Migration Kit snapshot/inspect/normalize.
2. Add LLM compression through Magpie.
3. Add dry-run, import, verify, rollback.
4. Import selected DSH sessions, personas, memory, stickers, and settings.
5. Cut NapCat connection from DSH to Elaina.

## Phase 7 — Stabilization

- Failure drills: restart during model/tool/channel activity.
- Rate-limit and abuse tests.
- Secret scanning.
- Backup/restore drills.
- Operational runbook.
