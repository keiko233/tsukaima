#!/usr/bin/env bash
# Build and release one git revision on a prepared host. Run on the host:
#
#   cd /opt/tsukaima/repo
#   DEPLOYER=example-user DEPLOY_BRANCH=deploy/example-user ROOT=/opt/tsukaima bash ops/deploy/deploy.sh
#
# The build is versioned from VERSION. A fork commit gets a `-fork.<deployer>.<sha>` suffix; only
# mainline tags produce a bare release version. Previous image and data backup are kept for
# rollback.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
REPO="$(pwd)"
DEPLOYER="${DEPLOYER:-${TSUKAIMA_DEPLOYER:-$(git config user.name || echo deploy)}}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
ROOT="${ROOT:-/opt/tsukaima}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/$DEPLOYER}"
COMPOSE_FILE="$ROOT/compose.yaml"
DATA_DIR="$ROOT/data"
ENV_FILE="$ROOT/.env"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SKIP_BUILD="${SKIP_BUILD:-0}"

fail() {
	echo "deploy: $*" >&2
	exit 1
}

[[ "$(id -u)" == "0" ]] || fail "run as root on the deployment host"
[[ -f "$ROOT/secrets/runtime.env" ]] || fail "missing $ROOT/secrets/runtime.env (run bootstrap-host.sh)"
[[ -f "$COMPOSE_FILE" ]] || fail "missing $COMPOSE_FILE (run bootstrap-host.sh)"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

if [[ -n "$(git status --porcelain)" ]]; then
	fail "worktree is dirty; commit or stash before deploying"
fi

git fetch --all --prune --tags
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$DEPLOY_BRANCH" ]]; then
	git checkout "$DEPLOY_BRANCH"
fi
git merge --ff-only "origin/$DEPLOY_BRANCH" || fail "local $DEPLOY_BRANCH differs from origin; push or reset it first"

[[ -n "$(git rev-parse --verify upstream/main 2>/dev/null)" ]] || fail "upstream/main is missing"
git merge-base --is-ancestor upstream/main HEAD ||
	fail "deploy branch does not contain upstream/main; run bun run ops:sync and push"

local_version="$(tr -d '[:space:]' <VERSION)"
upstream_version="$(git show upstream/main:VERSION 2>/dev/null | tr -d '[:space:]' || true)"
[[ "$local_version" == "$upstream_version" ]] ||
	fail "VERSION $local_version is behind mainline ($upstream_version); merge upstream/main before deploying"

mapfile -t version_files < <(git ls-files 'VERSION' '*/package.json')
authored="$(git log --no-merges --format='%h %s' upstream/main..HEAD -- "${version_files[@]}")"
[[ -z "$authored" ]] ||
	fail "fork commits must not modify VERSION or package versions:\n$authored"

commit="$(git rev-parse HEAD)"
if git describe --tags --exact-match --match "v$local_version" HEAD >/dev/null 2>&1; then
	image_version="$local_version"
else
	image_version="$local_version-fork.$DEPLOYER.$(git rev-parse --short=12 HEAD)"
fi
image="tsukaima:$image_version"
source_url="$(git remote get-url upstream 2>/dev/null || echo https://github.com/example-org/tsukaima.git)"

echo "Deploying $image"
echo "  commit:   $commit"
echo "  branch:   $DEPLOY_BRANCH"
echo "  fork:     $DEPLOYER"

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

if [[ "$SKIP_BUILD" != "1" ]]; then
	echo "Building image (oven/bun:latest)..."
	DOCKER_BUILDKIT=1 docker build \
		--pull \
		--label "org.opencontainers.image.version=$image_version" \
		--label "org.opencontainers.image.revision=$commit" \
		--label "org.opencontainers.image.source=$source_url" \
		--label "io.tsukaima.fork=$DEPLOYER" \
		-t "$image" "$REPO"
else
	docker image inspect "$image" >/dev/null 2>&1 || fail "SKIP_BUILD=1 but image $image does not exist"
fi

# Back up the previous data directory only after the new image exists, so a build failure never
# takes the running service down.
if [[ -f "$DATA_DIR/domain.sqlite" ]]; then
	echo "Stopping the current container for a consistent data backup..."
	docker compose -f "$COMPOSE_FILE" --project-directory "$ROOT" stop tsukaima >/dev/null 2>&1 || true
	mkdir -p "$ROOT/backups"
	echo "Backing up data (excluding logs)..."
	tar -C "$ROOT" -czf "$ROOT/backups/data-$TIMESTAMP.tgz" --exclude='data/logs' data
fi

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

printf '%s\n' "$image" >"$ROOT/.deploy/current-image"
printf '%s\n' "$image_version" >"$ROOT/.deploy/current-version"
printf '%s\n' "$commit" >"$ROOT/.deploy/current-commit"
chmod 600 "$ROOT/.deploy"/*

cat >"$ROOT/deployments/$TIMESTAMP.json" <<EOF
{
	"deployedAt": "$TIMESTAMP",
	"deployer": "$DEPLOYER",
	"branch": "$DEPLOY_BRANCH",
	"version": "$image_version",
	"image": "$image",
	"commit": "$commit",
	"previousImage": "$previous_image"
}
EOF
chmod 600 "$ROOT/deployments/$TIMESTAMP.json"

# Retain a small rollback window without filling the host disk.
ls -1t "$ROOT/backups"/data-*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f
ls -1t "$ROOT/deployments"/*.json 2>/dev/null | tail -n +21 | xargs -r rm -f

health="$(curl -fsS "$health_url/healthz" || true)"
echo "$health"
echo "Deployed $image at $TIMESTAMP"
