# Git and GitHub operations

Status: decided, ready to implement. Owner surface: `apps/server` services, `packages/contracts`,
the upgrade center in the admin WebUI.

This spec makes the repository itself a first-class object of the running system: branch, upstream,
working-tree state, remotes, and the GitHub CLI session plus pull requests, issues, and CI are
readable and (where policy allows) operable from the WebUI and from governed workspace sessions.

The deploy path already requires a clean committed branch and a pushable remote
([deployment.md](../operations/deployment.md)), but the running server cannot answer "what revision
am I on, is it pushed, is it green?". This closes that loop.

## 0. Decided

| Question | Decision |
| --- | --- |
| Does the server need push rights? | Yes. The signed-in `gh` user token carries `repo` scope and the server may push. |
| Credential type | GitHub CLI user login. The runtime runs `gh auth login`; no GitHub App and no token in Tsukaima. |
| Device flow | Yes, delegated entirely to `gh`. No OAuth Client ID or App ID is configured in Tsukaima. |
| Where repository and CI status live | The existing upgrade center at `settings.upgrades`. No new page. |

## 1. Current boundary

What already exists and must be reused, not duplicated:

| Surface | Location | Notes |
| --- | --- | --- |
| Git exec | `apps/server/src/services/upgrade-service.ts` (`#git`) | Private spawn wrapper: 60 s timeout, 256 KiB output cap, `SAFE_GIT_NAME` remote validation. |
| Git exec | `packages/coding/src/worktree.ts` (`WorktreeManager`) | `git worktree add/remove/prune`, `assertSafeBaseRef`. |
| Governed model commands | `packages/coding/src/runner.ts`, `sandbox.ts` | Allow-listed commands run inside bubblewrap; fail closed. |
| Coding session flow | `apps/server/src/services/workspace.ts`, `coding-agent-tools.ts` | Workspace sessions, worktrees, proposals. |
| Upgrade flow | `apps/server/src/services/upgrade-service.ts`, RPC `admin.upgrade.*` | Branch, ahead/behind, dirty state, fast-forward or workspace upgrade, restart coordinator. |
| Upgrade UI | `apps/web/src/routes/(system)/settings.upgrades.tsx`, `_modules/upgrade-center.tsx` | The page this spec extends. |
| Config | `apps/server/src/config.ts` | `TSUKAIMA_UPGRADE_REMOTE` only; the repository root is `process.cwd()`. |
| Plugin host seams | `apps/server/src/lifecycle.ts`, `SELF_ITERATION_HOST_BINDING` | The established way to hand a host capability to a plugin. |

## 2. Gaps

1. **No shared git read model.** Branch and upstream data exists only inside one upgrade check
   against one remote. There is no branch list, remote list, tag list, worktree list, stash count,
   changed-file detail, or "is this commit pushed?" query.
2. **Two independent git exec paths** (`upgrade-service.ts`, `worktree.ts`) with different
   timeouts, env handling, and validation. A third would be a governance bug.
3. **No GitHub integration at all.** No authenticated login, no PR, issue, CI, or release reads,
   no writes.
4. **No credential surface.** Runtime settings are explicitly non-secret and plugin secrets are
   per-plugin. Nothing owns the host-level credential that `git push` and the GitHub API both need.
5. **`gh` owns authentication.** The runtime image installs `gh`; its config directory lives on the
   data volume (`GH_CONFIG_DIR=<dataDir>/gh`) and login uses `--insecure-storage` because a
   headless container has no keyring. No custom App JWT or device-code client lives in the server.
6. **Deploy has no GitHub preflight.** `ops/deploy/deploy.sh` never checks that the pushed commit
   exists on the remote or that CI is green; a failure is discovered on the host.

## 3. Target architecture

```text
WebUI: settings.upgrades (repository status, App account, CI, existing upgrade flow)
        |  oRPC admin.repository.*  admin.github.*
        v
apps/server
  RepositoryService    --> GitCli                     (packages/coding/src/git.ts)
  GitHubCliService    --> gh auth login/status/token/logout (GH_CONFIG_DIR=<dataDir>/gh)
  GitHubService       --> REST over fetch with `gh auth token`
        |                  (api.github.com or TSUKAIMA_GITHUB_API_URL)
        |
        +--> governed writes --> ApprovalGate (packages/coding/src/approval.ts) + audit
        `--> plugin binding  --> plugins/github (coding-scoped tools)
