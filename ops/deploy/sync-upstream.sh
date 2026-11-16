#!/usr/bin/env bash
# Merge mainline into the deployer's branch without rewriting fork history.
#
# Usage:
#   bun run ops:sync            # merge, validate, install if lockfile changed
#   bun run ops:sync -- --push  # also push the deploy branch to origin
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

DEPLOYER="${TSUKAIMA_DEPLOYER:-${DEPLOYER:-$(git config user.name || whoami)}}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/$DEPLOYER}"
PUSH=0
INSTALL=1
for argument in "$@"; do
	case "$argument" in
	--push) PUSH=1 ;;
	--no-install) INSTALL=0 ;;
	--help | -h)
		sed -n '2,9p' "$0"
		exit 0
		;;
	*)
		echo "Unknown option: $argument" >&2
		exit 2
		;;
	esac
done

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Worktree is dirty. Commit or stash changes before syncing with mainline." >&2
	git status --short >&2
	exit 2
fi

current="$(git branch --show-current)"
if [[ "$current" != "$DEPLOY_BRANCH" ]]; then
	echo "Switching from $current to deployment branch $DEPLOY_BRANCH"
	git checkout "$DEPLOY_BRANCH"
fi

git config rerere.enabled true
git fetch --all --prune --tags

if ! git show-ref --verify --quiet refs/remotes/upstream/main; then
	echo "upstream/main is missing. Add the mainline remote first:" >&2
	echo "  git remote add upstream https://github.com/example-org/tsukaima.git" >&2
	exit 2
fi

LOCK_BEFORE="$(git rev-parse HEAD:./bun.lock 2>/dev/null || true)"
echo "Merging upstream/main into $DEPLOY_BRANCH (no force, no rebase of shared history)..."
if ! git merge --no-ff --no-edit upstream/main; then
	cat >&2 <<'EOF'

Merge stopped with conflicts. Resolve them in this checkout, then:
  git add <files>
  git commit
  bun run ops:sync

The deploy branch keeps fork commits and receives mainline changes as merge commits. Feature
branches can be rebased onto the updated deploy branch individually; main is never force-pushed.
EOF
	exit 1
fi

# Version files are mainline-owned. This rejects a fork commit that authored a version bump even
# when it merged cleanly.
bun tools/ops/version.ts check --upstream upstream/main

LOCK_AFTER="$(git rev-parse HEAD:./bun.lock 2>/dev/null || true)"
if [[ "$INSTALL" == "1" && "$LOCK_BEFORE" != "$LOCK_AFTER" ]]; then
	echo "bun.lock changed with the merge; refreshing dependencies..."
	bun install --frozen-lockfile
fi

if [[ "$PUSH" == "1" ]]; then
	git push origin "$DEPLOY_BRANCH"
fi

echo "Deploy branch $DEPLOY_BRANCH is current with upstream/main."
echo "Next: bun run ops:deploy"
