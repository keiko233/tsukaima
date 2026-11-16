#!/usr/bin/env bash
# Configure one deployer's fork checkout. Safe to re-run.
#
# Required:
#   FORK_URL       git@github.com:<you>/tsukaima.git (or an HTTPS fork URL)
# Optional:
#   UPSTREAM_URL   default https://github.com/keiko233/tsukaima.git
#   DEPLOYER       default: git config user.name (or OS user)
#   DEPLOY_BRANCH  default: deploy/<deployer>
#   GIT_NAME, GIT_EMAIL  local identity when the repository has none
#   SSH_KEY        default ~/.ssh/tsukaima_<deployer>_ed25519 (generated when missing)
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: FORK_URL=git@github.com:you/tsukaima.git bash ops/deploy/bootstrap-fork.sh

Configures git identity, SSH host trust, upstream/origin remotes, and the deployment branch.
It never force-pushes, never rewrites mainline tags, and never edits VERSION.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/keiko233/tsukaima.git}"
FORK_URL="${FORK_URL:-}"
DEPLOYER="${DEPLOYER:-$(git config user.name || whoami)}"
DEPLOYER="${DEPLOYER//[^A-Za-z0-9_.-]/-}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/$DEPLOYER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/tsukaima_${DEPLOYER}_ed25519}"
GIT_NAME="${GIT_NAME:-$(git config user.name || true)}"
GIT_EMAIL="${GIT_EMAIL:-$(git config user.email || true)}"

if [[ -z "$FORK_URL" ]]; then
	echo "FORK_URL is required, for example: FORK_URL=git@github.com:you/tsukaima.git" >&2
	exit 2
fi

if ! git config user.name >/dev/null 2>&1 && [[ -n "$GIT_NAME" ]]; then
	git config --local user.name "$GIT_NAME"
fi
if ! git config user.email >/dev/null 2>&1 && [[ -n "$GIT_EMAIL" ]]; then
	git config --local user.email "$GIT_EMAIL"
fi
if ! git config user.name >/dev/null 2>&1 || ! git config user.email >/dev/null 2>&1; then
	echo "Set GIT_NAME and GIT_EMAIL (or configure git user.name/user.email) first." >&2
	exit 2
fi

git config --local rerere.enabled true
git config --local fetch.prune true
git config --local pull.ff only
git config --local push.autoSetupRemote true
git config --local merge.conflictStyle zdiff3
git config --local init.defaultBranch main

if [[ ! -f "$SSH_KEY" ]]; then
	mkdir -p "$(dirname "$SSH_KEY")"
	ssh-keygen -q -t ed25519 -N "" -C "tsukaima-${DEPLOYER}@$(hostname)" -f "$SSH_KEY"
	echo "Generated SSH key: $SSH_KEY"
fi
chmod 600 "$SSH_KEY"
chmod 644 "$SSH_KEY.pub"

if ! ssh-keygen -F github.com >/dev/null 2>&1; then
	mkdir -p "$HOME/.ssh"
	ssh-keyscan -t ed25519 github.com >>"$HOME/.ssh/known_hosts" 2>/dev/null
fi
chmod 600 "$HOME/.ssh/known_hosts" 2>/dev/null || true

# Keep the dedicated key scoped to the deployment remotes instead of overriding global SSH.
GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes"
git config --local core.sshCommand "$GIT_SSH_COMMAND"

github_authenticated() {
	{ ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -T git@github.com 2>&1 || true; } |
		grep -q "successfully authenticated"
}

if ! github_authenticated; then
	if command -v gh >/dev/null 2>&1 && [[ "${AUTO_ADD_KEY:-1}" == "1" ]]; then
		gh ssh-key add "$SSH_KEY.pub" --title "tsukaima-${DEPLOYER}" >/dev/null 2>&1 || true
	fi
	if ! github_authenticated; then
		echo "The SSH key is not authorized for GitHub yet. Add this public key and re-run:" >&2
		cat "$SSH_KEY.pub" >&2
		exit 3
	fi
fi

if git remote get-url origin >/dev/null 2>&1; then
	ORIGIN_URL="$(git remote get-url origin)"
	if [[ "$ORIGIN_URL" == "$UPSTREAM_URL" || "$ORIGIN_URL" == "${UPSTREAM_URL%.git}.git" || "$ORIGIN_URL" == "${UPSTREAM_URL%.git}" ]]; then
		git remote rename origin upstream
	fi
fi
if git remote get-url upstream >/dev/null 2>&1; then
	git remote set-url upstream "$UPSTREAM_URL"
else
	git remote add upstream "$UPSTREAM_URL"
fi
if git remote get-url origin >/dev/null 2>&1; then
	git remote set-url origin "$FORK_URL"
else
	git remote add origin "$FORK_URL"
fi

git fetch --all --prune --tags
if ! git show-ref --verify --quiet "refs/heads/$DEPLOY_BRANCH"; then
	git branch "$DEPLOY_BRANCH" "upstream/main"
fi
git checkout "$DEPLOY_BRANCH"
git branch --set-upstream-to="origin/$DEPLOY_BRANCH" "$DEPLOY_BRANCH" 2>/dev/null || true
git push -u origin "$DEPLOY_BRANCH"

cat <<EOF

Fork checkout ready.
  branch:   $DEPLOY_BRANCH
  origin:   $FORK_URL
  upstream: $UPSTREAM_URL
  ssh key:  $SSH_KEY.pub

Authorize that public key for the fork before the first fetch/push:
  gh ssh-key add "$SSH_KEY.pub" --title "tsukaima-${DEPLOYER}"
or add it as a repository deploy key with write access.

Then update the fork:
  bun run ops:sync

Deploy:
  bun run ops:deploy
EOF
