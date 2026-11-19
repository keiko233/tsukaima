# Workspace agent execution

## Outcome

A WebUI Workspace can inspect its base revision, edit its task worktree, run relevant checks,
and submit a deployment proposal in one agent turn. Routine repository tools are available
in the first model request. Shell commands run in an isolated task environment. Administrator
approval governs deployment, restart, backup, and rollback.

## Batch 1 — Tool exposure and task binding

- Offer `self-iteration.analyze`, `worktree`, `edit`, `test`, `build`, `diff`, `propose`,
  and `status` upfront in authorized Workspace turns. Keep upstream merges and infrequently
  used diagnostics discoverable on demand. Preserve other plugins' loading defaults.
- Derive the task for model calls from the durable conversation's Workspace binding. Accept
  a matching legacy task ID and audit a mismatch. Treat a missing binding as an invocation
  failure. Keep existing admin RPC callers and legacy task modes compatible.
- Resolve repository and path policy through existing domain services. Use the task's base
  revision for read-only inspection before checkout. Provision the worktree on first edit or
  validation. Concurrent calls and retries reuse the same task worktree.
- Update the Workspace handoff to describe the available tools and automatic task binding.
  Keep the existing Context Inspector's offered and deferred tool lists consistent with the
  model request. Reject coding calls after permission withdrawal, including tools discovered
  in earlier turns.

**Acceptance.** A deterministic fake model sees the core tools in its first Workspace request,
then uses them to edit a synthetic repository, run a test, and submit a proposal. Exercise a
resumed Workspace, a legacy task, mismatched task IDs, concurrent worktree provisioning,
capability withdrawal, and the existing IM and WebUI chat execution and discovery boundaries.

## Batch 2 — Validation commands and isolated shell

- Add explicit repository check targets for typecheck, lint, targeted tests, and WebUI build.
  Resolve target names to server-owned argv. Use the existing managed process and audit paths
  to record command outcomes, exit codes, bounded output, timeouts, and cancellation. Keep
  existing test and build tools compatible.
- Put executor mechanics in `packages/coding` and Workspace task operations in
  `plugins/self-iteration`. Probe the isolated executor and expose an actionable unavailable
  reason through the existing status or inspector flow.
- Provide an upfront Workspace exec tool when the executor can enforce isolation. Give Bash
  a disposable snapshot of the task source and writable scratch space for pipelines and
  generated files. Persist source changes through the path-checked edit tool. Exclude the live
  checkout, other tasks, Git credentials and mutable shared Git metadata, service data, and
  Docker sockets from the shell environment. Use a private home and temporary directory, a
  scrubbed environment, disabled external network access, and a read-only dependency mount or
  task-local dependency cache. Terminate subprocesses on timeout or cancellation.
- Require the isolated backend for the new exec and check targets. Verify Bubblewrap support
  independently of compatibility tests using fake executors. Preserve the existing configured
  test/build path while migration to isolation is validated. Keep deployment changes for a
  separate operational decision.

**Acceptance.** Run a targeted check and a Bash pipeline on task source in an isolated test
environment. Verify that temporary writes remain disposable and inaccessible paths are absent.
Verify cancellation, bounded output, and an unavailable backend without running commands on
the host. Use synthetic repositories and deterministic fakes for regular tests.

## Batch 3 — Proposal evidence

- Have the model supply the title, motivation, risk, rollback, and operational notes.
  Derive revision, changed files, patch, checksum, and verification evidence from the task.
- Bind successful verification to the worktree content it checked, including untracked files
  that would enter the proposal. Use a common snapshot identity across check, diff, and
  proposal. Serialize or recheck at snapshot boundaries so concurrent changes cannot attach
  stale evidence. Return actionable missing-check information when a task needs verification.
- Keep the approval card and existing supervised restart and deployment reconciliation.
  Continue to display historical proposals. Create any required wire schemas in
  `packages/contracts` and generate any database migration through Drizzle.

**Acceptance.** Submit a proposal from a current, successfully verified patch. Editing after
verification, a failed or cancelled check, and concurrent edits during validation all
require fresh evidence. Older task and proposal rows remain viewable. Existing approval
and restart recovery tests continue to pass.

## Delivery

Land the batches in order. Each batch gets a separate PR and runs the affected service and
integration tests. The combined stack runs `bun run check`. Record the actual sandbox
verification environment in the shell PR. Keep tests independent of production systems.
