# Self-iteration

Tsukaima can modify its own plugins, prompts, documentation, and application code, but this is a governed workflow, not direct host shell access from chat.

## Principles

- Every coding change happens in a disposable git worktree.
- Every deployment proposal has a diff, test result, review note, and rollback path.
- The chat-facing agent calls tools; it does not run the deployer itself.
- Secrets, production data, NapCat login state, and unrelated deployment paths are protected.
- Development is local-first; production distribution is a host-built image from the approved
  deployment branch.

## Workflow

1. Create `IterationTask` in durable storage with goal, source conversation, and constraints.
2. Create a git worktree under `<data-dir>/worktrees/<task-id>`.
3. Run the coding runner with read/write/edit/search/bash tools scoped to that worktree.
4. Require tests relevant to the change.
5. Generate a patch summary and risk assessment.
6. Ask for administrator approval unless the conversation policy explicitly permits a low-risk auto-apply path.
7. Apply locally, restart/reload only the affected component, and verify health.
8. Record result, commit, and rollback instructions in the durable task and PostgreSQL audit table.

## Workspace agents

Self-iteration work now runs in an explicit workspace session created from chat or the Workspace
sidebar. A workspace conversation is linked to one `coding_tasks` row and receives the governed
coding tools; the parent chat only receives `workspace_spawn`, status, send, and hook tools. See
[Workspace and prompt hooks](workspace-and-hooks.md).

The workspace uses the running process repository (`process.cwd()`) as its analysis root. Any
mutation still happens in a disposable worktree with the existing path/command policy.

## Tool surface

The coding runner exposes:

- repository read/search/edit/write tools
- controlled shell execution
- test and build commands
- git status/diff/log
- local project documentation access
- deployment proposal creation

It does not expose:

- Docker socket
- host filesystem outside approved roots
- secret files
- production databases
- other project directories on the deployment host

### Execution isolation

A fixed argv list and a scrubbed environment are not a complete security boundary: `bun -e`,
`rg --pre`, or any interpreter that reads a repository file turns one allow-listed command into
arbitrary code. The host chooses one of two governed executors with
`TSUKAIMA_CODING_SANDBOX`:

`host` (default) keeps the governance rails without OS-level isolation:

- Commands are resolved from fixed directories and checked against the policy allowlist; the
  environment is explicitly constructed instead of inherited.
- The working directory must be a task worktree. Naming the repository as `cwd` fails.
- Test/build never run in the live tree, and a task without a worktree is rejected.
- `analyze` read/search copies the committed or task-worktree source into a private temporary
  directory and reads it there; the live repository is never the analysis surface.
- A repository script can still read unrelated host files and reach the network, because the
  process shares the container's namespaces.

`bubblewrap` adds OS-level isolation:

- `packages/coding/src/sandbox.ts` drives `bubblewrap` with `--unshare-all` (user, mount, PID, IPC,
  UTS, network), `--die-with-parent`, a cleared environment, and a tmpfs `/tmp`.
- Only `/usr`, `/bin`, the runtime libraries, and a short allowlist of `/etc` files are mounted
  read-only. The repository root is **not** bound: it appears as an empty directory. A command
  gets only explicit mounts — the worktree's `node_modules` target, the linked worktree's git
  directory, and the shared object store and refs. `.git/config`, hooks, dotenv files, `data/`,
  `secrets/`, nested credential files, and SQLite databases are therefore absent, not masked one
  by one, so a nested secret cannot leak by not matching a mask pattern.
- The working directory must be a task worktree. Naming the repository (or a path above the
  worktree root) as `cwd` fails closed instead of binding it.
- `analyze` read/search runs against a private read-only copy mounted at `/analysis`: a committed
  `git archive` snapshot for a read-only task, or the task worktree (including its edits) for a
  patch task. The live repository is never the analysis surface, and gitignored files are not
  visible to a read-only task.
