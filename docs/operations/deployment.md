# Fork-based Docker deployment

This document is the operator workflow for running Tsukaima from a personal fork. The mainline
repository owns releases. A deployment checkout is a fork branch plus deployment-owned secrets and
data; it is never a detached copy of production source.

Related documents:

- [Production runbook](runbook.md)
- [Self-iteration architecture](../architecture/self-iteration.md)
- [Quality gates](quality.md)

## 1. Topology

```text
example-org/tsukaima (upstream/main, release tags vX.Y.Z)
        │
        ├── fork: <you>/tsukaima (origin)
        │        └── deploy/<you> branch
        │                 │
        │                 └── host checkout /opt/tsukaima/repo
        │                          ├── docker build → tsukaima:<version>
        │                          ├── /opt/tsukaima/data       (persistent SQLite + blobs)
        │                          └── /opt/tsukaima/secrets    (0600, never committed)
        │
        └── optional fork features / experiments
```

Every deployer has a fork, a deployment branch, a host data directory, and an image tag. Two
deployers can run the same mainline release without sharing data or secrets. The host only needs
read/write access to its own fork, not to upstream.

## 2. Version authority

`VERSION` and every workspace `package.json` version are mainline-owned.

- A release is a mainline commit tagged `vX.Y.Z` where `VERSION` is `X.Y.Z`.
- `bun run check:version` verifies that all workspace manifests agree with `VERSION`.
- CI runs `bun tools/ops/version.ts check --upstream origin/main`, which rejects commits authored on
  a fork that touch `VERSION` or a workspace `package.json`.
- Merging `upstream/main` may bring a version bump into a fork. That is allowed because the change
  was authored upstream.
- A fork that is not exactly at a release gets a build label such as
  `0.1.0-fork.example-user.4f004ea95ec6`. It never claims to be release `0.1.0`.
- Only `.github/workflows/release.yml` publishes `ghcr.io/example-org/tsukaima:vX.Y.Z`. Forks build
  their own local image and do not publish to the mainline package.

Do not edit `VERSION` or package versions to make a fork look newer. Merge mainline, then deploy.

## 3. One-time fork setup

Create a fork with GitHub (or `gh repo fork example-org/tsukaima --clone=false`), then in the checkout:

```sh
FORK_URL=git@github.com:<you>/tsukaima.git \
  bash ops/deploy/bootstrap-fork.sh
```

The script configures:

- local `user.name` / `user.email` (from `GIT_NAME` / `GIT_EMAIL` when unset),
- a dedicated SSH key (`~/.ssh/tsukaima_<you>_ed25519`) and GitHub host trust,
- `origin` = fork, `upstream` = `https://github.com/example-org/tsukaima.git`,
- `fetch.prune`, `pull.ff=only`, `rerere.enabled`, and `merge.conflictStyle=zdiff3`,
- the deployment branch `deploy/<you>` and its upstream.

It never force-pushes and never rewrites shared history.

## 4. Host bootstrap

The target host needs Docker with Compose v2, Git, `sqlite3`, and the `tsukaima` Docker network.
The supported default target is `<ssh-target>`, root directory `/opt/tsukaima`.

```sh
# 1. Generate/refresh the host deploy key and print it.
ssh <ssh-target> \
  'DEPLOYER=example-user FORK_URL=git@github.com:<you>/tsukaima.git bash -s' \
  < ops/deploy/bootstrap-host.sh

# 2. Add the printed public key to the fork with write access:
gh repo deploy-key add \
  <(ssh <ssh-target> cat /root/.ssh/tsukaima_deploy_ed25519.pub) \
  --repo <you>/tsukaima --title tsukaima-host --allow-write

# 3. Re-run the bootstrap to clone the fork and finish setup.
ssh <ssh-target> \
  'DEPLOYER=example-user FORK_URL=git@github.com:<you>/tsukaima.git bash -s' \
  < ops/deploy/bootstrap-host.sh
```

The bootstrap creates:

| Path | Purpose |
| --- | --- |
| `/opt/tsukaima/repo` | fork checkout on `deploy/<you>` |
| `/opt/tsukaima/data` | mounted at `/data` in the container, owned by uid 1000 |
| `/opt/tsukaima/secrets/runtime.env` | auth secret and admin bootstrap, mode 0600 |
| `/opt/tsukaima/secrets/initial-admin-password.txt` | generated first password, mode 0600 |
| `/opt/tsukaima/backups` | pre-deploy data archives, three retained |
| `/opt/tsukaima/deployments` | JSON deployment records |
| `/opt/tsukaima/compose.yaml` | symlink to the committed `repo/compose.yaml` (repo and compose stay siblings, but the file is versioned) |
| `/opt/tsukaima/.env` | image tag, version, deployer, public URL |

It also adds an idempotent `app.example.test` block to `/opt/caddy/Caddyfile` and reloads Caddy when
that file exists. The container joins the external `tsukaima` network and binds only
`127.0.0.1:7420`; Caddy is the LAN entrypoint. Set `TSUKAIMA_BIND_ADDR=192.0.2.10` in
`/opt/tsukaima/.env` for direct LAN access.

## 5. Move development data

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

## 6. Iterate and deploy

```sh
# Work on a feature branch; never edit VERSION or package versions.
git switch -c feat/my-plugin deploy/example-user
# ... edit, test ...
git commit -am "feat(plugin): ..."

# Merge the feature into the deployment branch.
git switch deploy/example-user
git merge --no-ff feat/my-plugin

# Fetch --all, merge mainline, validate version authority, install if lockfile changed.
bun run ops:sync

# Push the deploy branch and build/release on the host.
bun run ops:deploy
```

`ops:sync` performs `git fetch --all --prune --tags`, merges `upstream/main` into the deployment
branch with a merge commit, runs `version.ts check --upstream upstream/main`, and refreshes
dependencies only when `bun.lock` changed. Conflicts leave the merge in place; resolve, commit, and
re-run. `rerere` remembers resolutions. Feature branches stay independent and can be rebased or
merged individually; the deployment branch is never force-pushed.

`ops:deploy` does the following:

1. Requires a clean worktree and pushes `deploy/<you>`.
2. The host fetches, fast-forwards to the pushed branch, and checks that `upstream/main` is included.
3. Refuses to build if `VERSION` differs from `upstream/main` or a fork commit authored a version
   change.
4. Tags the image `tsukaima:<version>` or `tsukaima:<version>-fork.<you>.<sha>`.
5. Builds with `oven/bun:latest`, stops the old container only after the build succeeds, archives
   `data` (except logs), and starts the new image.
6. Polls `/readyz`; on failure it prints container logs and restores the previous image.
7. Records the deployment under `/opt/tsukaima/deployments`, keeps the previous image, and retains
   three data archives for rollback. Older Tsukaima images and build cache are pruned before the
   next build; unrelated host images are never touched.

## 7. Verification and rollback

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

## 8. Self-iteration boundary

The container runs the self-iteration plugin in proposal/worktree mode. The image includes the
repository `.git` at `/app`, and worktrees live under `/data/worktrees`; each new worktree gets a
`node_modules` symlink back to the image install so tests and builds can run without a second
install. It has `git`, `bun`, and `ripgrep`, but no Docker socket and no host checkout, so a
proposal cannot replace the running image.

Promote a proposed change by applying it to the deployment checkout, merging mainline, and running
`bun run ops:deploy`; the host build stays the only path that replaces the running image. The
running container's `.git` is replaced with each image, so durable work belongs in the proposal
record or a fork commit, not in a container worktree. This keeps self-edit, review, versioning, and
release authority separate.