```

Layering rules:

- **`packages/coding/src/git.ts`** (new file, no new workspace) owns the only `git` spawn in the
  codebase: fixed binary resolution, argv arrays, never a shell, a per-call environment, timeout,
  and output cap. Host git keeps the operator environment (ssh agent socket, `HOME`, credential
  helpers) because these commands are never model-influenced; a call that holds a short-lived
  credential passes it through that one invocation's environment. `assertSafeBaseRef` stays the
  validator for model-supplied refs, and `SCRUBBED_COMMAND_ENV` still governs the runner that a
  model can reach.
- **`RepositoryService`** (`apps/server/src/services/repository-service.ts`) is the read model plus
  the safe write surface. It is host code because the upgrade center needs it.
- **`GitHubService`** is host code and speaks REST over `fetch` (see D2).
- **`plugins/github`** is thin: it registers coding-scoped agent tools against a host binding,
  exactly like `SELF_ITERATION_HOST_BINDING`. No git or token logic lives in a plugin.

## 4. Decisions

| # | Decision | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Where git plumbing lives | New `packages/coding/src/git.ts`; refactor both existing call sites | Keeps the existing package boundary; the repo expects one shared primitive, not a third copy. A separate `packages/git` matters only if a consumer outside `coding` appears. |
| D2 | GitHub access in the server | REST over `fetch`, base `TSUKAIMA_GITHUB_API_URL` default `https://api.github.com`; the bearer token comes from `gh auth token` | `gh` owns the login/refresh lifecycle, while REST stays typed and testable with a fake. |
| D3 | Credential model | GitHub CLI user login with `repo` scope | No GitHub App registration, no App ID, no installation ID, and no private key to paste. |
| D4 | Where the credential lives | `GH_CONFIG_DIR=<dataDir>/gh`, created `0700`; login uses `gh --insecure-storage` so a headless container writes `hosts.yml` instead of relying on a keyring | `<dataDir>` is the persistent volume and stays out of git. The token is never returned by an RPC. |
| D5 | Token lifetime | `gh` refreshes its own token; the server calls `gh auth token` per use and never caches the value | Avoids a second expiry model and keeps the token out of server memory between calls. |
| D6 | How `git` authenticates | Per-invocation env only: `GIT_CONFIG_COUNT/KEY/VALUE` inline credential helper returning `x-access-token` plus the token from `gh auth token`, and `GH_TOKEN` | No token in argv, `.git/config`, a credentials file, or a log line. |
| D7 | Status placement | Existing upgrade center | Chosen by the operator; no new nav entry. |
| D8 | Server push rights | Granted via `contents: write`, still gated by the policy flag `allowPush`, default false, enabled once in the UI | Chosen by the operator. The App permission is necessary but not sufficient: a protected branch or a disabled policy still denies. |
| D9 | Repository scope | One repository: the checkout the server runs in, resolved from its `origin` remote | Multi-repository management is a follow-up, not this spec. |
| D10 | Repo root | Add `TSUKAIMA_REPOSITORY_ROOT`, defaulting to `process.cwd()` | Needed once tools run in worktrees and the API reports a path. |
| D11 | `gh` CLI | Runtime credential owner and workstation/deploy tool: login, status, token, logout, `ops:status`, preflight, optional release | The CLI already ships GitHub's OAuth client and token refresh, which removes the custom App setup. |

## 5. Contracts

All new wire types go in `packages/contracts` (no second API shape) and every consumer is updated in
the same change.

