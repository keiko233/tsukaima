# Migration Kit contract

The Migration Kit is a Bun CLI under `tools/migration`. It must remain usable independently from the server.

## Commands

```sh
bun tools/migration/cli.ts snapshot --source /path/to/dsh-home --source /path/to/dsh-workspace --out /path/to/snapshot
bun tools/migration/cli.ts inspect --snapshot /path/to/snapshot --report /path/to/inventory
bun tools/migration/cli.ts normalize --snapshot /path/to/snapshot --out /path/to/import
bun tools/migration/cli.ts compress --input /path/to/import --model-policy migration.summarize
bun tools/migration/cli.ts dry-run --input /path/to/import --target sqlite:/path/to/tsukaima.db --postgres "$TSUKAIMA_MIGRATION_PGURL"
bun tools/migration/cli.ts import --input /path/to/import --resume
bun tools/migration/cli.ts verify --input /path/to/import --target ...
bun tools/migration/cli.ts rollback --ledger /path/to/ledger --backup /path/to/backup
```

Actual flag names may be adjusted during implementation, but these stages must exist.

## Requirements

- Snapshots are read-only against source data.
- Every stage is resumable and idempotent.
- Every record has source system, source ID, and source hash.
- Every import batch is recorded in a ledger.
- Dry-run is mandatory before import.
- Secrets are detected, redacted in reports, and moved only into the configured secret store.
- LLM compression is optional per conversation and rate-limited.
- Original history is never replaced by a summary.
- Reports must not print chat content by default; content samples require an explicit `--show-content` flag and are still restricted to admin use.
- The kit must run offline for structural steps and only contact Magpie for compression.

## Outputs

- `inventory.json`: files, sessions, plugins, personas, media.
- `mapping.md`: source-to-target mapping and unresolved cases.
- `import/`: canonical JSONL and normalized metadata.
- `derived/`: summaries, extracted memory candidates, persona notes.
- `ledger.jsonl`: every attempted and committed import operation.
- `report.md`: counts, warnings, secrets redacted, errors, manual decisions.
- `backup/`: pre-import target snapshot and rollback notes.
