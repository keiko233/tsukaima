# Quality gates

All code changes pass:

1. `bun run check:version`
2. `bun run lint`
3. `bun run format:check`
4. `bun run typecheck`
5. `bun run test`
6. `bun run check:secrets`
7. `bun run test:e2e`
8. Review against the [privacy and synthetic data rules](privacy.md)

Git requirements:

- Conventional Commits enforced by `commitlint`.
- `lint-staged` formats and lints staged files before commit.
- Husky manages local hooks.
- The GitHub Actions `test` workflow runs on pull requests and pushes to `main`. It is the
  mandatory gate for secret scanning, WebUI i18n/build checks, the complete `bun run check`
  pipeline, and Playwright. There is no tag-triggered release or publishing workflow.
- `bun test` only collects `*.test.ts`/`*_test_*`/`*.spec.ts` files outside `e2e/`; `bunfig.toml`
  ignores `e2e/**`, and Playwright owns `e2e/*.spec.ts`.
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
