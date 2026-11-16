# DSH migration

Only the current DSH instance is migrated. AstrBot is explicitly out of scope.

## Baseline

The compared deployment, value classes, and audit acceptance criteria are defined in
[the DSH baseline spec](../specs/dsh-baseline.md). The secret-free audit record and reproduction
commands are in [the DSH baseline audit record](dsh-baseline.md). The local synthetic fixture lives
under `packages/migration/fixtures/dsh-baseline/`.

Baseline inventory commands:

```sh
bun tools/migration/src/cli.ts baseline --source packages/migration/fixtures/dsh-baseline
DSH_AUDIT_HOST="<ssh-target>" DSH_AUDIT_PROJECT="<project-dir>" DSH_AUDIT_CONTAINER="<container>" \
  bun tools/migration/src/cli.ts baseline
```

Host, project, and container values come from flags or `DSH_AUDIT_*` environment variables; they are
not runtime defaults or fixture data.

## Current DSH deployment facts

- Project: `/opt/deepseek-harness-docker` on `10.0.0.6`.
- DSH version in use: `0.2.1-rc.3-r1` image, CLI reports `0.2.1-rc.3`.
- Persistent volumes:
  - `deepseek-harness-docker_dsh-home`
  - `deepseek-harness-docker_dsh-workspace`
  - `deepseek-harness-docker_dsh-lan-caddy-data`
  - `deepseek-harness-docker_dsh-lan-caddy-config`
- `dsh-home` holds profiles, plugin manifests, sessions, agent presets, and market state.
- `dsh-workspace` holds workspaces, meme packs, NapCat plugin local source, and plugin settings.
- NapCat uses forward WebSocket on `ws://napcat:3001`; token exists only on the host.
- Known installed profile bundles include DSH base/web, plugin market, free search, Mnemon, meme, agent team profile, thinking effort, NapCat, and purge.

## Migration sources

Collect read-only snapshots:

1. DSH profile package manifests and composed patch/config files.
2. Plugin list, versions, installed source references, and settings.
3. Persona, agent presets, memory stores, and workspace-local settings.
4. Session JSONL tree and metadata.
5. Workspace files and meme packs.
6. NapCat bridge configuration without secrets.
7. Logs only as needed for diagnostics; do not import full logs into the new product.

Secrets are never copied into the new repository or migration report.

## Feature mapping

| DSH capability | Tsukaima design |
| --- | --- |
| NapCat bridge | `onebot-napcat` plugin, outbound WS |
| Per-group/private sessions | Stable durable conversations |
| Persona/agent presets | Versioned persona records + per-conversation bindings |
| Mnemon-like cross-session memory | Native scoped memory service |
| Meme packs / learned stickers | Native sticker service and plugin |
| Free search | Search provider plugin with configurable engine chain |
| Thinking effort | Model policy per capability/conversation |
| Plugin market | Local/admin-managed plugin registry first; marketplace later |
| Web UI + plugin settings UI | IM-style admin WebUI and plugin panel bridge |
| Session purge/deletion | Admin purge tool with backups and audit |
| Subagent / workflow tools | Durable child tasks and coding runner |
| MCP tools | MCP integration behind tool policy |
| Scheduled/proactive actions | Durable tasks and scheduler |

No DSH plugin is blindly copied. A feature is either implemented natively or reimplemented as an Tsukaima plugin after API review.

## Migration Kit

Create `tools/migration` as a Bun CLI. It is not part of the core runtime.

Pipeline:

1. `snapshot`
   - Copy DSH volume trees into a migration workspace.
   - Record file inventory, hashes, sizes, and permissions.
   - Redact detected token/secret fields in manifests.
2. `inspect`
   - Parse profiles, plugin manifests, sessions, memory stores, workspaces, and meme packs.
   - Emit a human-readable inventory and mapping suggestions.
3. `normalize`
   - Convert DSH sessions to canonical import JSONL.
   - Convert workspace attachments to content-addressed media.
   - Normalize persona, memory, sticker, search, and plugin settings.
4. `compress`
   - Summarize oversized conversations with an approved LLM API through Magpie.
   - Generate import summaries, persona consolidation notes, and memory candidates.
   - Keep original messages; summaries are additional import records.
5. `dry-run`
   - Validate schemas, ID maps, media hashes, and conversation keys.
   - Show counts, conflicts, secrets found, skipped records, and estimated storage.
