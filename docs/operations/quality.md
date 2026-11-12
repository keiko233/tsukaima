# Quality gates

All code changes pass:

1. `bun run lint`
2. `bun run format:check`
3. `bun run typecheck`
4. `bun run test`

Git requirements:

- Conventional Commits enforced by `commitlint`.
- `lint-staged` formats and lints staged files before commit.
- Husky manages local hooks.
- CI runs the complete `bun run check` pipeline.
- Generated files should be formatted, but should not be manually edited.

Recommended commit scopes:

| Scope | Area |
| --- | --- |
| `core` | Conversation, activity, memory, persona, policy |
| `durable` | pi-durable integration or SQLite adapter |
| `db` | Drizzle schema/migrations |
| `server` | Elysia/oRPC host |
| `web` | TanStack/beUI frontend |
| `onebot` | NapCat/OneBot adapter |
| `plugins` | Plugin runtime or built-ins |
| `coding` | Self-iteration runtime |
| `migration` | DSH Migration Kit |
| `docs` | Documentation |

Any dependency addition or removal must be visible in the commit diff and include a short justification in the PR or commit body.
