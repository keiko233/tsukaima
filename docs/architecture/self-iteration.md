# Self-iteration

Tsukaima can modify its own plugins, prompts, documentation, and application code, but this is a governed workflow, not direct host shell access from chat.

## Principles

- Every coding change happens in a disposable git worktree.
- Every deployment proposal has a diff, test result, review note, and rollback path.
- The chat-facing agent calls tools; it does not run the deployer itself.
- Secrets, production data, NapCat login state, and unrelated tsukaima paths are protected.
- Development is local-first; later production distribution is a GHCR image.

## Workflow

1. Create `IterationTask` in durable storage with goal, source conversation, and constraints.
2. Create a git worktree under `/opt/tsukaima/worktrees/<task-id>`.
3. Run the coding runner with read/write/edit/search/bash tools scoped to that worktree.
4. Require tests relevant to the change.
5. Generate a patch summary and risk assessment.
6. Ask for administrator approval unless the conversation policy explicitly permits a low-risk auto-apply path.
7. Apply locally, restart/reload only the affected component, and verify health.
8. Record result, commit, and rollback instructions in the durable task and PostgreSQL audit table.

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
- other tsukaima project directories

## Deployment path

Current phase: development.

The agent can produce a deployment bundle:

- source diff or container build context
- migration notes
- backup/rollback notes
- exact commands for the administrator

Later phase: GHCR.

- CI builds a versioned image.
- Deployment is an explicit image pull plus controlled service update.
- Rollback uses the previous image tag.
- The bot may propose this operation, but the host-side deployer remains a narrow, audited service.

## Policy

Default policy:

| Action | Default |
| --- | --- |
| Read repository | Allowed |
| Edit worktree | Allowed for approved tasks |
| Run tests/build | Allowed |
| Commit locally | Allowed after task approval |
| Reload first-party plugin | Requires admin approval by default |
| Restart server | Requires admin approval |
| Build image | Requires admin approval |
| Deploy | Requires explicit admin approval |

Policies are stored per conversation/task and audited. A runaway loop must be abortable and have a turn/time budget.