```ts
repositoryStatusSchema: {
	branch: string | null;          // null on detached HEAD
	upstream: { remote: string; ref: string; ahead: number; behind: number } | null;
	head: { commit: string; subject: string; authoredAt: string };
	dirty: { modified: number; untracked: number; staged: number; conflicted: number };
	remotes: { name: string; fetchUrl: string; pushUrl: string }[];
	worktrees: { path: string; branch: string | null; head: string; locked: boolean }[];
	tags: { name: string; commit: string }[];   // bounded, newest first
	version: string;                             // VERSION at HEAD
	pushed: boolean;                             // HEAD is reachable from the upstream ref
}

githubStatusSchema: {
	available: boolean;                          // false when the image lacks gh
	configured: boolean;
	host: string;
	login: string | null;
	scopes: string[];
	gitProtocol: string | null;
	error: string | null;
}

githubLoginStartSchema: {
	expiresAt: string;
	userCode: string;
	verificationUri: string;
}

githubLoginPollSchema: {
	status: "idle" | "pending" | "authorized" | "expired" | "failed";
	login?: string;
	message?: string;
}

githubPullRequestSchema: { number: number; title: string; state: "open" | "closed" | "merged";
	head: string; base: string; draft: boolean; mergeable: "clean" | "dirty" | "unknown";
	url: string; checks: "pending" | "success" | "failure" | "none" }
githubRunSchema: { id: number; name: string; status: string; conclusion: string | null;
	headSha: string; url: string; createdAt: string }
```

RPC (admin-only, behind the existing admin auth), added to `apps/server/src/rpc/admin.ts` next to
`admin.upgrade.*`:

- `admin.repository.status`, `.branches`, `.log`, `.diff` — read-only.
- `admin.repository.fetch`, `.checkout`, `.pull` — refuse a dirty tree where relevant.
- `admin.repository.push` — requires the branch policy to allow it.
- `admin.github.status`, `.loginStart`, `.loginPoll`, `.logout`, `.pulls`, `.issues`, `.runs`.

## 6. Credentials

**Login** (upgrade center card): click "Sign in with GitHub CLI". The server spawns
`gh auth login --hostname <host> --git-protocol https --web --clipboard=false --insecure-storage`
and parses the one-time code from the CLI output. The UI shows the code and verification URL and
polls `admin.github.loginPoll`; `gh` performs the actual device flow. No OAuth App, Client ID, App
ID, installation ID, or private key is involved.

**Store**: `GH_CONFIG_DIR=<dataDir>/gh`, created with mode 0700. `gh` writes `hosts.yml` there with
mode 0600. `data/` is already gitignored, so neither the session nor the token enters the working
tree.

**Use**: `GitHubCliService.status()` runs `gh auth status --json hosts --hostname <host>` and
returns only login, scopes, protocol, host, and an error string. `token()` runs
`gh auth token --hostname <host>` for the single git or REST call that needs it; `gh` refreshes an
expiring token itself. Logout runs `gh auth logout --hostname <host> --user <login>`.

**Never**: return a token from any RPC, or write one into `.git/config`, a credentials file, an
argv array, a log line, or a prompt.

**Failure modes** surfaced verbatim: `gh` is absent from the image, no host is signed in, login
exits before printing a code, the device code expires, and `gh auth status` cannot reach GitHub.

**Scopes**: `gh auth login` requests its standard `repo`, `read:org`, and `gist` scopes. The
deployment repository's branch protection still applies to the user's token.

## 7. Governance

- **Reads** (status, log, diff, and PR, issue, and CI reads) are allowed from the admin UI and from
  coding sessions.
- **Writes** (push, branch delete, PR create or merge, release) require an `ApprovalGate` record and
  emit an audit entry through the existing `writeAudit` surface. The approval UI reuses the
  deployment approval card pattern.
- **Policy**, a default-deny list in `settings.policies`: allowed remote names, allowed branch
  prefixes, protected branches (`main` plus the upgrade remote default branch), and `allowPush`
  (default false; the operator enables it once because this deployment needs push).
- **Chat separation**: git and GitHub tools register coding-scoped
  (`allowedTaskKinds: ["coding"]`, `requiredConversationCapabilities: ["coding"]`) exactly like
  the native Pi workspace runner. Ordinary IM conversations never receive them.
- **Model-supplied input** (branch names, refs, PR titles and bodies, search strings) is validated
  with the existing `assertSafeBaseRef`-style rules and length caps before it reaches git or HTTP.
- **Sandbox**: GitHub and git calls run host-side, outside bubblewrap, with the scrubbed env, the
  same trust position as `UpgradeService` today. Model-influenced arbitrary command execution stays
  confined to the existing governed runner.
