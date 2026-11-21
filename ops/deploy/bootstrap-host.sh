#!/usr/bin/env bash
# Prepare a Docker host for a deployment. Run as root on the target host, for example:
#
#   ssh <ssh-target> \
#     'REPO_URL=<repo-url> PUBLIC_URL=<public-origin> DEPLOY_BRANCH=<branch> bash -s' \
#     < ops/deploy/bootstrap-host.sh
#
# Safe to re-run. The first run may stop after printing the host deploy key; authorize it on the
# repository, then re-run to clone it and finish the setup.
set -euo pipefail

DEPLOYER="${DEPLOYER:-$(git config user.name || echo deploy)}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
ROOT="${ROOT:-/opt/tsukaima}"
REPO_URL="${REPO_URL:-${FORK_URL:-}}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
PUBLIC_URL="${PUBLIC_URL:-${TSUKAIMA_PUBLIC_URL:-}}"
PUBLIC_ORIGIN="${PUBLIC_URL%/}"
DOCKER_NETWORK="${DOCKER_NETWORK:-${TSUKAIMA_DOCKER_NETWORK:-tsukaima}}"
TRUSTED_ORIGINS="${TRUSTED_ORIGINS:-$PUBLIC_ORIGIN}"
GIT_NAME="${GIT_NAME:-Tsukaima Deploy ($DEPLOYER)}"
GIT_EMAIL="${GIT_EMAIL:-${DEPLOYER}@tsukaima.invalid}"
SSH_KEY="${SSH_KEY:-/root/.ssh/tsukaima_deploy_ed25519}"
ENABLE_CADDY="${ENABLE_CADDY:-1}"
CADDYFILE="${CADDYFILE:-}"
CADDY_CONTAINER="${CADDY_CONTAINER:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-$DEPLOYER}"
ADMIN_EMAIL="${ADMIN_EMAIL:-${DEPLOYER}@tsukaima.invalid}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SKIP_PREPARE_DEPS="${SKIP_PREPARE_DEPS:-0}"

if [[ -z "$REPO_URL" ]]; then
	echo "REPO_URL is required (the deployment repository clone URL)." >&2
	exit 2
