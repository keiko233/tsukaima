# Docker deployment

This repository is the mainline. Deployment policy depends on who owns the checkout:

- **Maintainers of `example-org/tsukaima`** deploy `main` directly.
- **Everyone else must fork** the repository, either locally or on GitHub, and deploy from a
  dedicated deployment branch that is rebased onto mainline `main`. Never deploy `main` from a
  fork.

The deployment scripts enforce this distinction. They compare the `origin` repository slug with
`MAINLINE_REPO` (default `example-org/tsukaima`) and refuse `main` when `origin` is not the
mainline repository.

Related documents:

- [Production runbook](runbook.md)
- [Self-iteration architecture](../architecture/self-iteration.md)
- [Quality gates](quality.md)

## 1. Topology

```text
maintainer checkout (main) ──push──▶ origin/main ──▶ host /opt/tsukaima/repo (main)

third-party fork (deploy/<name>) ──push──▶ fork/deploy/<name>
        ▲                                           │
        └──── rebase onto mainline/main ◀───────────┘
                                                    ▼
                                      host /opt/tsukaima/repo (deploy/<name>)
```

Both modes use the same host build and rollback path. Only the git branch policy differs.

## 2. Version authority

`VERSION` and every workspace `package.json` version are owned by the mainline repository.

- `bun run check:version` verifies that all workspace manifests agree with `VERSION`.
- A release is a mainline commit tagged `vX.Y.Z` where `VERSION` is `X.Y.Z`.
- A commit that is not exactly at a release is built as `tsukaima:<version>-<short-sha>`.
- Third-party forks should not edit `VERSION` or workspace versions. Rebase onto mainline to pick
  up release changes, then deploy the resulting commit with its short-commit suffix.

## 3. Host bootstrap

The target host needs Docker with Compose v2, Git, `sqlite3`, and the `tsukaima` Docker network.
The default target is `<ssh-target>`, root directory `/opt/tsukaima`.

### Maintainers

```sh
ssh <ssh-target> \
  'DEPLOYER=example-user REPO_URL=git@github.com:example-org/tsukaima.git DEPLOY_BRANCH=main bash -s' \
  < ops/deploy/bootstrap-host.sh
```

### Third-party forks

First publish the deployment branch to a repository the host can read:

```sh
# GitHub fork: origin is your fork.
git remote add mainline https://github.com/example-org/tsukaima.git
git fetch mainline main
git switch -c deploy/<name> mainline/main
git push -u origin deploy/<name>

# Local-only fork: create a separate writable bare repository or clone and point origin at it.
# The deployment host must be able to clone that URL.
```

Then bootstrap the host against the fork's deployment branch:

```sh
ssh <ssh-target> \
  'DEPLOYER=<name> REPO_URL=git@github.com:<you>/tsukaima.git DEPLOY_BRANCH=deploy/<name> bash -s' \
  < ops/deploy/bootstrap-host.sh
```

If the host deploy key is not authorized yet, add it to the fork with write access and re-run the
same bootstrap command.

The bootstrap creates:

| Path | Purpose |
| --- | --- |
| `/opt/tsukaima/repo` | repository checkout on the configured deployment branch |
| `/opt/tsukaima/data` | mounted at `/data` in the container, owned by uid 1000 |
| `/opt/tsukaima/secrets/runtime.env` | auth secret and admin bootstrap, mode 0600 |
| `/opt/tsukaima/secrets/initial-admin-password.txt` | generated first password, mode 0600 |
| `/opt/tsukaima/backups` | pre-deploy data archives, three retained |
| `/opt/tsukaima/deployments` | JSON deployment records |
| `/opt/tsukaima/compose.yaml` | symlink to the committed `repo/compose.yaml` |
| `/opt/tsukaima/.env` | image tag, version, deployer, public URL, trusted browser origins |

It also adds an idempotent `app.example.test` block to `/opt/caddy/Caddyfile` and reloads Caddy when
that file exists. The container joins the external `tsukaima` network and binds only
`127.0.0.1:7420`; Caddy is the LAN entrypoint. Set `TSUKAIMA_BIND_ADDR=192.0.2.10` in
`/opt/tsukaima/.env` for direct LAN access.

## 4. Move development data

Stop the source app if it is running, then snapshot and copy the databases and blobs. The script
uses `sqlite3 .backup` so WAL contents are included and does not copy `*.pre-rename.bak` files.

```sh
bash ops/deploy/copy-dev-data.sh \
  --source apps/server/data \
  --host <ssh-target> \
  --root /opt/tsukaima
```