6. `import`
   - Create canonical users, conversations, personas, memory, media, and history.
   - Import raw history first, then derived summaries/memory candidates.
   - Use transactional/idempotent batches.
7. `verify`
   - Check counts and source hashes.
   - Validate fake model and fake OneBot flows.
   - Compare selected conversations in read-only UI.
8. `rollback`
   - Restore from pre-import snapshot; remove partial import ledger entries.

Canonical import record includes:

```json
{
  "sourceSystem": "dsh",
  "sourceId": "...",
  "sourceHash": "sha256:...",
  "kind": "conversation|entry|user|persona|memory|media|setting",
  "canonicalId": "...",
  "status": "imported|skipped|merged|failed",
  "reason": "...",
  "llmDerivation": { "model": "...", "promptVersion": "..." }
}
```

## DSH session handling

DSH session files are JSONL-based conversation histories. Migration must preserve:

- chronological order
- user/assistant/tool distinction where present
- attachments references
- timestamps
- workspace/session grouping
- branches/compactions if represented

Conversation mapping:

- `napcat-private-*` maps to canonical private conversation.
- `napcat-group-*` maps to canonical group conversation.
- `work` and generic DSH sessions map to admin/task conversations, not public bot chats.
- Test sessions are imported as archived/test conversations unless explicitly excluded.

Sessions may exceed model context. Compression creates:

- full immutable import record
- optional segment summaries
- one conversation-level summary
- extracted memory candidates

LLM compression is allowed and runs through Magpie. Prompts must avoid printing secrets and must be versioned. Results include model, prompt version, source range, and confidence.

## Plugin/config migration

Settings are translated, not copied:

| DSH setting | Target |
| --- | --- |
| NapCat URL/token | New secret + channel config; token never enters Git |
| Access policy | Conversation policy |
| Model/provider | Model policy |
| Memory config | Memory plugin config |
| Meme config | Sticker plugin config |
| Search engines | Search plugin config |
| Thinking effort | Model policy |
| Plugin enable/disable | Plugin registry state |

The migration report lists settings with no direct equivalent for manual decision.

## Rehearsal status

The kit has been run against a real read-only capture of the current deployment (13,222 files,
989 MB, 0 capture errors). The isolated lab import mapped 648 conversations, 51,398 messages,
1,254 source memories, 287 attachments, 2 personas, 138 settings, and 6 sticker packs; every
`verify` check passed and a second import was idempotent. The live cutover has not run yet.

Live-shape handling now includes:

- captured snapshot wrappers are unwrapped to `files/` before parsing, so inventory JSONL is never
  treated as session data;
- remote volume archives are extracted one volume at a time;
- zstd session bytes are decompressed before NDJSON parsing;
- array-shaped `cordis.patch.yml` preset files are mapped, including the QQ persona preset;
- session header epoch timestamps and content-block image attachments are preserved;
- NapCat session suffixes (including `interject` and `archive` sessions) are normalized so one
  group/private chat maps to one chat object;
- QQ history is merged from OneBot `hist-*.json`, every `recent.jsonl` window (current, backup,
  pending-rebuild, and pre-restore), `cross-recent.jsonl`, archived pending rows, the bridge's
  `【最近群聊】` prompt context, and successful `napcat_send_*` tool calls;
- bot aliases, nick/user-id suffixes, cached images, duplicate context windows, and multiline
  assistant output are deduplicated; successful control-session sends are kept while internal
  assistant reports from non-chat sessions are excluded;
- archived session copies outside the canonical session store are ignored;
- `workspace/memory/<space>` items and summaries are imported without collapsing space IDs; and
- large imports are inserted in bounded statements; and
- on first start, imported non-numeric Pi durable markers are replaced with fresh durable
  conversations, so old domain history can receive new QQ/WebUI turns without failing startup.

## Cutover

1. Complete snapshot/inspect/normalize/dry-run.
2. Build Tsukaima image locally.
3. Run Tsukaima with fake OneBot and fake model.
4. Verify imported conversations in WebUI.
5. Stop DSH service.
6. Run final import.
7. Configure NapCat account WebSocket server and Tsukaima outbound connection.
8. Start Tsukaima; verify NapCat connection and read-only recent history.
9. Keep DSH data and backup untouched for rollback.
10. After admin validation, archive or stop the old project without deleting data.

Do not send real QQ messages during automated validation. Manual smoke tests happen only after the admin explicitly chooses a target conversation and message.
