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
keiko233/tsukaima (upstream/main, release tags vX.Y.Z)
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
  `0.1.0-fork.keiko.4f004ea95ec6`. It never claims to be release `0.1.0`.
- Only `.github/workflows/release.yml` publishes `ghcr.io/keiko233/tsukaima:vX.Y.Z`. Forks build
  their own local image and do not publish to the mainline package.

Do not edit `VERSION` or package versions to make a fork look newer. Merge mainline, then deploy.

## 3. One-time fork setup

Create a fork with GitHub (or `gh repo fork keiko233/tsukaima --clone=false`), then in the checkout:

```sh
FORK_URL=git@github.com:<you>/tsukaima.git \
  bash ops/deploy/bootstrap-fork.sh
```

The script configures:

- local `user.name` / `user.email` (from `GIT_NAME` / `GIT_EMAIL` when unset),
- a dedicated SSH key (`~/.ssh/tsukaima_<you>_ed25519`) and GitHub host trust,
- `origin` = fork, `upstream` = `https://github.com/keiko233/tsukaima.git`,
- `fetch.prune`, `pull.ff=only`, `rerere.enabled`, and `merge.conflictStyle=zdiff3`,
- the deployment branch `deploy/<you>` and its upstream.

It never force-pushes and never rewrites shared history.

## 4. Host bootstrap

The target host needs Docker with Compose v2, Git, `sqlite3`, and the `homelab` Docker network.
The supported default target is `root@10.0.0.6`, root directory `/opt/tsukaima`.

```sh
# 1. Generate/refresh the host deploy key and print it.
ssh root@10.0.0.6 \
  'DEPLOYER=keiko FORK_URL=git@github.com:<you>/tsukaima.git bash -s' \
  < ops/deploy/bootstrap-host.sh

# 2. Add the printed public key to the fork with write access:
gh repo deploy-key add \
  <(ssh root@10.0.0.6 cat /root/.ssh/tsukaima_deploy_ed25519.pub) \
  --repo <you>/tsukaima --title tsukaima-host --allow-write

# 3. Re-run the bootstrap to clone the fork and finish setup.
ssh root@10.0.0.6 \
  'DEPLOYER=keiko FORK_URL=git@github.com:<you>/tsukaima.git bash -s' \
  < ops/deploy/bootstrap-host.sh
```

The bootstrap creates:

| Path | Purpose |
| --- | --- |
| `/opt/tsukaima/repo` | fork checkout on `deploy/<you>` |
| `/opt/tsukaima/data` | mounted at `/data` in the container, owned by uid 1000 |
| `/opt/tsukaima/secrets/runtime.env` | auth secret and admin bootstrap, mode 0600 |
| `/opt/tsukaima/secrets/initial-admin-password.txt` | generated first password, mode 0600 |
| `/opt/tsukaima/backups` | pre-deploy data archives, five retained |
| `/opt/tsukaima/deployments` | JSON deployment records |
| `/opt/tsukaima/compose.yaml` | symlink to the committed `repo/compose.yaml` (repo and compose stay siblings, but the file is versioned) |
| `/opt/tsukaima/.env` | image tag, version, deployer, public URL |

It also adds an idempotent `tsukaima.lan` block to `/opt/caddy/Caddyfile` and reloads Caddy when
that file exists. The container joins the external `homelab` network and binds only
`127.0.0.1:7420`; Caddy is the LAN entrypoint. Set `TSUKAIMA_BIND_ADDR=10.0.0.6` in
`/opt/tsukaima/.env` for direct LAN access.

## 5. Move development data

Stop the source app if it is running, then snapshot and copy the databases and blobs. The script
uses `sqlite3 .backup` so WAL contents are included and does not copy `*.pre-rename.bak` files.

```sh
bash ops/deploy/copy-dev-data.sh \
  --source apps/server/data \
  --host root@10.0.0.6 \
  --root /opt/tsukaima
```

The remote app is stopped first. The deploy script starts the new image and the app runs embedded
migrations on boot. Keep the archive under `/opt/tsukaima/backups` until sign-in and channel tests
pass.

## 6. Iterate and deploy

```sh
# Work on a feature branch; never edit VERSION or package versions.
git switch -c feat/my-plugin deploy/keiko
# ... edit, test ...
git commit -am "feat(plugin): ..."

# Merge the feature into the deployment branch.
git switch deploy/keiko
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
7. Records the deployment under `/opt/tsukaima/deployments` and keeps the previous image and five
   data archives for rollback.

## 7. Verification and rollback

```sh
curl -fsS http://127.0.0.1:7420/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/readyz
curl -fsS http://tsukaima.lan/healthz
```

Sign in at `http://tsukaima.lan` with the bootstrap administrator. The current `10.0.0.6`
deployment also binds `http://10.0.0.6:7420` because local DNS may not yet map `tsukaima.lan`. The
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

The container runs the self-iteration plugin in proposal/worktree mode. It has `git`, `bun`,
`ripgrep`, and a writable `/data` volume, but no Docker socket and no host checkout by default.
Promote a proposed change by committing it in the deployment checkout, merging mainline, and
running `bun run ops:deploy`; the host build stays the only path that replaces the running image.
This keeps self-edit, review, versioning, and release authority separate.
