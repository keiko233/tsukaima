# Self-iteration runtime spec

## Outcome

Tsukaima's coding capability becomes a supervised, auditable plugin for repository analysis,
patching, testing, deployment proposals, and controlled reload.

## Current boundary

`packages/coding` has runner/worktree/tools/approvals/proposals/reload-controller and DB tables,
but no server registration, model tools, RPC, or WebUI. DSH currently provides a full coding
agent/runtime.

## Plugin identity

`self-iteration` wraps `packages/coding`. Permissions:

- `tools.register`
- `rpc.register`
- `ui.panel`, `ui.approval-card`
- `coding.read`
- `coding.execute`
- `storage.global`
- `audit.write`
- `tasks.create`

No plugin may directly mutate the host repository without policy/approval.

## Workspace surfaces

A workspace is a full-authority coding surface: read/search/test, worktree creation, edit,
upstream merge, build, diff, and proposal all use the same task. `maintenance` operations
(deploy, backup, reload, rollback) remain admin RPC / approval-card actions and are never model
tools. Legacy task rows may still carry a mode label for lineage, but it does not gate anything.

A coding task has an immutable goal, repository root policy, status, approval state, logs,
artifacts, tests, diff, and proposal references.

## Schema and library extensions

`packages/db/src/schema.ts` currently only holds `coding_approvals` and `coding_proposals`.
Before wiring the plugin, extend `packages/coding` and `packages/db`:

- Add `coding_tasks` (persisting `mode`, `baseRef`, `constraintsJson`, `worktreePath`, `status`,
  `logsRef`/`artifactsJson`) and `coding_deployments` (immutable deploy/rollback records).
- Extend `IterationTask` with `mode`, `logs`, and `artifacts`, and extend `DeploymentProposal` /
  `coding_proposals` with `motivation`, `sourceRevision`, `artifactMetadataJson`, `changedFilesJson`,
  `diffChecksum`, `envChangesJson`, and `requiresRestart`.

## Model tools

All tools register under `self-iteration.*` and use Phase 3 `ToolPolicy` (`visibility`,
`requiredConversationCapabilities`) so they never appear in normal QQ conversations unless policy
explicitly grants them:

| Tool | Behavior |
| --- | --- |
| `self-iteration.analyze` | scoped read/search/test |
| `self-iteration.worktree` | create bounded worktree |
| `self-iteration.upstream` | stage an upstream merge in the worktree, or abort it |
| `self-iteration.edit` | validated patch/edit |
| `self-iteration.test` | run declared commands with timeout |
| `self-iteration.build` | build/build artifact |
| `self-iteration.diff` | structured diff |
| `self-iteration.propose` | create proposal requiring deployment approval |
| `self-iteration.status` | task status/logs/artifacts |

Every workspace task has the full toolset; the stored mode is lineage only and never gates a
tool. Patches use structured input/diffs; commands allowlists; secrets/path policy; all writes
occur only in approved worktrees. `maintenance` operations (deploy, backup, reload, rollback) are
**admin RPC / `approval-card` actions only** and are never exposed as model tools.

## Approval and deployment

Proposal requires:

1. title, motivation, risk assessment, rollback notes
2. exact source revision and artifact metadata
3. tests/build evidence
4. changed-file inventory
5. diff size/checksum
6. environment/config changes
7. restart/reload requirement

Approval card displays these fields and policy gates. Approve may stage artifacts but not
auto-apply unless explicitly configured. Deployment creates an immutable deployment record with
pre/post checks and rollback plan.

Reload must be supervised, health-gated, and rollback-capable. DSH's ad hoc local reload is not
copied directly.

## Audit and graph

Audit each tool call, approval, deploy, reload, rollback, and policy denial. Every coding task
exposes:

1. goal and plan steps
2. worktree commit
3. tool timeline
4. test/build result
5. diff
6. approvals
7. artifacts
8. errors
9. deployment/rollback links

## Admin UI

- task list/detail
- step/task graph
- log/artifact viewer
- diff viewer
- approval cards
- policy editor
- deployment/proposal history
- rollback workflow

Chat can create/inspect tasks via tool/RPC; WebUI handles approvals. No coding tools appear in
normal QQ conversations unless policy grants them.

## Tests

1. Plugin registration and permission denial.
2. Worktree/path/edit policy.
3. Test/build tool allowlist/timeouts/output.
4. Diff/proposal schema.
5. Approval expiry/approval/denial/audit.
6. Deployment record and rollback plan.
7. Restart/reload health gates.
8. Chat task and UI graph integration.

## Acceptance

Tsukaima can analyze its own repo, create a tested patch, show diff, require approval, produce
deployment artifacts, and roll back per record, with no coding tool leak into QQ chat.
