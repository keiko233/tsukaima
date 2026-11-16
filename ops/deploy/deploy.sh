#!/usr/bin/env bash
# Build and release one revision from a pushed deployment branch. Run on the host:
#
#   cd /opt/tsukaima/repo
#   DEPLOY_BRANCH=main ROOT=/opt/tsukaima bash ops/deploy/deploy.sh
#
# Maintainers deploy main from the mainline repository. Forks must deploy a non-main branch.
# The build is versioned from VERSION; every non-release commit gets a short-commit suffix.
# Previous image and data backup are kept for rollback.
#
# Redeploys reuse the Docker build cache; only stale cache and dangling images are reclaimed by
# default. Set PULL_BASE=1 to force a base-image pull, which is slower and only worth it when you
# actually want the newest oven/bun.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
REPO="$(pwd)"
DEPLOYER="${DEPLOYER:-${TSUKAIMA_DEPLOYER:-$(git config user.name || echo deploy)}}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
ROOT="${ROOT:-/opt/tsukaima}"
MAINLINE_REPO="${MAINLINE_REPO:-example-org/tsukaima}"
COMPOSE_FILE="$ROOT/compose.yaml"
DATA_DIR="$ROOT/data"
ENV_FILE="$ROOT/.env"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SKIP_BUILD="${SKIP_BUILD:-0}"
PULL_BASE="${PULL_BASE:-0}"
deploy_started=$SECONDS

fail() {
	echo "deploy: $*" >&2
	exit 1
}

repository_slug() {
	local url="$1"
	url="${url%.git}"
	url="${url#git@github.com:}"
	url="${url#https://github.com/}"
	url="${url#ssh://git@github.com/}"
	printf '%s\n' "$url"
}

origin_slug="$(repository_slug "$(git remote get-url origin)")"
is_mainline=0
[[ "$origin_slug" == "$MAINLINE_REPO" ]] && is_mainline=1
if [[ -n "${DEPLOY_BRANCH:-}" ]]; then
	deploy_branch="$DEPLOY_BRANCH"
elif [[ "$is_mainline" == "1" ]]; then
	deploy_branch="main"
else
	deploy_branch="deploy/$DEPLOYER"
fi
if [[ "$is_mainline" != "1" && "$deploy_branch" == "main" ]]; then
	fail "refusing to deploy main from a fork; check out a dedicated deployment branch instead"
fi

[[ "$(id -u)" == "0" ]] || fail "run as root on the deployment host"
[[ -f "$ROOT/secrets/runtime.env" ]] || fail "missing $ROOT/secrets/runtime.env (run bootstrap-host.sh)"
[[ -f "$COMPOSE_FILE" ]] || fail "missing $COMPOSE_FILE (run bootstrap-host.sh)"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

if [[ -n "$(git status --porcelain)" ]]; then
	fail "worktree is dirty; commit or stash before deploying"
fi

git fetch origin --prune --tags
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$deploy_branch" ]]; then
	git checkout "$deploy_branch"
fi
git merge --ff-only "origin/$deploy_branch" || fail "local $deploy_branch differs from origin; push or reset it first"

local_version="$(tr -d '[:space:]' <VERSION)"
commit="$(git rev-parse HEAD)"
if git describe --tags --exact-match --match "v$local_version" HEAD >/dev/null 2>&1; then
	image_version="$local_version"
else
	image_version="$local_version-$(git rev-parse --short=12 HEAD)"
fi
image="tsukaima:$image_version"
source_url="$(git remote get-url origin 2>/dev/null || echo unknown)"

# Keep enough room for the build, data archive, and previous image. The recent build cache is
# what makes a redeploy fast, so only cache unused for two weeks and dangling images are
# reclaimed; unrelated host images are never touched.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=336h >/dev/null 2>&1 || true
available_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
if [[ -n "$available_kb" && "$available_kb" -lt 4194304 ]]; then
	fail "less than 4 GiB free on $ROOT; prune Docker images/backups before deploying"
fi

echo "Deploying $image"
echo "  commit:   $commit"
echo "  branch:   $deploy_branch"
echo "  source:   $source_url"

health_host="$(sed -n 's/^TSUKAIMA_BIND_ADDR=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
health_host="${health_host:-127.0.0.1}"
if [[ "$health_host" == "0.0.0.0" || "$health_host" == "::" ]]; then
	health_host="127.0.0.1"
fi
health_url="http://$health_host:7420"

previous_image=""
previous_version=""
if [[ -f "$ROOT/.deploy/current-image" ]]; then
	previous_image="$(cat "$ROOT/.deploy/current-image")"
fi
if [[ -f "$ROOT/.deploy/current-version" ]]; then
	previous_version="$(cat "$ROOT/.deploy/current-version")"
fi

build_started=$SECONDS
pull_args=()
[[ "$PULL_BASE" == "1" ]] && pull_args+=(--pull)
if [[ "$SKIP_BUILD" != "1" ]]; then
	echo "Building image (oven/bun:latest)..."
	DOCKER_BUILDKIT=1 docker build \
		"${pull_args[@]}" \
		--label "org.opencontainers.image.version=$image_version" \
		--label "org.opencontainers.image.revision=$commit" \
		--label "org.opencontainers.image.source=$source_url" \
		-t "$image" "$REPO"
