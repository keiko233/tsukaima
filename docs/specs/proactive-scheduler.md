# Proactive and scheduler spec

## Outcome

Elaina supports reminders, follow-up nudges, and supervised proactive messages with durable
state, policy limits, and admin observability.

## Current boundary

No runtime scheduler/proactive implementation exists. DSH uses its timer/local jobs plus a
large NapCat proactive configuration and state files.

## Plugin identity

`proactive-scheduler` owns scheduling and outbound initiative. It requires storage, tasks,
hooks, channel send, conversation policy, tools, UI, and audit permissions. It must not send
without a durable task/decision record.

## Task model

Use the Phase 3 host `tasks.*` scheduler as the sole timer, retry, and atomic claim engine (do
not duplicate timer loops inside the plugin). `proactive-scheduler` stores proactive policies,
per-conversation operational state, and decision logs via Phase 3 `MigrationRegistry` (`host` mode):

```ts
type ScheduledTask = {
  id: string;
  conversationId: string;
  chatObjectId: string;
  kind: "remind" | "nudge" | "proactive" | "workflow";
  prompt: string;
  scheduledForMs: number;
  dueWindowMs?: number;
  repeat?: { intervalMs: number; maxOccurrences?: number; untilMs?: number };
  cancelIfReplied?: boolean;
  maxAttempts: number;
  attempts: number;
  status: "scheduled" | "running" | "completed" | "cancelled" | "failed" | "skipped";
  lastError?: string;
  createdBy: { kind: "user" | "agent" | "admin"; id: string };
  createdAtMs: number;
  updatedAtMs: number;
};
```

Tasks are durable, idempotent, restart-safe, scoped to conversation, and have deterministic
worker claim semantics. Repetition stops on max occurrences/until/cancel and records skipped
occurrences.

## Model tools

| Tool | Behavior |
| --- | --- |
| `proactive-scheduler.schedule` | schedule within max delay/limits |
| `proactive-scheduler.list` | conversation-scoped/all under admin policy |
| `proactive-scheduler.cancel` | one or all for a conversation |
| `proactive-scheduler.get` | status and run history |

Inputs bound delay, repeat, prompt size, per-conversation tasks, and max attempts. Agent
created tasks are marked and audited; destructive global cancel is admin-only.

## Proactive decision

A proactive tick performs:

1. candidate conversations
2. policy enable/access check
3. quiet hours
4. daily/hourly caps
5. cooldown and silence/backoff
6. activity/minimum-message conditions
7. warm/interest signal or deterministic probability
8. optional bubble/reply gate
9. model decision with compact context
10. marker handling
11. durable decision/outcome log

Supported model markers: `ELAINA_SKIP`, `ELAINA_LURK`, and optional `ELAINA_SCHEDULE_LATER`.
Markers are consumed and audited, never sent.

State includes last messages, last outbound, unanswered streak, refused count, silence until,
active-hours histogram, warmness, openers, and daily counters. This is operational memory, not
conversation history.

## Execution and output

1. Claim task atomically via host `tasks.*`.
2. Acquire the shared Phase 2 per-conversation execution lock (aborting/cancelling pending
   `cancelIfReplied` nudges if a qualifying inbound reply arrived first).
3. Load compact conversation context.
4. Submit as a durable background turn.
5. Apply trigger/output policy.
6. Send through channel; update task and delivery state.
7. Cancel nudge when a qualifying reply arrives.

Nudges, reminders, and proactive turns are distinguishable and individually configurable.

## Admin UI

- enable globally/per conversation/persona
- caps, quiet hours, cooldown, probability
- minimum activity, warmness, gates
- task list/filter/cancel/edit prompt
- decision history and outcomes
- dry-run simulate
- destructive reset with audit

## Safety

- default proactive disabled
- no send when channel unavailable
- no cross-conversation send unless policy and target exist
- group/user rate limits independent
- no sensitive/private context leak into another conversation
- all sends audited with delivery status
- secrets/content never appear in logs

## Tests

1. Task persistence/restart/idempotency.
2. Worker claim, retry, cancellation, repeat.
3. Policy/caps/quiet-hour gates.
4. Marker handling and no-send audit.
5. Proactive state/backoff/daily caps.
6. Channel unavailable/failure.
7. Admin UI mutation and audit.

## Acceptance

Tasks survive restart, cannot double-fire, can be canceled from UI, and proactive messages only
occur under explicit policy with audited decisions.
