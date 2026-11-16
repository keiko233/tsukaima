# DSH baseline audit record

This is the secret-free, reproducible record for the DSH deployment compared against the Tsukaima
parity work. It is derived from the read-only audit in
[the DSH baseline spec](../specs/dsh-baseline.md). The committed fixture at
`packages/migration/fixtures/dsh-baseline/` reproduces the observed schema shapes with synthetic
IDs, paths, chat text, and credentials only.

> The migration target (host, project directory, and container) is always supplied at runtime
> through CLI flags or `DSH_AUDIT_HOST` / `DSH_AUDIT_PROJECT` / `DSH_AUDIT_CONTAINER`. No
> deployment address or container name is baked into the CLI or fixtures.

## Reproduce

```sh
# Local, fully synthetic fixture
bun tools/migration/src/cli.ts baseline \
  --source packages/migration/fixtures/dsh-baseline

# Read-only remote audit (host/project/container are supplied by the operator)
DSH_AUDIT_HOST="<ssh-target>" \
DSH_AUDIT_PROJECT="<project-dir>" \
DSH_AUDIT_CONTAINER="<container>" \
bun tools/migration/src/cli.ts baseline

# Equivalent explicit flags
bun tools/migration/src/cli.ts baseline \
  --host "<ssh-target>" --project "<project-dir>" --container "<container>"
```

The remote path runs a read-only Node inspector inside the DSH container, writes only sanitized
structural files to the remote temporary directory, and then transfers that directory. Credential
and identifying scalars are redacted on the remote host, while ledger and session records are
reduced to field names, counts, and schema shapes. Raw secrets, chat text, QQ identifiers, and
binary meme files never leave the host.

The fixture also exercises redaction with fixture-only synthetic placeholders. Those placeholders
are config inputs only and never appear in serialized baseline output.

## 1. Image and CLI versions

| Item | Baseline |
| --- | --- |
| Image | Recorded by the operator's private audit; fixture uses `registry.example.test/dsh:0.0.0-synthetic` |
| CLI | Recorded by the operator's private audit; fixture uses `0.0.0-synthetic` |

## 2. Profile and bundle packages

Profile: `dsh-profile-web`.

| Package | Observed spec / version |
| --- | --- |
| `@hytime/dsh-thinking-effort` | `0.3.11` |
| `dsh-free-search` | `0.9.16` |
| `dsh-meme` | `0.1.63` |
| `dsh-mnemon` | `0.5.36` |
| `dsh-napcat` | `0.4.4`, local link `link:/workspace/work/dsh-napcat` |
| `dsh-purge` | profile dependency |
| `dshmarket` | `^1.70.2` |

The inventory records the dependency spec and, when a local installed package manifest is present,
the resolved package version.

## 3. Effective plugins and state

Enabled: `ui-settings-general`, `locale`, `llm-pi-ai`, `agent-default-model`,
`agent-preset-registry` (including `preset-dsh-napcat-qq-chat` and `preset-cordis`),
`mcp-snowluma-host`, `mcp-web-search-safe`, `qq-mode` (`qq-mode-console`), `web`, `dsh-napcat`,
`ui-theme`, `sandbox-policy`, `approval`, `permission`, `dsh-purge`.

Disabled: `mcp-snowluma`.

The inventory emits plugin IDs, package names, enabled/disabled state, and preset IDs. It does not
emit plugin secrets.

## 4. Configuration fields and value classes

Every observed DSH/NapCat configuration field is mapped to one value class:

| Class | Meaning | Baseline handling |
| --- | --- | --- |
| `safe` | Non-sensitive operational value | Value may be shown. |
| `secret` | Token, key, credential, authorization, cookie | Show only `configured` / `unconfigured`; never the value. |
| `identifying` | QQ ID, group ID, user list, persona-override key | Show only the field name and configured state. |
| `policy` | Access, rate, gating, threshold, keyword policy | Show only the field name and configured state. |
| `host-specific` | URL, host, port, local path, DSH workspace internals | Show only the field name and configured state. |

Observed secret fields include `accessToken`, `apiKeyEnv`, `layaGateApiKey`, and `imageEditToken`.
Unknown credential-like fields such as `customWebhookSecret`, `thirdPartyApiToken`, and
`xAuthCredential` are also classified as `secret`. `triggerKeywords`, `keywords`, `publicKey`, and
`keyboard` are not credential fields and are not misclassified as secrets.

The fixture contains synthetic values for each class, including configured and unconfigured
unknown credential fields, so tests prove that raw values never reach serialized output.

## 5. NapCat tools contributed to the model

The baseline contains 26 tools:

`napcat_send_message`, `napcat_list_targets`, `napcat_view_image`, `napcat_api`,
`napcat_dump_messages`, `napcat_send_image`, `napcat_send_file`, `napcat_lookup`,
`napcat_video_peek`, `napcat_image_edit`, `napcat_schedule`, `napcat_schedule_list`,
`napcat_schedule_cancel`, `napcat_poke`, `napcat_react`, `napcat_send_forward`,
`napcat_forward_msg`, `napcat_ocr`, `napcat_translate`, `napcat_admin`,
`napcat_list_group_files`, `napcat_fetch_group_file`, `napcat_shared_memory`,
`napcat_inject_prompt`, `napcat_relay`, `napcat_memory_space`.

