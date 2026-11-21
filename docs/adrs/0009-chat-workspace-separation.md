# ADR 0009: Separate chat and workspace execution planes

## Status

Accepted

## Context

Self-iteration needs a long-running agent that can inspect the running repository, create a
governed worktree, test changes, and prepare a proposal. Ordinary chat also needs to trigger and
supervise that work without receiving repository mutation tools itself. The two surfaces already
share durable conversations, but they were exposed as one session list and one implicit execution
role.

Restart and update add another constraint: a scheduled process stop must be visible to every chat
before its next prompt, and work that cannot finish must be reserved so the assistant can resume
after boot. That mechanism is not restart-specific; future triggers such as a cross-session
mention need the same durable prompt injection.

## Decision

1. Add `workspace` as a first-class chat/session kind.
   - A workspace has one ordinary durable conversation and message transcript.
   - `workspace_sessions` links that conversation to a governed coding task, repository root,
     base revision, parent chat session, and mode. A draft may have no task or goal yet.
   - The first user message starts the task and derives the title and tags; creation itself does
     not require a prompt.
   - The workspace agent runs with the `coding` capability and the
     workspace repository tools.
   - Chat sessions never receive workspace coding tools.

2. Give chat a narrow control surface.
   - Host-owned tools: `workspace_spawn`, `workspace_status`, `workspace_send`,
     `session_lookup`, `hook_schedule`, and `hook_list`.
   - A chat can spawn a workspace for a user-reported bug/feature or for an issue it discovers
     itself.
   - A workspace receives status/send/hook tools but cannot recursively spawn another workspace.
   - Workspaces alone receive coding-agent tools for todos, referenced conversation context, and
     read-only domain-database diagnostics.
   - Workspaces are listed by `admin.workspace.*` and are excluded from the chat list.

3. Share message delivery semantics.
   - Chat WebUI messages, workspace commands, and reserved hook turns use one
     `SessionMessagingService`.
   - `queue` places the message at the next tool/loop boundary, `interrupt` aborts the current
     generation, and `follow-up` waits for the current turn to settle.
   - Both surfaces persist the same domain message rows and use the same durable activity window.

4. Make prompt injection durable.
   - `prompt_hooks` stores `context`, `runtime`, and `resume` hooks.
   - Context hooks fire once before the next agent turn.
   - Runtime hooks render on every turn until expiry; restart countdowns use this kind.
   - Resume hooks dispatch a reserved turn after a due time or the next process boot.
   - Hook injection happens in both channel ingestion and local session messaging, so chat and
     workspace semantics do not drift.

5. Use a graceful restart coordinator.
   - `runtime_restarts` stores one scheduled intent with mode `restart` or `update`.
   - The default countdown is 60 seconds. A global runtime hook tells every chat the remaining
     time before its next prompt.
   - At the deadline the process stops gracefully and exits with code 75. It writes
     `$TSUKAIMA_DATA_DIR/restart-intent.json` for an external supervisor.
   - The host-side supervisor remains responsible for replacing the image or container. The
     model does not receive Docker, host-shell, or deployer access.
   - After readiness, pending resume hooks become normal agent turns.

## Consequences

- Chat and workspace can share transcripts, queueing, live-run rendering, and hooks without
  sharing execution capabilities.
- Workspace creation and communication remain auditable and scoped to a coding task.
- A restart is observable in conversation behavior rather than being a silent process kill.
- Cross-session context can be planted without putting every future prompt into one global
  system prompt.
- Deployments still require a host-side update mechanism. This ADR defines the handoff and
  resumability contract; it deliberately does not grant the runtime host or Docker control.
