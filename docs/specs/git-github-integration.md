# Git and GitHub operations

Status: decided, ready to implement. Owner surface: `apps/server` services, `packages/contracts`,
the upgrade center in the admin WebUI.

This spec makes the repository itself a first-class object of the running system: branch, upstream,
working-tree state, remotes, and the GitHub App installation plus pull requests, issues, and CI are
readable and (where policy allows) operable from the WebUI and from governed workspace sessions.

The deploy path already requires a clean committed branch and a pushable remote
([deployment.md](../operations/deployment.md)), but the running server cannot answer "what revision
am I on, is it pushed, is it green?". This closes that loop.

## 0. Decided

| Question | Decision |
| --- | --- |
| Does the server need push rights? | Yes. The installation token carries `contents: write` and the server may push. |
| Credential type | GitHub App with installation tokens, not a PAT. No user login, no `gh auth login`. |
| Device flow | No. `TSUKAIMA_GITHUB_OAUTH_CLIENT_ID` is not used; the operator configures the App instead. |
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
3. **No GitHub integration at all.** No installation, no PR, issue, CI, or release reads, no writes.
4. **No credential surface.** Runtime settings are explicitly non-secret and plugin secrets are
   per-plugin. Nothing owns the host-level credential that `git push` and the GitHub API both need.
5. **`gh` is not usable as-is in the runtime.** It is absent from the image (the `Dockerfile`
   installs `git`, `curl`, and `ripgrep`, not `gh`), its keyring-backed token store is unreliable
   headless, and observed directly here: `gh auth status` failed with `Timeout trying to log in to
   github.com ... (keyring)` before succeeding on retry. It also has no first-class way to sign
   GitHub App JWTs. It stays a workstation and deploy tool.
6. **Deploy has no GitHub preflight.** `ops/deploy/deploy.sh` never checks that the pushed commit
   exists on the remote or that CI is green; a failure is discovered on the host.

## 3. Target architecture

