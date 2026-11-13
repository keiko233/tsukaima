# DSH baseline and audit spec

## Purpose

Preserve the exact deployment baseline used for the Tsukaima parity comparison and prevent future
work from being driven by assumptions about a generic DeepSeek Harness install.

## Current baseline

- Host/project target: configured via CLI flags or environment variables (current audit target:
  `<ssh-target>`, Docker host `docker`, `/opt/dsh-project`), image
  `registry.example.test/dsh:0.0.0-synthetic`, CLI `0.0.0-synthetic`.
- Harness container: `dsh-project-harness-1`.
- Gateway: `gateway.example.test`; NapCat is reachable from the harness at `ws://napcat.test:3001`.
- Persistent volumes: `dsh-home` and `dsh-workspace`.
- Installed bundles: `dsh-base`, `dsh-web-app`, `dshmarket`, `dsh-free-search`, `dsh-mnemon`,
  `dsh-meme`, `@deepseek-ai/dsh-experimental-agent-team-profile`,
  `@hytime/dsh-thinking-effort`, local `dsh-napcat@0.4.4`, and `dsh-purge`.
- The DSH session store is `home/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`.
- Keep deployment host addresses/paths out of runtime defaults and generated repo fixtures.

## Required baseline artifact

Create a reproducible, secret-free audit snapshot containing:

1. image and CLI versions
2. installed profile bundle list and package versions
3. effective plugin IDs and enabled/disabled state
4. DSH/NapCat configuration field names with values mapped to safe classes
5. list of NapCat tools contributed to the model
6. memory source/strategy/provider names and configured spaces
7. meme pack IDs, counts, and schema names, without binary contents
8. schedule task count, status classes, and timing fields
9. session inventory and zstd-compressed JSONL schema field names
10. request ledger and human-profile state field names

## Value classification

Every migration setting must be assigned one of:

| Class | Meaning | Handling |
| --- | --- | --- |
| `safe` | Non-sensitive operational value | Import after mapping. |
| `secret` | Token, key, credential, authorization value | Do not read into reports; configure externally. |
| `identifying` | QQ ID, nickname, group ID, chat content | Include only in the local import snapshot. |
| `policy` | Access/rate/gating/threshold | Map explicitly; do not copy blind. |
| `host-specific` | Local path or DSH plugin internals | Re-map or explicitly discard. |

The report may show `secret: configured/unconfigured` but never the value.

## Compatibility policy

- Reimplement observed user-facing behavior; do not import DSH plugin code.
- Do not copy DSH session data directly into this repository.
- Do not align with `dsh-purge` jailbreak behavior.
- Treat the remote audit as read-only; no live writes or service changes.

## Acceptance

- `docs/migration/dsh.md` points to this audit without exposing values.
- A local fixture represents the remote schema shapes without real chat content or IDs.
- A CLI command emits the baseline inventory with all value classes applied.
- A test proves an unknown credential-like field is not emitted verbatim.
