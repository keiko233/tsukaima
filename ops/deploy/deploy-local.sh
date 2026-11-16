#!/usr/bin/env bash
# Push the allowed deployment branch and deploy that exact revision on the prepared host.
#
#   bun run ops:deploy
#   HOST=<ssh-target> DEPLOYER=example-user bun run ops:deploy
#
# Maintainers of the mainline repository deploy main. Forks must deploy a non-main branch
# (deploy/<deployer> by default) that has been rebased onto mainline/main.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
HOST="${HOST:-<ssh-target>}"
ROOT="${ROOT:-/opt/tsukaima}"
DEPLOYER="${DEPLOYER:-${TSUKAIMA_DEPLOYER:-$(git config user.name || whoami)}}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
MAINLINE_REPO="${MAINLINE_REPO:-example-org/tsukaima}"

repository_slug() {
	local url="$1"
	url="${url%.git}"
	url="${url#git@github.com:}"
	url="${url#https://github.com/}"
	url="${url#ssh://git@github.com/}"
	printf '%s\n' "$url"
}

origin_url="$(git remote get-url origin)"
origin_slug="$(repository_slug "$origin_url")"
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
	echo "Refusing to deploy main from a fork. Fork the repository locally or on GitHub and deploy a" >&2
	echo "dedicated branch instead, for example:" >&2
	echo "  git switch -c deploy/$DEPLOYER" >&2
	echo "  DEPLOY_BRANCH=deploy/$DEPLOYER bun run ops:deploy" >&2
	exit 2
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	sed -n '2,9p' "$0"
	exit 0
fi
if [[ -n "$(git status --porcelain)" ]]; then
	echo "Worktree is dirty. Commit changes before deploying." >&2
	exit 2
fi

current="$(git branch --show-current)"
if [[ "$current" != "$deploy_branch" ]]; then
	echo "Current branch $current is not $deploy_branch. Check out $deploy_branch before deploying." >&2
	exit 2
fi

git push origin "$deploy_branch"

ssh -o BatchMode=yes "$HOST" "
	set -euo pipefail
	cd '$ROOT/repo'
	git fetch origin --prune --tags
	git checkout '$deploy_branch'
	git merge --ff-only 'origin/$deploy_branch'
	DEPLOYER='$DEPLOYER' DEPLOY_BRANCH='$deploy_branch' MAINLINE_REPO='$MAINLINE_REPO' ROOT='$ROOT' bash ops/deploy/deploy.sh
"
