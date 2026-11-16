# ADR 0004: Governed self-iteration without direct host control

## Status

Accepted

## Context

Self-modification is a core requirement, but the current phase is local development. Giving the chat agent unrestricted host or Docker access would be unsafe.

## Decision

Implement self-iteration as a governed coding workflow using `pi-coding-agent`-style tools inside scoped git worktrees. Deployment is a proposal workflow controlled by the administrator. The approved branch is built into an image on the deployment host, and every deployment remains explicit and audited.

## Consequences

- The bot can develop and test itself safely.
- The host-side deployer is deliberately narrow.
- No Docker socket is mounted into the agent process.
- All destructive/deploy actions require approval or an explicitly configured low-risk policy.
