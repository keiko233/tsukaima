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
| `task_id` | `coding_tasks.id` created through the self-iteration RPC |
| `parent_session_id` | Chat session that spawned it, when applicable |
| `repository_root` | The running process repository, normally `process.cwd()` |
| `base_ref` | Git revision supplied to the task |
| `mode` | `analysis`, `patch`, `proposal`, or `maintenance` |
| `goal` | Immutable task brief shown in the UI and workspace prompt |

The workspace's durable conversation receives an initial handoff prompt containing the task id,
repository root, base revision, workflow rules, and the requirement to pass `taskId` to every
self-iteration tool. It never edits the live repository; writes remain inside the governed
worktree.

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

- `scheduled` found on boot means the prior process stopped before its deadline; it is marked
  `failed` instead of causing a restart loop.
- `executing` found on boot means the supervisor completed the restart; it is marked `completed`.
- Runtime hooks for a cancelled/failed restart are cancelled with it.

The model and workspace cannot invoke Docker or the host deployer. `RestartReloadController`
maps an approved self-iteration reload into a deferred update intent; the actual version switch
remains a host responsibility.

## API and UI

Admin procedures:

```ts
admin.workspace.list({ includeArchived? })
admin.workspace.create({ goal, mode?, baseRef?, parentSessionId? })
admin.workspace.get({ sessionId })
admin.sessions.send({ sessionId, target: "tsukaima", text, mode? })
admin.runtime.scheduleRestart({ delaySeconds?, mode?, reason? })
admin.runtime.cancelRestart()
admin.runtime.restartStatus()
```

WebUI:

- `/workspace` is a separate rail destination and sidebar.
- Chat list excludes workspace objects.
- Workspace transcript reuses the chat renderer and adds task/repository/proposal status.
- The composer exposes queue, interrupt, and follow-up modes.
- Settings exposes one-minute restart/update scheduling and cancellation.

## Failure behavior

- A workspace task-creation failure does not create a workspace session.
- A failed hook render never drops the underlying message.
- A message interrupted by a workspace command remains visible as an outbound failed/aborted run
  through the normal live-run and transcript records.
- A failed restart handler marks the intent `failed` and keeps the process alive when possible.
- A missing external update supervisor leaves the old image/process in place after exit; the
  restart-intent file records what was requested.