fi
if [[ ! "$PUBLIC_ORIGIN" =~ ^https?://[^/]+$ ]]; then
	echo "PUBLIC_URL is required as an HTTP(S) origin without a path, for example" >&2
	echo "PUBLIC_URL=https://chat.example.com." >&2
	exit 2
fi
if [[ "$(id -u)" != "0" ]]; then
	echo "Run bootstrap-host.sh as root on the deployment host." >&2
	exit 2
fi

missing=()
for command in git curl; do
	command -v "$command" >/dev/null 2>&1 || missing+=("$command")
done
command -v sqlite3 >/dev/null 2>&1 || missing+=("sqlite3")
if [[ ${#missing[@]} -gt 0 ]]; then
	apt-get update
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi
if ! docker compose version >/dev/null 2>&1; then
	echo "docker compose v2 is required on the host." >&2
	exit 2
fi
docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1 || docker network create "$DOCKER_NETWORK"

mkdir -p "$ROOT/repo" "$ROOT/data" "$ROOT/secrets" "$ROOT/backups" "$ROOT/deployments" "$ROOT/.deploy"
chmod 700 "$ROOT/secrets" "$ROOT/.deploy"
chmod 600 "$ROOT/secrets"/* 2>/dev/null || true

if [[ ! -f "$SSH_KEY" ]]; then
	mkdir -p "$(dirname "$SSH_KEY")"
	ssh-keygen -q -t ed25519 -N "" -C "tsukaima-host-${DEPLOYER}" -f "$SSH_KEY"
fi
chmod 600 "$SSH_KEY"
chmod 644 "$SSH_KEY.pub"
repository_ssh_host() {
	local url="$1"
	case "$url" in
	ssh://*)
		url="${url#ssh://}"
		url="${url#*@}"
		printf '%s\n' "${url%%/*}" | cut -d: -f1
		;;
	http://* | https://*)
		return 1
		;;
	*@*:*)
		url="${url#*@}"
		printf '%s\n' "${url%%:*}"
		;;
	*)
		return 1
		;;
	esac
}

repository_host="$(repository_ssh_host "$REPO_URL" || true)"
if [[ -n "$repository_host" ]]; then
	if ! ssh-keygen -F "$repository_host" >/dev/null 2>&1; then
		ssh-keyscan -t ed25519 "$repository_host" >>/root/.ssh/known_hosts 2>/dev/null
	fi
	if ! grep -q "Host $repository_host" /root/.ssh/config 2>/dev/null; then
		cat >>/root/.ssh/config <<EOF
# tsukaima deploy key (managed by ops/deploy/bootstrap-host.sh)
Host $repository_host
	IdentityFile $SSH_KEY
	IdentitiesOnly yes
EOF
		chmod 600 /root/.ssh/config
	fi
fi

repository_authenticated() {
	GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes" \
		git ls-remote "$REPO_URL" >/dev/null 2>&1
}

if [[ ! -d "$ROOT/repo/.git" ]]; then
	case "$REPO_URL" in
	*@*:* | ssh://*)
		echo "Host deploy key (add with write access to $REPO_URL):"
		cat "$SSH_KEY.pub"
		if ! repository_authenticated; then
			echo "The key is not authorized yet. Add it to the repository, then re-run this script." >&2
			exit 3
		fi
		;;
	esac
	git -c "core.sshCommand=ssh -i $SSH_KEY -o IdentitiesOnly=yes" clone "$REPO_URL" "$ROOT/repo"
fi

cd "$ROOT/repo"
if ! git config user.name >/dev/null 2>&1; then
	git config --local user.name "$GIT_NAME"
fi
if ! git config user.email >/dev/null 2>&1; then
	git config --local user.email "$GIT_EMAIL"
fi
git config --local core.sshCommand "ssh -i $SSH_KEY -o IdentitiesOnly=yes"
git config --local fetch.prune true
git config --local rerere.enabled true
git config --local pull.ff only
git config --global --add safe.directory "$ROOT/repo" 2>/dev/null || true

if git remote get-url origin >/dev/null 2>&1; then
	git remote set-url origin "$REPO_URL"
else
	git remote add origin "$REPO_URL"
fi
git fetch origin --prune
git checkout "$DEPLOY_BRANCH" 2>/dev/null || git checkout -b "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
git branch --set-upstream-to="origin/$DEPLOY_BRANCH" "$DEPLOY_BRANCH" 2>/dev/null || true
git pull --ff-only

source_version="$(tr -d '[:space:]' <VERSION)"
ln -sfn repo/compose.yaml "$ROOT/compose.yaml"
cat >"$ROOT/Caddyfile.fragment" <<EOF
# BEGIN tsukaima (managed by ops/deploy/deploy.sh)
$PUBLIC_ORIGIN {
	reverse_proxy tsukaima:7420
}
# END tsukaima
EOF
chown -R 1000:1000 "$ROOT/data"

if [[ ! -f "$ROOT/secrets/runtime.env" ]]; then
	auth_secret="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
	if [[ -z "$ADMIN_PASSWORD" ]]; then
		ADMIN_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '\n/+= ')"
	fi
	umask 077
	cat >"$ROOT/secrets/runtime.env" <<EOF
TSUKAIMA_AUTH_SECRET=$auth_secret
TSUKAIMA_ADMIN_USERNAME=$ADMIN_USERNAME
TSUKAIMA_ADMIN_PASSWORD=$ADMIN_PASSWORD
TSUKAIMA_ADMIN_EMAIL=$ADMIN_EMAIL
TSUKAIMA_LOG_LEVEL=info
EOF
	printf '%s\n' "$ADMIN_PASSWORD" >"$ROOT/secrets/initial-admin-password.txt"
	chmod 600 "$ROOT/secrets/runtime.env" "$ROOT/secrets/initial-admin-password.txt"
fi

if [[ ! -f "$ROOT/.env" ]]; then
	cat >"$ROOT/.env" <<EOF
TSUKAIMA_ROOT=$ROOT
TSUKAIMA_IMAGE=tsukaima:$source_version
TSUKAIMA_VERSION=$source_version
TSUKAIMA_COMMIT=
TSUKAIMA_PATCH_SHA256=
TSUKAIMA_DEPLOYER=$DEPLOYER
TSUKAIMA_PUBLIC_URL=$PUBLIC_ORIGIN
TSUKAIMA_BIND_ADDR=${BIND_ADDR:-127.0.0.1}
TSUKAIMA_TRUSTED_ORIGINS=$TRUSTED_ORIGINS
TSUKAIMA_DOCKER_NETWORK=$DOCKER_NETWORK
TSUKAIMA_TRUSTED_PROXIES=${TRUSTED_PROXIES:-172.16.0.0/12}
EOF
	chmod 600 "$ROOT/.env"
fi

if [[ "$ENABLE_CADDY" == "1" && -n "$CADDYFILE" && -f "$CADDYFILE" ]]; then
	if ! grep -q "BEGIN tsukaima (managed by ops/deploy/deploy.sh)" "$CADDYFILE"; then
		backup="$CADDYFILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
		cp -a "$CADDYFILE" "$backup"
		printf '\n' >>"$CADDYFILE"
		cat "$ROOT/Caddyfile.fragment" >>"$CADDYFILE"
		if [[ -z "$CADDY_CONTAINER" ]]; then
			CADDY_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '(^|-)caddy(-|$)' | head -n1 || true)"
		fi
		if [[ -n "$CADDY_CONTAINER" ]]; then
			docker network connect "$DOCKER_NETWORK" "$CADDY_CONTAINER" >/dev/null 2>&1 || true
			if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile; then
				cp -a "$backup" "$CADDYFILE"
				echo "Caddy reload failed; restored $backup" >&2
				exit 1
			fi
		else
			echo "Caddy container not found; fragment written but not reloaded." >&2
		fi
	fi
fi

# Installing dependencies is the slowest part of a first deploy. Prepare the dependency image now
# so every later deploy (and every deployment reload) finds it ready.
if [[ "$SKIP_PREPARE_DEPS" != "1" ]] && [[ -f "$ROOT/repo/ops/deploy/prepare-deps.sh" ]]; then
	echo "Preparing the dependency image (bun install runs once per lockfile change)..."
	if deps_image="$(REPO="$ROOT/repo" bash "$ROOT/repo/ops/deploy/prepare-deps.sh")"; then
		echo "Dependency image ready: $deps_image"
	else
		echo "Dependency image preparation failed; the first deploy will retry it." >&2
	fi
fi

cat <<EOF

Host bootstrap complete.
  root:      $ROOT
  repo:      $ROOT/repo ($DEPLOY_BRANCH)
  data:      $ROOT/data (uid/gid 1000)
  secrets:   $ROOT/secrets/runtime.env
  admin pw:  $ROOT/secrets/initial-admin-password.txt
  URL:       $PUBLIC_ORIGIN (after deploy)
  network:   $DOCKER_NETWORK

Deploy from your workstation:
  HOST=<ssh-target> ROOT=$ROOT DEPLOY_BRANCH=$DEPLOY_BRANCH bun run ops:deploy
EOF
