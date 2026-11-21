# Agent Guide

## Repository

Tsukaima is a Bun workspace. Keep the existing package boundaries:

- `apps/server`: HTTP/RPC server, lifecycle wiring, channels, conversation services.
- `apps/web`: React/WebUI built with TanStack Router and oRPC.
- `packages/core`: durable conversation host and model orchestration.
- `packages/contracts`: the single source of truth for RPC input/output schemas.
- `packages/db`: Drizzle schema and generated SQLite migrations.
- `packages/coding`: governed coding-task, worktree, proposal, and reload primitives.
- `plugins/*`: built-in and first-party plugin implementations.

Do not add a second API shape beside `packages/contracts`, and do not bypass the domain
services with ad-hoc SQL in WebUI or plugin code.

## Commands

Run commands from the repository root unless noted:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test
bun run check
```

Targeted tests are preferred while iterating, for example:

```sh
bun test apps/server/tests/lifecycle.test.ts
bun test apps/server/tests/workspace-native-runner.test.ts
```

WebUI build and route-tree generation:

```sh
bun run --filter '@tsukaima/web' build
```

Database migrations are generated, not hand-written in normal development:

```sh
cd packages/db
bun run generate
```

Never edit an already-applied migration or its snapshot. Add a new migration instead.

## Coding Conventions

- Use tabs and match the formatting of the surrounding file.
- Prefer small, focused services; keep lifecycle wiring in `apps/server/src/lifecycle.ts`.
- Use `apply_patch` for edits.
- Add comments only where the reasoning or invariant is non-obvious.
- Do not add copyright or license headers.
- Never commit deployment hosts, SSH users, IP addresses, internal hostnames, deployment paths,
  account/group IDs, chat content, or private sticker-library references. Use placeholders from
  `docs/operations/privacy.md`.
- Keep optional fields compatible with `exactOptionalPropertyTypes`.
- When a wire field changes, update `packages/contracts` and every consumer together.
- WebUI copy lives in both `apps/web/messages/en.json` and `apps/web/messages/zh-cn.json`.

## Architectural Constraints

- Ordinary IM/chat conversations must not receive coding execution tools.
- Self-modification runs inside governed worktrees and path allowlists; never give a model
  unrestricted host, Docker-socket, secret, or production-database access.
- Workspace sessions are for repository work. Chat sessions may spawn and communicate with
  workspace sessions, but the two execution surfaces must remain distinguishable.
- Queue, steer, follow-up, and interrupt semantics belong in shared conversation/session
  services, not duplicated in individual UI or channel adapters.
- Prompt hooks are durable domain records. Injection must happen before the agent turn, and a
  hook handler must not block unrelated conversations.
- Restart/update flows must be graceful, observable, and resumable. Persist intent and reserved
  follow-up work before closing storage; never silently drop a scheduled restart.
- Use the existing audit surface for privileged or destructive actions.

## Testing

- Tests run against SQLite/Bun test APIs and temporary directories. Never require a real QQ,
  NapCat, model provider, Docker daemon, or network endpoint.
- Deterministic fake models are the default in server tests.
- Every test identity and message is synthetic. Never paste production chat text, nicknames, QQ or
  group numbers, or host details into tests or fixtures, even as a "small realistic example".
- Cover restart recovery, idempotency, queue/interrupt behavior, and policy denial paths when
  changing runtime orchestration.
- Clean up temporary directories and open resources in `finally` blocks.
- Do not attempt to fix unrelated failing tests; report them separately.

## Operations

- Releases are published only through `.github/workflows/publish.yml`. It bumps `VERSION`, writes
  `CHANGELOG.md`, tags, and creates the GitHub release together; do not create release tags or
  releases by hand, and do not edit an existing changelog entry for a published version.
- `ops/deploy/*` targets a real host and may stop containers, build images, or overwrite
  deployment state. Do not run deployment or production maintenance commands without explicit
  user approval.
- Every deployment must increase `VERSION` using strict SemVer and deploy a committed, clean
  branch. See `docs/operations/deployment.md`.
- Do not commit generated runtime data (`data/`), secrets, local `.env*` files, or worktrees.
- Run `bun run check:secrets` before committing anything that touched configuration or logs.
