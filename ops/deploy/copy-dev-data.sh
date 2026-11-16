#!/usr/bin/env bash
# Copy a local development data directory to a deployment host as a consistent SQLite snapshot.
# Stops only the remote Tsukaima container; the deploy script starts the new image afterwards.
#
#   bash ops/deploy/copy-dev-data.sh --source apps/server/data --host root@10.0.0.6
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
SOURCE="apps/server/data"
HOST="${HOST:-root@10.0.0.6}"
ROOT="${ROOT:-/opt/tsukaima}"

while [[ $# -gt 0 ]]; do
	case "$1" in
	--source)
		SOURCE="$2"
		shift 2
		;;
	--host)
		HOST="$2"
		shift 2
		;;
	--root)
		ROOT="$2"
		shift 2
		;;
	--help | -h)
		sed -n '2,7p' "$0"
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		exit 2
		;;
	esac
done

[[ -d "$SOURCE" ]] || {
	echo "Source data directory does not exist: $SOURCE" >&2
	exit 2
}
command -v sqlite3 >/dev/null || {
	echo "sqlite3 is required locally for consistent database snapshots" >&2
	exit 2
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/plugins"

echo "Snapshotting SQLite databases from $SOURCE..."
while IFS= read -r database; do
	relative="${database#"$SOURCE"/}"
	mkdir -p "$STAGE/$(dirname "$relative")"
	sqlite3 "$database" ".backup '$STAGE/$relative'"
	echo "  $relative"
done < <(find "$SOURCE" -maxdepth 1 -name '*.sqlite' -print | sort)

while IFS= read -r database; do
	relative="${database#"$SOURCE"/}"
	sqlite3 "$database" ".backup '$STAGE/$relative'"
	echo "  $relative"
done < <(find "$SOURCE/plugins" -maxdepth 1 -name '*.sqlite' -print 2>/dev/null | sort)

if [[ -d "$SOURCE/blobs" ]]; then
	echo "Copying blobs..."
	mkdir -p "$STAGE/blobs"
	cp -a "$SOURCE/blobs/." "$STAGE/blobs/"
fi

REMOTE_DATA="$ROOT/data"
echo "Stopping the remote container and copying to $HOST:$REMOTE_DATA..."
ssh -o BatchMode=yes "$HOST" "
	set -euo pipefail
	mkdir -p '$REMOTE_DATA'
	if [[ -f '$ROOT/compose.yaml' ]]; then
		docker compose -f '$ROOT/compose.yaml' --project-directory '$ROOT' stop tsukaima >/dev/null 2>&1 || true
	fi
	rm -rf '$REMOTE_DATA/domain.sqlite' '$REMOTE_DATA/domain.sqlite-wal' '$REMOTE_DATA/domain.sqlite-shm'
	rm -rf '$REMOTE_DATA/durable.sqlite' '$REMOTE_DATA/durable.sqlite-wal' '$REMOTE_DATA/durable.sqlite-shm'
	rm -rf '$REMOTE_DATA/cache.sqlite' '$REMOTE_DATA/cache.sqlite-wal' '$REMOTE_DATA/cache.sqlite-shm'
	mkdir -p '$REMOTE_DATA/plugins'
"
tar -C "$STAGE" -czf - . | ssh -o BatchMode=yes "$HOST" "tar -C '$REMOTE_DATA' -xzf - && chown -R 1000:1000 '$REMOTE_DATA'"
echo "Copied development data. Run the deploy script to start the new revision."