## 6. Memory provider, strategy, and spaces

| Item | Baseline |
| --- | --- |
| Provider | `dsh-mnemon` |
| Strategies | `dsh-mnemon` SQLite insights; `dsh-napcat` shared/cross-session markdown and JSONL |
| Shared files | `shared-memory.md`, `cross-recent.jsonl` |
| Database pattern | `.mnemon/data/<space>/mnemon.db` (live: `/workspace/.mnemon/data/<space>/mnemon.db`) |
| Space patterns | `dsh-host`, `napcat-group-<id>`, `napcat-private-<id>`, `workspace-<uuid>` |
| Documents | `.mnemon/documents/{active,archived,index.json}` |
| Runtime | `.mnemon/runtime/{MEMORY.md,USER.md,memories.json}` |

Space names are sanitized to patterns so real QQ or workspace identifiers do not enter the report.

`mnemon.db` schema names:

- `insights(id, content, category, importance, tags, entities, source, access_count, stored_at,
  created_at, updated_at, deleted_at, last_accessed_at, embedding, effective_importance)`
- `edges(source_id, target_id, edge_type, weight, metadata, created_at)`
- `oplog(id, operation, insight_id, detail, created_at)`

## 7. Meme packs

The committed fixture uses generic pack IDs `synthetic-pack-01` through `synthetic-pack-05`.
Production pack IDs, titles, and media are not repository data. The live layout is
`/workspace/.dsh/meme-packs/<pack>/`; the fixture also keeps the older
`/workspace/meme-packs/<pack>/` layout so both paths are covered.

Each pack has `manifest.json` fields `id`, `name`, `version`, `description`, `maintainer`,
`license`, `tags`, `source`, and an SQLite `index.db` table
`memes(path, tag, file_name, caption, keywords, mtime, captioned_at)`.

The committed fixture represents 5 packs and 32 synthetic rows. It contains no meme images or real
captions.

## 8. Schedule storage

| Source | File shape |
| --- | --- |
| DSH host | `.dsh/storages/schedule.json` with `unit`, `global`, `tables` |
| NapCat | `napcat/schedule.json` with `ScheduledTask` records |

Status classes: `pending`, `done`, `cancelled`.

Timing/task fields: `createdAt`, `dueAt`, `repeatEveryMs`, `flexMs`, `firedAt`, `closedAt`,
`attempts`, `maxAttempts`, `fireCount`, `cancelIfReplied`, `kind`.

The fixture contains all three status classes and both schedule sources.

## 9. Session inventory and v4 JSONL schema

The live audit samples a bounded subset of files under
`sessions/<workspace>/<session>/session.v4.jsonl.zstd`; exact counts stay in the private audit.
The fixture contains two synthetic sessions,
one uncompressed JSONL file and one zstd-compressed file. Remote audits emit
`audit/sessions.json` with total/compressed file counts, workspace count, and the union of record
keys and event types from a bounded read-only sample; the extractor also scans session files when
that summary is absent.

Session header fields: `type`, `version`, `id`, `createdAt`, `cwd`, `parentSession`, `isSeeded`,
`origin`, `delegationDepth`, `agentPreset`.

Sequenced event top-level fields: `type`, `seq`, `time`, `data`, optional `surfaceOp`, optional
`sourceEventSeqs`.

Observed event types:

`subagent/descriptor`, `sandbox/mode`, `approval/policy`, `working-directory/change`,
`agent/inbox/spliced`, `turn/start`, `step/start`, `system/message`, `user/message`,
`request/header`, `request/context`, `session/title`, `assistant/message`, `tool/call`,
`tool/result`, `step/end`.

The report emits field names and counts only; session IDs, workspace IDs, and message content stay
out of the baseline artifact.

## 10. Request ledger and human-profile state

| File | Fields |
| --- | --- |
| `friend-requests.jsonl` | `kind`, `flag`, `userId`, `groupId`, `comment`, `subType`, `at`, `seenAt` |
| `human-profiles.json` | `version`, `savedAt`, `profiles`; profile fields include `chatKey`, `createdAt`, `updatedAt`, `interactions`, `otherFirst`, `selfFirst`, `replyDelayAvgMs`, `proactiveSent`, `proactiveAnswered`, `unansweredStreak`, `refusedCount`, `refusedAt`, `unansweredAt`, `silentUntil`, `level`, `activeHours`, `lastActiveHour`, `openers`, `warm`, `dayKey`, `proactiveToday`, `lastIgnoredReason` |
| `qa-ledger.jsonl` | `at`, `chatKey`, `asker`, `question`, `canonical`, `klass`, `answer` |
| `admin-audit.jsonl` | `at`, `action`, `chatKey`, `sessionKey`, `dryRun`, `decision`, `params`, `reason`, `origin`, `sessionId`, `userId` |

The inventory emits field names and record counts only. Chat keys, questions, answers, and audit
parameters are never copied into the report.

## Safety rules

- The audit is read-only: no writes, restarts, or service changes.
- Secrets are classified by key and represented only as `configured` / `unconfigured`.
- Real QQ IDs, group IDs, chat content, session content, and message logs are excluded.
- The committed fixture uses synthetic identifiers and fixture-only text.
