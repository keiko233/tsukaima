# Docker deployment

Deployment is environment-driven. Any clone or fork can deploy any branch it can push; the
repository does not contain a production host, SSH user, IP address, internal hostname, deployment
path, Docker network name, or public URL.

Related documents:

- [Production runbook](runbook.md)
- [Privacy and synthetic data](privacy.md)
- [Workspace and hooks architecture](../architecture/workspace-and-hooks.md)
- [Quality gates](quality.md)

## 1. Topology

```text
workstation checkout ──push──▶ origin/<deployment-branch>
        │                                  │
        └──────── ssh ────────▶ deployment host <deployment-root>/repo
                                           │
                                           ▼
                              Docker image + persistent data volume
```

The deployment host needs Docker with Compose v2, Git, `sqlite3`, and an SSH key accepted by its
`sshd`. The standard scripts also use `curl` and standard GNU userland tools. The host does not
need Bun installed; builds and the runtime use the image.

Choose these values yourself and keep them out of Git:

| Value | Example placeholder | Purpose |
| --- | --- | --- |
| SSH target | `<ssh-target>` | Any reachable `user@host` or SSH config alias |
| Repository URL | `<repo-url>` | Clone URL the host can read |
| Deployment branch | `<branch>` | Branch you push and want the host to run |
| Deployment root | `/opt/tsukaima` (default) | Persistent host directory; override with `ROOT` |
| Public origin | `<public-origin>` | Exact browser origin, such as `https://chat.example.com` |
| Docker network | `tsukaima` (default) | Existing or newly created external Compose network |

Use reserved example domains such as `example.com` and `example.test` in public documentation.
Never put a real deployment coordinate in a test, fixture, screenshot, or commit.

## 2. Version policy