- The network namespace has loopback only; outbound egress is unavailable.
- Commands are resolved from fixed directories, never from a model-supplied path.
- The test/build argv comes entirely from the policy (`testCommand`/`buildCommand`); the model
  cannot pass `command` or `args`. A test-name filter is positional and may not start with `-`.
- Search passes `--` before the pattern, bounds the pattern length, and resolves the optional path
  through the worktree allowlist, so it cannot become an `rg` flag or read outside the repository.
- Test and build never run in the live tree. A task without a worktree is rejected.

When `bubblewrap` is selected but missing, cannot create namespaces, or the probe fails, the
provider throws `SandboxUnavailableError` and the tool fails closed; there is no automatic
fallback to `host`.

Docker's default seccomp profile blocks the namespace syscalls bubblewrap needs. The shipped
Compose service therefore defaults to `host` rather than disabling seccomp for the whole
container (which would weaken the boundary around plugins, channel adapters, and model SDKs).
Operators who want namespace isolation must supply a runtime that permits bubblewrap and set
`TSUKAIMA_CODING_SANDBOX=bubblewrap`.

## Deployment path

Current phase: development.

The agent can produce a deployment bundle:

- source diff or container build context
- migration notes
- backup/rollback notes
- exact commands for the administrator

Deployment phase:

- The deployment host builds an image tagged with the strict `VERSION`.
- Deployment is an explicit host build plus controlled service update.
- Rollback uses the previous image tag.
- The bot may propose this operation, but the host-side deployer remains a narrow, audited service.

Approved reloads become a durable one-minute restart/update intent. The process stops gracefully,
writes `restart-intent.json`, and exits with code 75 so a supervisor can replace the image or
container before starting again. Reserved chat/workspace tasks resume after readiness.

A deferred reload leaves the deployment row `scheduled`, because the process is still running the
old revision. Boot recovery never treats a restart alone as success, and a matching commit is not
enough either: `proposal.sourceRevision` is the worktree HEAD the proposal was generated from, so
when the approved diff is uncommitted it equals the *base* commit and an image built from it
contains none of the approved change.

- Each deployment records an exact `appliedIdentity` (`revision` + the sha256 of the approved
  patch) and, for rollbacks, the `previousIdentity` it restores. A deployment created without that
  identity can never be verified and settles `manual_apply_required`.
- `executing` means the supervisor started the process again. The deployment becomes
  `deployed`/`rolled_back` only when the running process reports exactly that revision **and** the
  approved patch checksum (`TSUKAIMA_COMMIT` and `TSUKAIMA_PATCH_SHA256`). A revision-only match, a
  different third revision, or a missing label fails closed to `manual_apply_required`, with a
  failed post-check that says why, and the proposal stays `deploying` so a later verified boot can
  settle it. The runtime never applies a diff itself.
- A `scheduled` intent found on boot is resumed, not failed: an overdue deadline executes now, a
  future one is re-armed, and its countdown hook is re-created through its dedupe key. Recovery is
  idempotent, so repeated boots do not duplicate the hook or lose the intent.
- An explicit cancel settles the deployment `cancelled` and its proposal `failed`.

The supervisor's `restart-intent.json` is consumed only once its intent is terminal, so a stale
file cannot describe the next boot.

## Policy

Default policy:

| Action | Default |
| --- | --- |
| Read repository | Allowed (read-only sandbox) |
| Edit worktree | Allowed for approved tasks |
| Run tests/build | Allowed in the worktree sandbox |
| Commit locally | Allowed after task approval |
| Reload first-party plugin | Requires admin approval by default |
| Restart server | Requires admin approval |
| Build image | Requires admin approval |
| Deploy | Requires explicit admin approval |

Policies are stored per conversation/task and audited. A runaway loop must be abortable and have a turn/time budget.

The execution role is authoritative: coding tools are offered only in a `workspace` conversation
with an explicit `coding` capability. Chat, IM, and background/proactive turns never receive them,
even if the durable policy document is stale. If the role or policy cannot be read, the turn runs
with no model tools.
