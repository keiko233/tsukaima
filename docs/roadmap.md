# Roadmap

## Phase 0 — Design lock

- [x] Capture requirements and decisions.
- [x] Define runtime, domain model, plugin, migration, and self-iteration architecture.
- [ ] Review documents and adjust open points.

## Phase 1 — Core skeleton

- [x] 1. Scaffold Bun monorepo and CI.
- [x] 2. Implement startup lifecycle with database migration and readiness gates.
- [x] 3. Implement `BunSqliteStorage` adapter and storage conformance tests.
- [x] 4. Create `pi-durable` host service with fake model.
- [x] 5. Define `MessageEnvelope`, `MessagePart`, conversation policy, and activity aggregation.
- [x] 6. Implement admin HTTP skeleton.
- [x] 7. Add authenticated admin live updates over SSE.

## Phase 2 — Channels and chat

- [x] 1. Implement OneBot v11 outbound WebSocket channel.
- [x] 2. Normalize NapCat events into envelopes.
- [x] 3. Implement user/conversation resolution and group/private routing.
- [ ] 4. Complete reply/mention/media policy handling.
- [x] 5. Add durable steering/follow-up behavior.

## Phase 3 — Persona, memory, models

- [x] 1. Implement model registry and OpenAI-compatible/Magpie provider.
- [x] 2. Implement capability policies and usage accounting.
- [x] 3. Import/seed persona records through the migration pipeline.
- [x] 4. Implement scoped memory storage and retrieval, injected as prompt sections.
- [ ] 5. Add memory extraction jobs and the memory admin/review UI.

## Phase 4 — Plugins and WebUI

- [x] 1. Implement plugin manifest, registry, permission checks, and worker runtime.
- [x] 2. Implement plugin tool/hook bridges and expose plugin tools to the model.
- [x] 2b. Consume the plugin UI registry in the WebUI (generic config forms and plugin metadata).
- [x] 3. Implement the plugin host seam and extract the OneBot channel into `plugins/onebot-napcat`.
- [x] 3b. Extract the model provider into `plugins/openai-compatible` with a host provider registry.
- [x] 4. Build IM-style WebUI conversation surface.
- [ ] 5. Add admin panels for personas, memory, and audit.
- [ ] 6. Implement sticker/meme and search plugins.

## Phase 5 — Self-iteration

- [x] 1. Implement coding runner and worktree policy.
- [x] 2. Add test/build/diff tools and approval gates.
- [x] 3. Implement deployment proposal records.
- [ ] 4. Add reload/restart and rollback workflow.
- [ ] 5. Add audit and task graph visualization.

## Phase 6 — Migration and cutover

- [x] 1. Implement Migration Kit snapshot/inspect/normalize.
- [x] 2. Add LLM compression hook through the configured model.
- [x] 3. Add dry-run, import, verify, rollback.
- [ ] 4. Import selected DSH sessions, personas, memory, stickers, and settings.
- [ ] 5. Cut NapCat connection from DSH to Elaina.

## Phase 7 — Stabilization

- [x] Failure drills: restart during model/tool/channel activity.
- [x] Rate-limit and abuse tests.
- [ ] Secret scanning.
- [ ] Backup/restore drills.
- [ ] Operational runbook.
