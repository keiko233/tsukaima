#!/usr/bin/env bash
# Prepare a Docker host for a fork deployment. Run as root on the target host, for example:
#
#   ssh <ssh-target> 'DEPLOYER=example-user FORK_URL=git@github.com:MajoStudio/tsukaima.git bash -s' \
#     < ops/deploy/bootstrap-host.sh
#
# Safe to re-run. The first run may stop after printing the host deploy key; authorize it on the
# fork, then re-run to clone the repository and finish the setup.
set -euo pipefail

DEPLOYER="${DEPLOYER:-$(git config user.name || echo deploy)}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
ROOT="${ROOT:-/opt/tsukaima}"
FORK_URL="${FORK_URL:-}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/example-org/tsukaima.git}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/$DEPLOYER}"
GIT_NAME="${GIT_NAME:-Tsukaima Deploy ($DEPLOYER)}"
GIT_EMAIL="${GIT_EMAIL:-${DEPLOYER}@tsukaima.invalid}"
SSH_KEY="${SSH_KEY:-/root/.ssh/tsukaima_deploy_ed25519}"
ENABLE_CADDY="${ENABLE_CADDY:-1}"
CADDYFILE="${CADDYFILE:-/opt/caddy/Caddyfile}"
CADDY_CONTAINER="${CADDY_CONTAINER:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-$DEPLOYER}"
ADMIN_EMAIL="${ADMIN_EMAIL:-${DEPLOYER}@tsukaima.invalid}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

if [[ -z "$FORK_URL" ]]; then
	echo "FORK_URL is required (the fork remote, not the mainline)." >&2
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
docker network inspect tsukaima >/dev/null 2>&1 || docker network create tsukaima

mkdir -p "$ROOT/repo" "$ROOT/data" "$ROOT/secrets" "$ROOT/backups" "$ROOT/deployments" "$ROOT/.deploy"
chmod 700 "$ROOT/secrets" "$ROOT/.deploy"
chmod 600 "$ROOT/secrets"/* 2>/dev/null || true

if [[ ! -f "$SSH_KEY" ]]; then
	mkdir -p "$(dirname "$SSH_KEY")"
	ssh-keygen -q -t ed25519 -N "" -C "tsukaima-host-${DEPLOYER}" -f "$SSH_KEY"
fi
chmod 600 "$SSH_KEY"
chmod 644 "$SSH_KEY.pub"
if ! ssh-keygen -F github.com >/dev/null 2>&1; then
	ssh-keyscan -t ed25519 github.com >>/root/.ssh/known_hosts 2>/dev/null
fi

if ! grep -q "tsukaima deploy key" /root/.ssh/config 2>/dev/null; then
	cat >>/root/.ssh/config <<EOF
# tsukaima deploy key (managed by ops/deploy/bootstrap-host.sh)
Host github.com
	IdentityFile $SSH_KEY
	IdentitiesOnly yes
EOF
	chmod 600 /root/.ssh/config
fi

github_authenticated() {
	{ ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -T git@github.com 2>&1 || true; } |
		grep -q "Hi .*successfully authenticated"
}

if [[ ! -d "$ROOT/repo/.git" ]]; then
	case "$FORK_URL" in
	git@* | ssh://*)
		echo "Host deploy key (add with write access to $FORK_URL):"
		cat "$SSH_KEY.pub"
		if ! github_authenticated; then
			echo "The key is not authorized yet. Add it to the fork, then re-run this script." >&2
			exit 3
		fi
		;;
	esac
	git clone "$FORK_URL" "$ROOT/repo"
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
	git remote set-url origin "$FORK_URL"
else
	git remote add origin "$FORK_URL"
fi
if git remote get-url upstream >/dev/null 2>&1; then
	git remote set-url upstream "$UPSTREAM_URL"
else
	git remote add upstream "$UPSTREAM_URL"
fi
git fetch --all --prune --tags
git checkout "$DEPLOY_BRANCH" 2>/dev/null || git checkout -b "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
git branch --set-upstream-to="origin/$DEPLOY_BRANCH" "$DEPLOY_BRANCH" 2>/dev/null || true
git pull --ff-only

ln -sfn repo/compose.yaml "$ROOT/compose.yaml"
cp ops/deploy/Caddyfile.fragment "$ROOT/Caddyfile.fragment"
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
TSUKAIMA_IMAGE=tsukaima:0.1.0
TSUKAIMA_VERSION=0.1.0
TSUKAIMA_COMMIT=
TSUKAIMA_DEPLOYER=$DEPLOYER
TSUKAIMA_PUBLIC_URL=${PUBLIC_URL:-http://app.example.test}
TSUKAIMA_BIND_ADDR=${BIND_ADDR:-127.0.0.1}
TSUKAIMA_TRUSTED_ORIGINS=${PUBLIC_URL:-http://app.example.test},http://app.example.test
TSUKAIMA_TRUSTED_PROXIES=172.16.0.0/12
EOF
	chmod 600 "$ROOT/.env"
fi

if [[ "$ENABLE_CADDY" == "1" && -f "$CADDYFILE" ]]; then
	if ! grep -q "BEGIN tsukaima (managed by ops/deploy/deploy.sh)" "$CADDYFILE"; then
		backup="$CADDYFILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
		cp -a "$CADDYFILE" "$backup"
		printf '\n' >>"$CADDYFILE"
		cat "$ROOT/Caddyfile.fragment" >>"$CADDYFILE"
		if [[ -z "$CADDY_CONTAINER" ]]; then
			CADDY_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '(^|-)caddy(-|$)' | head -n1 || true)"
		fi
		if [[ -n "$CADDY_CONTAINER" ]]; then
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

cat <<EOF

Host bootstrap complete.
  root:      $ROOT
  repo:      $ROOT/repo ($DEPLOY_BRANCH)
  data:      $ROOT/data (uid/gid 1000)
  secrets:   $ROOT/secrets/runtime.env
  admin pw:  $ROOT/secrets/initial-admin-password.txt
  URL:       http://app.example.test (after deploy)

Deploy:
  ssh root@\$(hostname -I | awk '{print \$1}') 'cd $ROOT/repo && DEPLOYER=$DEPLOYER DEPLOY_BRANCH=$DEPLOY_BRANCH ROOT=$ROOT bash ops/deploy/deploy.sh'
EOF
