# Workspace and prompt hooks

## Purpose

Tsukaima separates conversation from repository execution:

- **Chat** is the user-facing reasoning and coordination surface.
- **Workspace** is a governed repository agent with a coding task and self-iteration tools.
- **Prompt hooks** inject durable operational context before a turn or reserve work for after a
  restart.

The surfaces share durable conversations and delivery semantics, but not tools or permissions.

## Session shape

A workspace is a normal chat object and durable conversation with `kind = "workspace"` plus one
`workspace_sessions` row:

| Field | Meaning |
| --- | --- |
| `id` | Workspace conversation/session id |
| `chat_object_id` | Workspace chat object |
| `task_id` | `coding_tasks.id`, null until the first user message starts the task |
| `parent_session_id` | Chat session that spawned it, when applicable |
| `repository_root` | The running process repository, normally `process.cwd()` |
| `base_ref` | Git revision supplied to the task |
| `mode` | `analysis`, `patch`, `proposal`, or `maintenance` |
| `goal` | Task brief, null for a draft and set from the first user message |
| `tags` | Structured labels; the task mode is always included |

Creating a workspace is a two-phase operation. The New action immediately creates an empty draft
with a durable conversation, `coding` capability, and no model turn. The first user message
starts the coding task, derives the title from that message, records the mode and user tags, and
injects the workspace handoff prompt into the same turn. Later messages reuse the task. It never
edits the live repository; writes remain inside the governed worktree.

## Tool surfaces

The lifecycle installs a host-owned session-tools extension in addition to plugin tools. Tool
visibility is synchronized per conversation before a turn:

| Session | Repository tools | Workspace controls | Hooks |
| --- | --- | --- | --- |
| WebUI chat | No | Yes | Yes |
| Workspace | Yes, with `coding` capability | Status/send only | Yes |
| IM private/group | No | No | No |
| Task/plugin | No | No | No |

Workspace-control tools:

- `workspace_spawn({ goal, mode?, baseRef? })`
- `workspace_status({ sessionId?, taskId? })`
- `workspace_send({ sessionId, text, mode })`
- `session_lookup({ query, limit? })`
- `hook_schedule({ prompt, timing, sessionId?, deliverAt? })`
- `hook_list({ includeFinished? })`

The chat model is instructed to spawn a workspace for a concrete bug, feature, optimization, or
self-discovered improvement. It does not claim the code is changed until the workspace reports a
proposal or completion.

Workspace-only coding-agent tools:

- `session_context({ sessionId, messageId? })` reads bounded context from a conversation the user
  explicitly referenced in this turn.
- `todo_write({ items })` replaces the workspace checklist; at most one item may be in progress.
- `todo_list()` returns the current checklist.
- `db_schema({ table? })` lists allowlisted tables and columns.
- `db_query({ sql, params? })` runs one read-only `SELECT`/`WITH` query against an allowlisted
  table set, capped at 200 rows and 64 KiB.

The coding-agent extension is installed process-wide but filtered out for chat, IM, task, and
plugin sessions in `applySessionToolPolicy`.

## Lazy tool loading

Chat and coding share one discovery path. Every conversation gets the host `tool_search` tool;
tools marked lazy are omitted from the request until the model searches for them and the host
loads the match into that conversation's `modelTools`. Plugin tools are lazy by default, and
`lazy: false` opts a frequently used tool back into the upfront request. Each tool declares a
`surface` of `chat`, `coding`, or `both`; the lifecycle removes mismatched tools before the turn,
which also keeps them out of `tool_search` candidates. The context inspector reports loaded and
deferred tools separately, and removal from `tools` is what makes a filtered tool undiscoverable.

## Upstream upgrades

Settings → Upgrades compares the running checkout with `TSUKAIMA_UPGRADE_REMOTE`
(`origin` by default) and the branch currently checked out. The comparison fetches the remote
first and counts commits on both sides.

| Checkout state | Upgrade path |
| --- | --- |
| Clean, no local commits | Merge `origin/<branch>` with `--ff-only`, then schedule the update restart |
| Local commits | Create a `proposal` workspace; the agent merges with `self-iteration.upstream` and proposes the result |
| Uncommitted changes | No automatic merge; commit or discard them first |

Finalizing an upgrade re-checks that the upstream target commit is an ancestor of `HEAD`, then
schedules the existing one-minute update window. The workspace's own branch is merged with
`--no-ff`; uncommitted workspace changes are committed first. The host supervisor still owns
the image/container switch.

## Shared delivery

`SessionMessagingService` is the local ingress for chat messages, workspace commands, and reserved
hook turns:

```text
UI / chat tool / resume hook
          |
          v
SessionMessagingService
  - validate session and chat
  - interrupt the active run when requested
  - apply model-tool visibility
  - render prompt hooks
  - persist domain message
  - host.append(forceSubmit, whenBusy)
          |
          v
pi-durable conversation
```

Delivery modes:

| Mode | Behavior |
| --- | --- |
| `queue` | Submit with `whenBusy: steer`; inserted after the current loop step/tool boundary |
| `interrupt` | Abort the current generation, then submit as a follow-up |
| `follow-up` | Submit after the current turn settles |

Channel ingestion still uses its existing sidechat classifier; the explicit modes are for admin
and workspace control. Both paths persist the same activity and assistant-answer records.

## Prompt hooks

`prompt_hooks` is a durable registry evaluated before every agent turn.

| Kind | Lifecycle | Use |
| --- | --- | --- |
| `context` | Consumed once; optional target session | Cross-session reminder or discovered context |
| `runtime` | Rendered every turn until expiry | Restart/update countdown |
| `resume` | Scheduled until a due time or next process boot, then submits a turn | "I will come back and finish this" |

Properties:

- A null `target_session_id` on a context/runtime hook applies globally.
- Context hooks are atomically marked fired before injection, so a replayed prompt does not
  inject them twice.
- Deduplication is supported through `dedupe_key`.
- Injection failures are logged and skipped; they never block user message ingestion.
- Chat can target another session after `session_lookup`; the hook still belongs to the durable
  database, not to an in-memory event listener.

Injection points:

- IM/channel ingestion: `ConversationRouter` adds hook text to the durable trigger context.
- WebUI chat/workspace: `SessionMessagingService` adds hook text before `host.append`.
- Resume dispatch: the hook itself becomes a system-authored agent turn.

## Restart and update

`RestartCoordinator` owns a single maintenance window:

1. Persist `runtime_restarts` with mode, reason, requester, and deadline.
2. Create a global runtime hook that renders the live countdown on every new turn.
3. At the deadline, mark the intent `executing`.
4. Stop channels, hooks, plugins, the conversation host, caches, and databases in lifecycle order.
5. Exit with code 75 and write `$TSUKAIMA_DATA_DIR/restart-intent.json`.
6. An external supervisor may perform an image/container upgrade and start the process again.
7. On boot, recover orphaned intents, become ready, then dispatch reserved resume hooks.

Recovery rules:

- `scheduled` found on boot is durable work and is resumed, not failed: an overdue deadline runs
  now, a future one is re-armed, and the countdown hook is re-created through its dedupe key.
  Repeated boots are idempotent.
- `executing` found on boot means the supervisor completed the restart; it is marked `completed`.
- Runtime hooks for a cancelled/failed restart are cancelled with it.
- A deployment that owned the intent stays `scheduled` while the old process serves. The terminal
  intent settles it through `reconcileRestartDeployment`: a verified `completed` →
  `deployed`/`rolled_back`, an unverified `completed` → `manual_apply_required`,
  `cancelled` → `cancelled` and the proposal `failed`. A restart alone is never treated as proof
  the proposal is live, and neither is a matching commit: the deployment's exact
  `appliedIdentity` (revision **and** approved-patch checksum) must match what the process
  reports. A rollback must match the artifact it recorded as the restore target, not merely differ
  from the deployment it replaces. Settlement writes the proposal and task first and the deployment
  row last, so a crash mid-settlement replays cleanly, and a `manual_apply_required` row can still
  settle later with real verification.
- `$TSUKAIMA_DATA_DIR/restart-intent.json` is consumed only when its intent is already terminal;
  an unknown, active, or unparsable file is left in place for the operator.

The model and workspace cannot invoke Docker or the host deployer. `RestartReloadController`
maps an approved self-iteration reload into a deferred update intent; the actual version switch
remains a host responsibility.

## API and UI

Admin procedures:

```ts
admin.workspace.list({ includeArchived? })
admin.workspace.create({ goal?, mode?, baseRef?, parentSessionId?, tags? })
admin.workspace.get({ sessionId })
admin.workspace.update({ sessionId, title?, tags? })
admin.workspace.todos({ sessionId })
admin.sessions.search({ query?, limit? })
admin.sessions.send({ sessionId, target: "tsukaima", text, mode?, references? })
admin.runtime.scheduleRestart({ delaySeconds?, mode?, reason? })
admin.runtime.cancelRestart()
admin.runtime.restartStatus()
```

WebUI:

- `/workspace` is a separate rail destination and sidebar.
- Chat list excludes workspace objects.
- Workspace transcript reuses the chat renderer and adds task/repository/proposal status.
- Workspace inspector tabs are Context, Todos, Sessions, and Data; chat keeps its existing tabs.
- The composer exposes queue, interrupt, and follow-up modes.
- The workspace composer can `@` a conversation; references are one-turn context, not a
  subscription.
- Settings exposes one-minute restart/update scheduling and cancellation.

## Failure behavior

- A draft is created even when the first task creation fails; the user can retry from the same
  empty workspace.
- A failed hook render never drops the underlying message.
- A message interrupted by a workspace command remains visible as an outbound failed/aborted run
  through the normal live-run and transcript records.
- A failed restart handler marks the intent `failed` and keeps the process alive when possible.
- A missing external update supervisor leaves the old image/process in place after exit; the
  restart-intent file records what was requested.