- **Identity consequence**: pushes and API writes act as the signed-in GitHub user. Commit trailers
  and PR bodies must say the runtime performed the action; the audit trail is the authority, not
  the GitHub author field.

## 8. Deployment integration

- `tools/ops/status.ts` plus `bun run ops:status`: print branch, upstream, ahead/behind, dirty
  state, HEAD, the PR containing HEAD, and the CI conclusion, using the workstation `gh`.
- `ops/deploy/deploy.sh` preflight: `gh auth status`, the pushed commit exists on the remote, and
  the local branch is not behind, with an actionable message instead of a host-side discovery.
- Optional `DEPLOY_RELEASE=1`: create the matching `vX.Y.Z` tag and GitHub release after a
  successful deploy. The docs currently state that no tag or release workflow is required; this
  makes releases opt-in rather than mandatory.
- The runtime needs outbound HTTPS to `api.github.com` and the git remote. Document the egress
  requirement and the degraded mode: repository status still renders locally, GitHub cards report
  unreachable instead of failing the page.
- Non-goal for now: deploying from GitHub Actions. It is a follow-up decision, not this spec.

## 9. Phases

Phase 1 and phase 2 are implemented with `gh` as the credential owner; the governed write and
release phases are not.

**Phase 1 — git read model.** `GitCli` in `packages/coding`, `WorktreeManager` and `UpgradeService`
refactored onto it, `RepositoryService`, `repositoryStatusSchema`, `TSUKAIMA_REPOSITORY_ROOT`, admin
RPC reads, and a repository status card in the upgrade center. Acceptance: status matches
`git status --porcelain=v2 --branch` on a fixture repository, and a detached HEAD, a repository with
no remote, and a dirty tree all render without throwing.

**Phase 2 — GitHub CLI and CI.** `GitHubCliService` (login, poll, status, token, logout),
`GitHubService` reads (PRs, issues, runs), the login/status card and the CI card in the upgrade
center, `ops:status`, and the deploy preflight. Acceptance: a missing `gh`, a signed-out host, an
expired device code, and an exit before the code each produce a distinct actionable error; no RPC
response contains a token; login and status are covered by injected exec/process tests.

**Phase 3 — governed writes.** Approval-gated push, branch create and switch, PR create and merge,
and `plugins/github` with coding-scoped tools, plus the policy entries. Acceptance: `allowPush`
false and a protected branch both deny; each denial records an audit entry; a chat conversation
cannot see the tools.

**Phase 4 — release automation.** `vX.Y.Z` tag and release on deploy, and a decision record on
deploying from GitHub Actions.

## 10. Testing

- No test may require network, a real GitHub account, or `gh`. Inject the exec function and `fetch`,
  and assert argv and environment rather than shelling out.
- Git fixtures are temporary repositories created with `git init` under `os.tmpdir()`, cleaned up in
  `finally` blocks, following `packages/coding/tests/helpers.ts`. Remotes use placeholders such as
  `<repo-url>` and `example.test`.
- CLI tests inject the `gh` exec function and the login child process, asserting argv and
  environment rather than shelling out.
- Synthetic identities only, per [privacy.md](../operations/privacy.md): no real owner, repository,
  login, hostname, token, or PR text in fixtures.
- Cover: missing `gh`, signed-out status, login code parsing across chunks, login expiry, logout of
  one account, token redaction from every response, `allowPush` denial, protected-branch denial,
  detached HEAD, a missing upstream, a non-fast-forward pull, and restart-safe reads.

## 11. Risks and non-goals

- The `gh` token sits on the data volume in `hosts.yml`; `gh` writes it 0600 inside a 0700
  directory. Acceptable for a single-host deployment; OS keyring or encryption at rest is a
  separate decision.
- A user token cannot bypass branch protection or required reviews. If the deployment branch
  requires review, the server must open a PR instead of pushing, and the policy should encode that
  rather than rely on a runtime error.
- Non-goals: hosting a GitHub App for other users, Gitea or Forgejo adapters, a custom OAuth login,
  merge-conflict resolution in the UI, and reading `.env` or deployment credentials from the
  repository.

## 12. Remaining follow-ups

1. Multi-account or multi-repository management (D9 keeps one for now).
2. Whether commits made through the signed-in user need a distinct audit marker beyond the
   existing audit entry.