The remote app is stopped first. The deploy script starts the new image and the app runs embedded
migrations on boot. Keep the archive under `/opt/tsukaima/backups` until sign-in and channel tests
pass.

## 5. Deploy

### Maintainers: deploy `main`

```sh
git switch main
# edit, test, commit
bun run ops:deploy
```

Because `origin` is `example-org/tsukaima`, the script selects `main`, pushes it, and the host
fast-forwards to `origin/main`.

### Third-party forks: deploy a rebased branch

The deployment branch must be rebased onto mainline before every deploy:

```sh
git fetch mainline main
git switch deploy/<name>
git rebase mainline/main
# resolve conflicts, test, then:
DEPLOY_BRANCH=deploy/<name> bun run ops:deploy
```

If the checkout has no `mainline` remote yet:

```sh
git remote add mainline https://github.com/example-org/tsukaima.git
```

For a local-only fork, replace `origin` with the writable repository the host will clone. Keep the
mainline remote available for rebasing. Do not deploy `main` from the fork; the scripts reject it.

### What `ops:deploy` does

1. Refuses a dirty worktree.
2. Selects `main` only for the mainline repository; otherwise it uses `deploy/<deployer>` (or the
   explicit `DEPLOY_BRANCH`).
3. Pushes that branch to `origin`.
4. The host fetches `origin`, checks out the branch, and fast-forwards to `origin/<branch>`. If
   that revision changed `ops/deploy/deploy.sh`, the script re-executes itself so the rest of the
   run uses the revision it just checked out.
5. Reuses the prepared dependency image for the current `bun.lock` and workspace manifests,
   building it only when those changed. An ordinary image build therefore never runs `bun install`.
6. Builds `tsukaima:<version>-<sha>`. `node_modules` and the source tree are separate layers, so a
   code-only release re-exports a few megabytes instead of the whole tree.
7. Stops the old container only after the build succeeds, archives `data` (except logs), and starts
   the new image. The archive uses `pigz` when available; the media blob store is incompressible
   and single-threaded gzip dominated the stopped window.
8. Polls `/readyz`; on failure it prints container logs and restores the previous image.
9. Records the deployment under `/opt/tsukaima/deployments`, keeps the previous image, and retains
   three data archives for rollback. Dangling images and build cache unused for two weeks are
   reclaimed before the next build; recent cache (what keeps redeploys fast) and unrelated host
   images are never touched.

Dependency preparation can also run ahead of time, which is what keeps a deploy short:

```sh
# on the host; bootstrap-host.sh already does this on a fresh install
cd /opt/tsukaima/repo && bash ops/deploy/prepare-deps.sh
```

The script prints the image tag (`tsukaima-deps:<key>`). Re-run it after changing `bun.lock`, any
workspace `package.json`, or the dependency stage of the `Dockerfile`; `deploy.sh` does the same
automatically and reports `dependencies ready in Ns`.

## 6. Verification and rollback

```sh
curl -fsS http://127.0.0.1:7420/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/readyz
curl -fsS http://app.example.test/healthz
```

Sign in at `http://app.example.test` with the bootstrap administrator. The current `192.0.2.10`
deployment also binds `http://host.example.test:7420` because local DNS may not yet map `app.example.test`. The
password is in `/opt/tsukaima/secrets/initial-admin-password.txt`; change it in the UI after the
first login.

Rollback is an image swap, not a git rewrite:

```sh
cat /opt/tsukaima/.deploy/current-image
ls -1t /opt/tsukaima/backups/data-*.tgz | head
# Edit TSUKAIMA_IMAGE in /opt/tsukaima/.env to the previous tag, then:
docker compose -f /opt/tsukaima/compose.yaml --project-directory /opt/tsukaima up -d
```

If a schema migration must be undone, stop the container, restore the matching data archive, and
start the previous image. Do not restore data under a newer schema.

## 7. Self-iteration boundary

The container runs the self-iteration plugin in proposal/worktree mode. The image includes the
repository `.git` at `/app`, and worktrees live under `/data/worktrees`; each new worktree gets a
`node_modules` symlink back to the image install so tests and builds can run without a second
install. It has `git`, `bun`, and `ripgrep`, but no Docker socket and no host checkout, so a
proposal cannot replace the running image.

Promote a proposed change by applying it to the allowed deployment branch, committing it, and
running `bun run ops:deploy`; the host build stays the only path that replaces the running image.
The running container's `.git` is replaced with each image, so durable work belongs in the proposal
record or a commit, not in a container worktree.
