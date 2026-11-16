#!/usr/bin/env bash
# Prepare the dependency image a deploy reuses. Prints the image tag on stdout and build output on
# stderr, so callers can do:  deps_image="$(bash ops/deploy/prepare-deps.sh)"
#
#   bash ops/deploy/prepare-deps.sh          # build only when the key changed
#   FORCE=1 bash ops/deploy/prepare-deps.sh  # rebuild anyway
#
# Run this on the host at bootstrap (or any time dependency installation is convenient) so a
# deploy never spends minutes in `bun install`. The key covers bun.lock, every workspace
# manifest, and this Dockerfile's dependency stage, so a stale image is never reused.
set -euo pipefail

REPO="${REPO:-$(git rev-parse --show-toplevel)}"
REPO="$(cd "$REPO" && pwd)"
DOCKERFILE="${DOCKERFILE:-$REPO/Dockerfile}"
FORCE="${FORCE:-0}"

log() {
	printf '%s\n' "$*" >&2
}

[[ -f "$REPO/bun.lock" ]] || {
	log "prepare-deps: $REPO/bun.lock is missing"
	exit 2
}
[[ -f "$DOCKERFILE" ]] || {
	log "prepare-deps: $DOCKERFILE is missing"
	exit 2
}

manifest_digest="$(
	cd "$REPO"
	{
		cat package.json
		find apps packages plugins tools -maxdepth 2 -name package.json \
			-not -path '*/node_modules/*' -print0 |
			sort -z |
			xargs -0 -r cat
	} | sha256sum
)"

deps_key="$(
	{
		printf 'dockerfile\n'
		sed -n '1,/^FROM ${DEPS_IMAGE}/p' "$DOCKERFILE"
		printf 'lockfile\n'
		cat "$REPO/bun.lock"
		printf 'manifests\n'
		printf '%s' "$manifest_digest"
	} | sha256sum | cut -c1-12
)"
deps_image="tsukaima-deps:$deps_key"

if [[ "$FORCE" != "1" ]] && docker image inspect "$deps_image" >/dev/null 2>&1; then
	log "prepare-deps: reusing $deps_image"
	printf '%s\n' "$deps_image"
	exit 0
fi

log "prepare-deps: building $deps_image (dependency installation runs only when this changes)"
DOCKER_BUILDKIT=1 docker build \
	--file "$DOCKERFILE" \
	--label "org.tsukaima.dependency-key=$deps_key" \
	--target deps \
	-t "$deps_image" \
	"$REPO" >&2

printf '%s\n' "$deps_image"
