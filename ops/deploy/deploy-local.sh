#!/usr/bin/env bash
# Local entrypoint: sync the deploy branch with mainline, push it, then build and release remotely.
#
#   bun run ops:deploy
#   HOST=<ssh-target> DEPLOYER=example-user bun run ops:deploy
#
# The host must have been bootstrapped once with ops/deploy/bootstrap-host.sh.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
HOST="${HOST:-<ssh-target>}"
ROOT="${ROOT:-/opt/tsukaima}"
DEPLOYER="${DEPLOYER:-${TSUKAIMA_DEPLOYER:-$(git config user.name || whoami)}}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/$DEPLOYER}"
SYNC="${SYNC:-1}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	sed -n '2,9p' "$0"
	exit 0
fi
if [[ -n "$(git status --porcelain)" ]]; then
	echo "Worktree is dirty. Commit changes before deploying." >&2
	exit 2
fi

if [[ "$SYNC" == "1" ]]; then
	bash ops/deploy/sync-upstream.sh --push
else
	current="$(git branch --show-current)"
	if [[ "$current" != "$DEPLOY_BRANCH" ]]; then
		echo "Current branch $current is not $DEPLOY_BRANCH (set SYNC=1 or check out the branch)." >&2
		exit 2
	fi
	git push origin "$DEPLOY_BRANCH"
fi

ssh -o BatchMode=yes "$HOST" "
	set -euo pipefail
	cd '$ROOT/repo'
	git fetch --all --prune --tags
	git checkout '$DEPLOY_BRANCH'
	git merge --ff-only 'origin/$DEPLOY_BRANCH'
	DEPLOYER='$DEPLOYER' DEPLOY_BRANCH='$DEPLOY_BRANCH' ROOT='$ROOT' bash ops/deploy/deploy.sh
"