`VERSION` and every workspace `package.json` version move together. Every deployment must increase
`VERSION` according to [Semantic Versioning 2.0.0](https://semver.org/). The deployer compares the
new strict SemVer value with the last successfully deployed source version and refuses an equal or
lower value. Build metadata alone is not a bump because SemVer ignores it for precedence.

Release tags, GitHub releases, and `CHANGELOG.md` are produced by the
[publish workflow](publishing.md), not by hand. Publish first, then deploy the release commit.

Examples:

| Change | Next version |
| --- | --- |
| Bug fix or deployment-only change | `PATCH` bump, for example `0.2.0` → `0.2.1` |
| Compatible feature | `MINOR` bump, for example `0.2.1` → `0.3.0` |
| Incompatible change | `MAJOR` bump |
| Prerelease | Valid strict SemVer, for example `0.3.0-rc.1` |

Bump before committing the deployable revision:

```sh
bun run version:bump 0.2.1
bun run check:version
git diff -- VERSION apps packages plugins tools
```

`VERSION` must not include a leading `v`. The image is tagged with the strict version; Docker tags
cannot contain SemVer build metadata's `+`, so an image tag replaces `+` with `_`. The commit is
recorded in image labels and the deployment JSON. No Git tag or registry release workflow is
required. When a deployment proposal was applied as an uncommitted diff, the build must also
record `TSUKAIMA_PATCH_SHA256` (the approved proposal's `diffChecksum`); a commit label alone is
the base revision and cannot prove the patch is live. Without both labels, a restarted deployment
settles `manual_apply_required` rather than `deployed`. `ops/deploy/deploy.sh` only forwards a
checksum the operator supplies in its environment; it never derives one from the proposal, because
that would prove the proposal's text rather than the image's contents.

The first deployment has no previous source version and may use the current value. Every
subsequent deployment must be higher. Rollback restores a previous image; it is recovery, not a
new deployment, and does not need a version bump. The next forward deployment still must exceed
the highest successfully deployed source version.

## 3. Host bootstrap

The bootstrap reads `REPO_URL` and `PUBLIC_URL` from the environment and refuses to create a
deployment without a public origin. `DEPLOY_BRANCH` defaults to `main`.

```sh
ssh <ssh-target> \
  'REPO_URL=<repo-url> PUBLIC_URL=<public-origin> DEPLOY_BRANCH=<branch> bash -s' \
  < ops/deploy/bootstrap-host.sh
```

The first run may print an SSH deploy key and stop. Add that public key to the repository with read
access, then run the same command again. HTTPS clone URLs skip the deploy-key prompt.

The bootstrap creates or configures:

| Path or setting | Purpose |
| --- | --- |
| `<deployment-root>/repo` | Repository checkout on the configured branch |
| `<deployment-root>/data` | Container data mount, owned by uid/gid 1000 |
| `<deployment-root>/secrets/runtime.env` | Auth secret and initial administrator, mode 0600 |
| `<deployment-root>/secrets/initial-admin-password.txt` | Generated first password, mode 0600 |
| `<deployment-root>/backups` | Pre-deploy data archives, three retained |
| `<deployment-root>/deployments` | Deployment records |
| `<deployment-root>/compose.yaml` | Symlink to the committed `compose.yaml` |
| `<deployment-root>/.env` | Non-secret Compose and deployment settings |

The external Docker network defaults to `tsukaima`; override it with
`DOCKER_NETWORK=<existing-network>`. The app container joins that network and binds
`TSUKAIMA_BIND_ADDR` (default `127.0.0.1`). Put a reverse proxy in front of it, or set
`TSUKAIMA_BIND_ADDR=0.0.0.0` only when direct exposure is intended.

Existing installations that previously relied on a hard-coded external network should add
`TSUKAIMA_DOCKER_NETWORK=<existing-network>` to their deployment `.env`, or attach the reverse
proxy to the new `tsukaima` network before the first upgraded deployment.

### Optional Caddy integration

Caddy automation is opt-in via `CADDYFILE`. The bootstrap generates the site block from
`PUBLIC_URL`:

```sh
ssh <ssh-target> \
  'REPO_URL=<repo-url> PUBLIC_URL=<public-origin> DEPLOY_BRANCH=<branch> \
   CADDYFILE=/etc/caddy/Caddyfile CADDY_CONTAINER=<caddy-container> bash -s' \
  < ops/deploy/bootstrap-host.sh
```

The script backs up the Caddyfile, appends a managed block, connects the Caddy container to the
deployment network when needed, and reloads Caddy. If Caddy runs outside Docker, configure the
reverse proxy manually. Do not commit host-specific Caddy files.

## 4. Move development data

Stop any local process writing the source databases first. The script snapshots SQLite with
`.backup`, copies blobs, stops only the remote app container, and transfers the staging directory.

```sh
bash ops/deploy/copy-dev-data.sh \
  --source apps/server/data \
  --host <ssh-target> \
  --root <deployment-root>
```

`--host` or `HOST` is required. The source data may contain chat content and credentials from your
local environment; never commit it, upload it to a public artifact store, or use it as a test
fixture.

## 5. Deploy

Push a committed, clean branch and deploy that exact revision:

```sh
HOST=<ssh-target> ROOT=<deployment-root> DEPLOY_BRANCH=<branch> bun run ops:deploy
```

Before pushing, the script verifies:

1. `HOST` and the current branch are set.
2. The worktree is clean.
3. `VERSION` is strict SemVer and higher than `<deployment-root>/.deploy/current-source-version`
   on the host, when present.

The host-side deployer repeats the version check, fetches the branch, fast-forwards to
`origin/<branch>`, and then:

1. Builds `tsukaima:<version>-<sha>` from that revision.
2. Reuses the dependency image prepared for the current lockfile and workspace manifests.
3. Stops the previous container only after the new image build succeeds.
4. Archives `data` before starting the new image.
5. Polls `/readyz`; on failure it prints logs and restores the previous image.
6. Records the source version, image, commit, branch, deployer, and previous image under
   `<deployment-root>/deployments`.

The branch is whatever the operator chooses. There is no repository-owner, fork, or mainline
special case in the deploy scripts.

For host-local Compose settings, the deploy script also reads `<deployment-root>/compose.override.yaml`
when present. To enable isolated Workspace commands, set `TSUKAIMA_CODING_SANDBOX=bubblewrap`
and verify that the container's security policy allows Bubblewrap to create its namespaces.
Validate the profile on a disposable container before applying it to the service.

Dependency preparation can run ahead of time:

```sh
cd <deployment-root>/repo
bash ops/deploy/prepare-deps.sh
```

## 6. Verification and rollback

```sh
curl -fsS http://127.0.0.1:7420/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/readyz
curl -fsS <public-origin>/healthz
```

Sign in with the bootstrap administrator and change the generated password in the UI. The password
file is `<deployment-root>/secrets/initial-admin-password.txt`.

Rollback is an image swap:

```sh
cat <deployment-root>/.deploy/current-image
ls -1t <deployment-root>/backups/data-*.tgz | head
# Edit TSUKAIMA_IMAGE in <deployment-root>/.env to the previous tag, then:
docker compose \
  -f <deployment-root>/compose.yaml \
  --project-directory <deployment-root> up -d
```

If a schema migration must be undone, stop the container, restore the matching data archive, and
start the previous image. Never restore data under a newer schema.

## 7. Workspace and deployment boundary

The container runs the native Pi workspace agent in worktree mode. The image includes the
repository `.git` at `/app`, and worktrees live under `/data/worktrees`; each new worktree gets a
`node_modules` symlink back to the image install. It has `git`, `bun` (including `bunx`), and
`ripgrep`, but no Docker socket and no host checkout, so a proposal cannot replace the running
image.

The runtime image keeps the workspace dev dependencies (Vite, Tailwind, TanStack Router, Paraglide)
and the native build toolchain (compiler, Python, Cairo/Pango headers) on purpose: an in-container
upgrade installs updated packages and rebuilds `@tsukaima/web` without an external
`FORCE_DEPS=1 bash ops/deploy/deploy.sh` redeploy.

`TSUKAIMA_CODING_SANDBOX` chooses the execution boundary for model-influenced commands:

- `host` (default) runs allowlisted commands (`bun`, `git`, `rg`) directly in the container with a
  scrubbed environment, a worktree-only working directory, timeouts, and bounded output. This is
  the governed executor used by the Compose deployment: Docker's default seccomp profile blocks
  the namespace syscalls bubblewrap needs, and `security_opt: seccomp=unconfined` would relax
  syscall filtering for the whole container (plugins, channel adapters, model SDKs). `host` keeps
  the command, path, and environment governance but cannot hide unrelated files or the network
  from a malicious repository script.
- `bubblewrap` adds OS-level isolation: all namespaces are unshared (loopback-only network), the
  environment is cleared, the repository root is an empty directory, and only the worktree plus an
  explicit `node_modules`/git-metadata mount set is readable or writable. Use it on a
  namespace-capable runtime when the additional isolation matters.

Promote a proposal by applying it to the deployment branch, bumping `VERSION`, committing, and
running `bun run ops:deploy`. The host build remains the only path that replaces the running image.
The container's `.git` is replaced with each image, so durable work belongs in the proposal record
or a commit, not in a container worktree.

## 8. Upstream upgrades from Settings

Settings → Upgrades compares the checkout with `TSUKAIMA_UPGRADE_REMOTE` (default `origin`) and
the current branch. The server fetches that remote and shows ahead/behind counts, the current and
upstream `VERSION`, and the chosen path:

- A clean checkout with no local commits merges with `--ff-only` and schedules the standard
  one-minute update restart.
- A checkout with local commits creates a governed workspace. The server merges the upstream ref
  in the workspace worktree, derives the patch and snapshot, and records a proposal; finalize
  merges the reviewed commit back with `--no-ff` only after re-verifying that proposal.
- Uncommitted changes are never merged automatically. Commit or discard them first.

Finalize first verifies that the live checkout is still on the recorded branch and commit, is
clean, and that the upstream target commit is an ancestor of the workspace HEAD. It also
re-derives the proposal patch and worktree snapshot, rejects stale or unverified evidence, and
leaves an uncommitted workspace untouched. Only after those checks is the pending proposal marked
approved and the exact reviewed commit merged into the live checkout. This changes the source
checkout only; the host-side image build and container replacement remain operator-controlled as
described above.

Before the scheduled restart, the runtime installs dependencies (including devDependencies) and
rebuilds `@tsukaima/web` into a staging directory that is swapped in atomically. If preparation
fails after a merge, the live checkout is reset to the recorded commit so "Check for updates"
does not falsely report `up_to_date`. `/healthz` reads the live `VERSION` file from the checkout
first, so it reports the newly upgraded version after a restart instead of the value baked into
the container. Routine upgrades therefore no longer need an external
`FORCE_DEPS=1 bash ops/deploy/deploy.sh` run.

Host preparation does not resolve merge conflicts and does not run repository checks. A conflict
fails the start before a proposal or live change exists. The proposal records the exact diff and
worktree snapshot with no fabricated check result; finalizing is the administrator's explicit
approval and never auto-approves a model-authored change.

The same card exposes `Fetch`, `Pull`, and `Push`. `Pull` is `--ff-only`, so a diverged branch fails
instead of creating a merge commit. `Push` is off unless `TSUKAIMA_ALLOW_PUSH=true`, and the UI asks
for a second confirmation before sending. When a GitHub CLI session exists the push credential is
the token returned by `gh auth token`, injected for the single invocation; an ssh remote or an
operator credential helper keeps working because the token is only added, never required.

The repository card also sets the **Git identity** used by the server: the author name and email on
merge commits it creates, and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for git commands inside governed
worktrees. It is stored in the domain database (not `.git/config`) and defaults to
`tsukaima-upgrade <tsukaima-upgrade@localhost>`, so a host without a global git identity can still
upgrade and commit.

## 9. GitHub CLI login

Settings → Upgrades shows the running checkout and, once a GitHub CLI session exists, the open pull
requests and the workflow runs for `HEAD`. The runtime image ships a pinned `gh` release
(`Dockerfile`, `GH_VERSION`), and the server delegates login, token lookup, refresh, status, and
logout to it.

Click **Sign in with GitHub CLI**. The server starts `gh auth login` with
`--hostname <host> --git-protocol https --web --clipboard=false --insecure-storage`, shows the
one-time code and verification URL, and polls until the CLI exits. No GitHub App, OAuth App, App ID,
installation ID, Client ID, or private key is needed.

The session lives in `<data>/gh` (`GH_CONFIG_DIR`), created `0700`; `gh` writes `hosts.yml` with
mode `0600`. The token is never written to the repository, returned by an API, or logged. The card
shows only the login, host, scopes, and protocol. **Sign out** removes the active account with
`gh auth logout --hostname <host> --user <login>`.

For a manual login from a shell, use the same config directory:

```sh
docker exec -it <container> env GH_CONFIG_DIR=/data/gh gh auth login --hostname github.com
```

For CI or a host without an interactive terminal, `gh auth login --with-token` reads a personal
access token from stdin. Treat that token like any other secret and do not add it to the
repository, `.env` files, or chats.

The container needs outbound HTTPS to the Git remote, to `github.com` for the device flow, and to
`TSUKAIMA_GITHUB_API_URL` (default `https://api.github.com`; use `https://<host>/api/v3` for
GitHub Enterprise Server). Without egress the local repository card still renders, while the
GitHub cards report the connection failure.

The token inherits the signed-in user's repository permissions, so it can push anywhere that user
can. Branch protection and required reviews still apply. Prefer a dedicated machine account or a
fine-grained token when the deployment repository is shared.

Older builds stored a GitHub App private key at `<data>/secrets/github-app.pem`. The current code
never reads it; remove that file after switching. The legacy `github-app` row in the domain
database is ignored and may remain.