else
	docker image inspect "$image" >/dev/null 2>&1 || fail "SKIP_BUILD=1 but image $image does not exist"
fi
echo "  image built in $((SECONDS - build_started))s"

# Back up the previous data directory only after the new image exists, so a build failure never
# takes the running service down. gzip is single-threaded and the data directory is mostly the
# media blob store, so a multi-core compressor keeps the stopped window short.
compress_args=(-z)
if command -v pigz >/dev/null 2>&1; then
	compress_args=(--use-compress-program=pigz)
fi

backup_started=$SECONDS
downtime_started=0
if [[ -f "$DATA_DIR/domain.sqlite" ]]; then
	echo "Stopping the current container for a consistent data backup..."
	docker compose -f "$COMPOSE_FILE" --project-directory "$ROOT" stop tsukaima >/dev/null 2>&1 || true
	downtime_started=$SECONDS
	mkdir -p "$ROOT/backups"
	echo "Backing up data (excluding logs)..."
	if ! tar -C "$ROOT" "${compress_args[@]}" -cf "$ROOT/backups/data-$TIMESTAMP.tgz" --exclude='data/logs' data; then
		echo "Data backup failed; restarting the current image." >&2
		rm -f "$ROOT/backups/data-$TIMESTAMP.tgz"
		docker compose -f "$COMPOSE_FILE" --project-directory "$ROOT" up -d --remove-orphans >/dev/null 2>&1 || true
		fail "could not archive $DATA_DIR; deployment aborted"
	fi
fi
echo "  data backed up in $((SECONDS - backup_started))s"

cp -a "$ENV_FILE" "$ENV_FILE.before-$TIMESTAMP"
set_env() {
	local key="$1" value="$2"
	if grep -q "^$key=" "$ENV_FILE"; then
		sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
	else
		printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
	fi
}
set_env TSUKAIMA_IMAGE "$image"
set_env TSUKAIMA_VERSION "$image_version"
set_env TSUKAIMA_COMMIT "$commit"
set_env TSUKAIMA_DEPLOYER "$DEPLOYER"

echo "Starting $image..."
docker compose -f "$COMPOSE_FILE" --project-directory "$ROOT" up -d --remove-orphans

ready=0
for _ in $(seq 1 90); do
	if curl -fsS -o /dev/null "$health_url/readyz"; then
		ready=1
		break
	fi
	sleep 2
done

actual_image="$(docker inspect --format '{{.Config.Image}}' tsukaima 2>/dev/null || true)"
if [[ "$ready" != "1" || "$actual_image" != "$image" ]]; then
	echo "New revision did not become ready or the running image does not match; collecting logs and rolling back." >&2
	docker compose -f "$COMPOSE_FILE" --project-directory "$ROOT" logs --tail=120 tsukaima >&2 || true
	if [[ -n "$previous_image" ]]; then
		echo "Rolling back to $previous_image" >&2
		set_env TSUKAIMA_IMAGE "$previous_image"
		set_env TSUKAIMA_VERSION "$previous_version"
		docker compose -f "$COMPOSE_FILE" --project-directory "$ROOT" up -d --remove-orphans || true
	fi
	exit 1
fi

if [[ "$downtime_started" != "0" ]]; then
	echo "  container stopped for $((SECONDS - downtime_started))s"
fi
echo "Deploy finished in $((SECONDS - deploy_started))s"

printf '%s\n' "$image" >"$ROOT/.deploy/current-image"
printf '%s\n' "$image_version" >"$ROOT/.deploy/current-version"
printf '%s\n' "$commit" >"$ROOT/.deploy/current-commit"
chmod 600 "$ROOT/.deploy"/*

cat >"$ROOT/deployments/$TIMESTAMP.json" <<EOF
{
	"deployedAt": "$TIMESTAMP",
	"deployer": "$DEPLOYER",
	"branch": "$deploy_branch",
	"version": "$image_version",
	"image": "$image",
	"commit": "$commit",
	"previousImage": "$previous_image"
}
EOF
chmod 600 "$ROOT/deployments/$TIMESTAMP.json"

# Retain a small rollback window without filling the host disk.
ls -1t "$ROOT/backups"/data-*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f
ls -1t "$ROOT/deployments"/*.json 2>/dev/null | tail -n +21 | xargs -r rm -f

# Keep only the running image and the one rollback target.
while IFS= read -r tag; do
	[[ -z "$tag" || "$tag" == *":<none>" ]] && continue
	[[ "$tag" == "$image" || "$tag" == "$previous_image" ]] && continue
	docker image rm "$tag" >/dev/null 2>&1 || true
done < <(docker image ls tsukaima --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)

health="$(curl -fsS "$health_url/healthz" || true)"
echo "$health"
echo "Deployed $image at $TIMESTAMP"
