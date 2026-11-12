# Testing strategy

Testing is part of the architecture, not an afterthought. The runtime has many async and restart-sensitive paths, so tests must cover state transitions and adapters.

## Test layers

| Layer | Tool | Focus |
| --- | --- | --- |
| Unit | Bun test | Pure domain functions, schemas, policy evaluation |
| Adapter | Bun test | SQLite adapter, Drizzle repositories, OneBot normalization |
| Contract | Bun test | oRPC routers with fake services |
| Integration | Bun test | Durable conversations with fake model/channel |
| End-to-end | Playwright | WebUI admin/chat flows |
| Migration | Bun test | DSH parser, normalization, dry-run/import ledger |

## Required fixtures

### Fake model

Returns deterministic assistant messages, tool calls, streaming events, and errors.

Supports:

- normal reply
- tool-call reply
- multiple tool calls
- provider error
- malformed response
- context overflow

### Fake OneBot channel

Emits deterministic private/group events and captures outbound actions.

Supports:

- text
- image
- sticker
- reply
- mention
- recall
- disconnect
- duplicate message
- malformed event

### Fake plugin

Used for plugin runtime tests.

Supports:

- manifest validation
- tool registration
- hook subscription
- denied permission
- worker crash/restart
- storage state

### Fake coding repository

Small git repository with intentional changes and failing tests.

Supports:

- patch creation
- test pass/fail
- worktree cleanup
- approval gate

## Core test cases

### Durable adapter

1. Open new database.
2. Run migrations.
3. Submit fake conversation.
4. Restart process.
5. Resume unfinished run.
6. Verify compaction.
7. Verify document watch.

### Startup lifecycle

1. Boot with empty data directories.
2. Verify durable and domain migrations run automatically.
3. Verify readiness remains false until channels finish.
4. Inject durable migration failure.
5. Verify startup fails and no channel starts.
6. Inject domain migration failure.
7. Verify maintenance/failed state.
8. Inject OneBot connection failure.
9. Verify configured failed/degraded behavior.
10. Restart after interrupted boot.
11. Verify migrations are idempotent.
12. Verify scheduler recovery does not run before readiness.

### Conversation ingestion

1. Receive private text.
2. Resolve user/conversation.
3. Store raw message.
4. Close activity.
5. Submit to durable conversation.
6. Verify activity and message links.

### Aggregation

1. Send image.
2. Send text.
3. Send correction.
4. Send sticker within window.
5. Verify one activity with four messages.
6. Verify model context preserves order and participants.

### Steering

1. Start agent run.
2. Send late message.
3. Verify it is delivered as steer.
4. Verify original activity and late message remain distinct.

### Provider failure

1. Fake model fails.
2. Verify submission fails visibly.
3. Restart process.
4. Verify queued input behavior.
5. Verify no duplicate send.

### OneBot outbound

1. Assistant returns text/media.
2. Output policy converts to OneBot parts.
3. Fake channel captures action.
4. Delivery state updates.

### Plugin permission

1. Plugin tries denied channel API.
2. Verify rejection and audit.
3. Grant permission.
4. Verify allowed call and audit.

### Memory scope

1. Store user memory for user A.
2. Retrieve in user A conversation.
3. Retrieve in user B conversation.
4. Verify user A memory is not injected.

### Self-iteration

1. Create iteration task.
2. Create worktree.
3. Patch file.
4. Run tests.
5. Verify proposal.
6. Reject proposal.
7. Verify worktree cleanup.

## CI policy

CI runs:

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun run typecheck
bun run test
```

End-to-end tests may run in a separate job.

## Test data rules

1. No real QQ messages.
2. No real credentials.
3. No real DSH user data in committed fixtures.
4. Use synthetic IDs and synthetic content.
5. Do not commit generated SQLite files.
6. Temporary databases live in test temp directories.