```text
WebUI: settings.upgrades (repository status, App account, CI, existing upgrade flow)
        |  oRPC admin.repository.*  admin.github.*
        v
apps/server
  RepositoryService    --> GitCli                     (packages/coding/src/git.ts)
  GitHubAppService     --> App config + private key   (meta row + <dataDir>/secrets 0600)
        `--> InstallationTokenProvider --> JWT RS256 --> installation token (cached 1 h)
  GitHubService        --> REST over fetch            (api.github.com or TSUKAIMA_GITHUB_API_URL)
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
| D2 | GitHub access in the server | REST over `fetch`, base `TSUKAIMA_GITHUB_API_URL` default `https://api.github.com` | `gh` cannot sign App JWTs, is not in the image, and its keyring store is unreliable headless. `fetch` is testable with a fake and needs no new dependency. |
| D3 | Credential model | GitHub App: App ID, installation ID, PEM private key (PKCS#1 or PKCS#8) | Chosen by the operator. Gives short-lived per-installation tokens and independent revocation. |
| D4 | Where the credential lives | Private key file `<dataDir>/secrets/github-app.pem` mode 0600; App ID and metadata in the `meta` row `github-app` | `<dataDir>` is the persistent volume and stays out of git. The PEM is never returned by an RPC, only a SHA-256 fingerprint. |
| D5 | Token lifetime | Mint installation tokens on demand, cache until five minutes before expiry | Installation tokens expire after one hour; a stale cached token must never be reused. |
| D6 | How `git` authenticates | Per-invocation env only: `GIT_CONFIG_COUNT/KEY/VALUE` inline credential helper returning `x-access-token` plus the token, and `GH_TOKEN` | No token in argv, `.git/config`, a credentials file, or a log line. |
| D7 | Status placement | Existing upgrade center | Chosen by the operator; no new nav entry. |
| D8 | Server push rights | Granted via `contents: write`, still gated by the policy flag `allowPush`, default false, enabled once in the UI | Chosen by the operator. The App permission is necessary but not sufficient: a protected branch or a disabled policy still denies. |
| D9 | Repository scope | One repository: the checkout the server runs in, with the App installation that reaches it | Multi-installation management is a follow-up, not this spec. |
| D10 | Repo root | Add `TSUKAIMA_REPOSITORY_ROOT`, defaulting to `process.cwd()` | Needed once tools run in worktrees and the API reports a path. |
| D11 | `gh` CLI | Workstation and deploy scripts only: `ops:status`, preflight, optional release | Keeps the runtime dependency-free and avoids the headless keyring problem. |

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

githubAppStatusSchema: {
	configured: boolean;
	appId?: number;
	installationId?: number;
	account?: string;                            // installation account login
	permissions?: Record<string, string>;        // contents write, pull_requests write, ...
	keyFingerprint?: string;                     // SHA-256 of the PEM, never the PEM
	tokenExpiresAt?: string;
	repositorySelection?: "all" | "selected";
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
- `admin.github.status`, `.configure`, `.clear`, `.pulls`, `.issues`, `.runs`.

## 6. Credentials

**Configure** (upgrade center card): paste the App ID, installation ID, and the private key. GitHub
downloads it as PKCS#1 (`BEGIN RSA PRIVATE KEY`) and the signer accepts PKCS#8 as well.
The host validates by signing a JWT, calling `GET /app/installations/{id}`, and listing
`GET /installation/repositories`, then records the account login, permissions, and repository
selection for display.

**Store**: the `meta` row `github-app` holds `{ appId, installationId, account, permissions,
keyFingerprint, addedAtMs }`. The PEM is written to `<dataDir>/secrets/github-app.pem` with mode
0600 inside a 0700 directory. `data/` is already gitignored, so the key never enters the working
tree and `bun run check:secrets` never sees it.

**Use**: `InstallationTokenProvider` signs an RS256 JWT with `node:crypto` (`iss` is the App ID,
`iat` is now minus 60 s, `exp` is now plus 9 min), exchanges it at
`POST /app/installations/{id}/access_tokens`, caches `{ token, expiresAtMs }`, and refreshes when
less than five minutes remain. `git` and the REST client receive the token through that call's
environment only.

**Never**: return the PEM or a token from any RPC, or write either into `.git/config`, a
credentials file, an argv array, a log line, a prompt, or a database row other than the
fingerprint.

**Failure modes** surfaced verbatim: missing key, malformed PEM, JWT rejected with 401 (usually
clock skew), installation not found with 404, installation lacking `contents: write`, and rate
limiting with 403 plus `x-ratelimit-remaining: 0`.

**Recommended App permissions**, documented in the card and in
`docs/operations/deployment.md`: `metadata: read`, `contents: write`, `pull_requests: write`,
`issues: write`, `actions: read`, with repository selection limited to the deployment repository.

## 7. Governance

- **Reads** (status, log, diff, and PR, issue, and CI reads) are allowed from the admin UI and from
  coding sessions.
- **Writes** (push, branch delete, PR create or merge, release) require an `ApprovalGate` record and
  emit an audit entry through the existing `writeAudit` surface. The approval UI reuses the
  self-iteration approval card pattern.
- **Policy**, a default-deny list in `settings.policies`: allowed remote names, allowed branch
  prefixes, protected branches (`main` plus the upgrade remote default branch), and `allowPush`
  (default false; the operator enables it once because this deployment needs push).
- **Chat separation**: git and GitHub tools register coding-scoped
  (`allowedTaskKinds: ["coding"]`, `requiredConversationCapabilities: ["coding"]`) exactly like
  `plugins/self-iteration`. Ordinary IM conversations never receive them.
- **Model-supplied input** (branch names, refs, PR titles and bodies, search strings) is validated
  with the existing `assertSafeBaseRef`-style rules and length caps before it reaches git or HTTP.
- **Sandbox**: GitHub and git calls run host-side, outside bubblewrap, with the scrubbed env, the
  same trust position as `UpgradeService` today. Model-influenced arbitrary command execution stays
  confined to the existing governed runner.
- **Identity consequence**: an App commits and opens PRs as `<app-name>[bot]`, not as the operator.
  Commit trailers and PR bodies must say so; the audit trail is the authority, not the GitHub
  author field.

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

Phase 1 and phase 2 are implemented (App credentials plus an optional `gh`-style user sign-in);
the governed write and release phases are not.

**Phase 1 — git read model.** `GitCli` in `packages/coding`, `WorktreeManager` and `UpgradeService`
refactored onto it, `RepositoryService`, `repositoryStatusSchema`, `TSUKAIMA_REPOSITORY_ROOT`, admin
RPC reads, and a repository status card in the upgrade center. Acceptance: status matches
`git status --porcelain=v2 --branch` on a fixture repository, and a detached HEAD, a repository with
no remote, and a dirty tree all render without throwing.

**Phase 2 — GitHub App and CI.** `GitHubAppService` (configure, validate, store, clear),
`InstallationTokenProvider`, `GitHubService` reads (installation, PRs, issues, runs), the account
card and the CI card in the upgrade center, `ops:status`, and the deploy preflight. Acceptance: an
invalid App ID, a malformed PEM, and an installation without `contents: write` each produce a
distinct actionable error; no RPC response contains the PEM or a token; token refresh at the expiry
boundary is covered by a test with a generated key.

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
- App tests generate an RSA key pair in-process and serve a fake
  `POST /app/installations/{id}/access_tokens`, asserting the JWT payload (`iss`, `iat`, `exp`) and
  the cache refresh boundary without touching the real API.
- Synthetic identities only, per [privacy.md](../operations/privacy.md): no real owner, repository,
  installation ID, hostname, or PR text in fixtures.
- Cover: invalid App credentials, a missing permission, token caching and refresh, redaction of the
  PEM and token from every response and log line, `allowPush` denial, protected-branch denial,
  detached HEAD, a missing upstream, a non-fast-forward pull, and restart-safe reads.

## 11. Risks and non-goals

- The PEM sits on the data volume as plaintext with mode 0600. Acceptable for a single-host
  deployment; OS keyring or encryption at rest is a separate decision.
- An installation token cannot bypass branch protection or required reviews. If the deployment
  branch requires review, the server must open a PR instead of pushing, and the policy should
  encode that rather than rely on a runtime error.
- Non-goals: hosting a GitHub App for other users, Gitea or Forgejo adapters, browser OAuth login,
  merge-conflict resolution in the UI, and reading `.env` or deployment credentials from the
  repository.

## 12. Remaining follow-ups

1. Multi-installation or multi-repository management (D9 keeps one for now).
2. Whether `github-app` moves from the `meta` row to a typed table once it grows beyond App ID,
   installation ID, and metadata.
