#!/usr/bin/env bash
# Push a deployment branch and deploy that exact revision on a prepared host.
#
#   HOST=<ssh-target> DEPLOY_BRANCH=<branch> bun run ops:deploy
#
# HOST is required and is any SSH target reachable from this machine. ROOT defaults to
# /opt/tsukaima and can be overridden for a different deployment layout. Every deployment must
# increase VERSION using strict SemVer relative to the version currently deployed on the host.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	sed -n '2,9p' "$0"
	exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/deploy/semver.sh
source "$script_dir/semver.sh"
cd "$(git rev-parse --show-toplevel)"

HOST="${HOST:-${TSUKAIMA_DEPLOY_HOST:-}}"
ROOT="${ROOT:-${TSUKAIMA_ROOT:-/opt/tsukaima}}"
DEPLOYER="${DEPLOYER:-${TSUKAIMA_DEPLOYER:-$(git config user.name || whoami)}}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(git branch --show-current)}"

fail() {
	echo "deploy: $*" >&2
	exit 1
}

[[ -n "$HOST" ]] || fail "HOST is required (for example HOST=<user>@<host> bun run ops:deploy)"
[[ -n "$DEPLOY_BRANCH" ]] || fail "DEPLOY_BRANCH is required; detached HEADs are not deployable"
[[ -n "$(git status --porcelain)" ]] && fail "worktree is dirty; commit changes before deploying"

current="$(git branch --show-current)"
[[ "$current" == "$DEPLOY_BRANCH" ]] ||
	fail "current branch $current is not $DEPLOY_BRANCH; check it out before deploying"

source_version="$(tr -d '[:space:]' <VERSION)"
semver_valid "$source_version" ||
	fail "VERSION is not strict SemVer (expected MAJOR.MINOR.PATCH with optional prerelease/build)"

remote_source_version="$(
	ssh -o BatchMode=yes "$HOST" "cat '$ROOT/.deploy/current-source-version' 2>/dev/null || true" |
		head -n1
)"
if [[ -z "$remote_source_version" ]]; then
	remote_image_version="$(
		ssh -o BatchMode=yes "$HOST" "cat '$ROOT/.deploy/current-version' 2>/dev/null || true" |
			head -n1
	)"
	# Older deployments only recorded the image version. Strip the generated commit suffix so
	# the first bumped deployment compares against the source version rather than the suffix.
	remote_source_version="$(printf '%s\n' "$remote_image_version" | sed -E 's/-[0-9a-f]{12}$//')"
fi

if [[ -n "$remote_source_version" ]]; then
	semver_valid "$remote_source_version" ||
		fail "deployed VERSION $remote_source_version is not strict SemVer; repair the host record first"
	comparison="$(semver_compare "$source_version" "$remote_source_version")"
	[[ "$comparison" == "1" ]] ||
		fail "VERSION must increase for every deployment (deployed: $remote_source_version, local: $source_version)"
fi

git push origin "$DEPLOY_BRANCH"

ssh -o BatchMode=yes "$HOST" "
	set -euo pipefail
	cd '$ROOT/repo'
	git fetch origin --prune
	git checkout '$DEPLOY_BRANCH'
	git merge --ff-only 'origin/$DEPLOY_BRANCH'
	DEPLOYER='$DEPLOYER' DEPLOY_BRANCH='$DEPLOY_BRANCH' ROOT='$ROOT' bash ops/deploy/deploy.sh
"
