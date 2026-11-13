# Tsukaima implementation specs

These specs translate the 2026-11-13 DSH feature audit into concrete, testable work. They are
implementation specifications, not aspirational architecture. Each spec states the current
boundary, required behavior, contract changes, migration concerns, and acceptance criteria.

## How to use these specs

1. Keep one feature spec as the source of truth for its phase.
2. Do not start a dependent phase before its host contract exists.
3. Every spec must retain explicit acceptance criteria and tests.
4. When reality changes a decision, update the spec and, when architectural, add an ADR.
5. Cross-cutting status remains in `docs/project-state.md`; don't duplicate progress here.

## Priority order

| Phase | Spec | Why first |
| --- | --- | --- |
| 0 | [DSH baseline and audit](dsh-baseline.md) | Locks the compared deployment and feature inventory. |
| 1 | [NapCat operational parity](napcat-operations.md) | Makes cutover safe for real QQ traffic. |
| 2 | [Conversation policy and humanlike pacing](conversation-policy.md) | Restores group behavior without hard-coded DSH logic. |
| 3 | [Plugin host maturity](plugin-host.md) | Delivers migrations, task surfaces, tool policy, UI slots, and outbound hooks before feature plugins. |
| 4 | [Memory and context](memory-context.md) | Preserves DSH persona/group continuity and enables review. |
| 5 | [Sticker and meme](sticker-meme.md) | Restores learned expression behavior. |
| 6 | [Search and fetch](search-fetch.md) | Adds factual grounding and third-party tools. |
| 7 | [Proactive and scheduled messages](proactive-scheduler.md) | Restores nudges, reminders, and supervised proactive turns. |
| 8 | [Self-iteration runtime](self-iteration-runtime.md) | Connects the existing coding library to chat/admin surfaces. |
| 9 | [Migration compatibility](migration-compatibility.md) | Required before importing the actual DSH deployment. |

## Global contracts and conventions

- **Tool namespacing**: Plugin tools are registered under `<pluginId>.<action>` (matching `LocalToolBridge`), and mapped to provider-compatible names via `providerSafeToolName()`.
- **Shared conversation serialization**: Inbound activity runs, steering/follow-ups, outbound pacing, and background proactive turns on the same conversation must acquire the same per-conversation execution lock.
- **Policy ownership**: Channel plugins own transport and platform actions only; access gating (`open`/`allowlist`/`disabled`), aliases, peer bots, and reply pacing live in the core conversation policy engine.

## Global rules

- External QQ content is transient evidence, not a source of truth for implementation details.
- Secrets never enter Git, logs, prompts, reports, or exported migration bundles.
- Destructive QQ actions and filesystem actions require explicit policy and audit.
- Plugin-owned features must use the SDK surfaces rather than direct server imports.
- SQLite remains the durable store unless an ADR explicitly changes it.
- Each phase ends with `bun run check` plus the module's specified integration checks.

## Release readiness (post-Phase 9)

Before production cutover, close the remaining cross-cutting operational items tracked in `docs/project-state.md`:

- Clean up legacy schema/contract drift (`messages.activity_id`, duplicated RPC input schemas).
- Add Playwright WebUI end-to-end coverage across messaging, policies, approvals, and plugin panels.
- Add CI secret scanning, scheduled SQLite + blob backup/restore drills, and the production runbook.
