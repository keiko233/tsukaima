# ADR 0006: Use a bot-domain plugin SDK with selective Pi/Cordis/Chord concepts

## Status

Accepted

## Context

Tsukaima requires bot-native plugins for hooks, tools, UI, channel actions, memory, and durable tasks. Three useful sources exist:

- Cordis offers lifecycle, DI, events, config validation, fibers, isolation, and reload, but is an unstable RC meta-framework.
- Pi coding-agent extensions offer mature tool/provider/MCP APIs but are coding-agent-centric.
- Pi Chord offers typed reloadable objects, workers, registries, and web facets, but overlaps with the selected Elysia/oRPC/TanStack stack and is larger than the first release needs.

DSH uses a vendored Cordis fork and host-specific plugin APIs, so DSH plugins are not directly compatible with either public Cordis or a new SDK.

## Decision

Implement a small Tsukaima plugin SDK:

1. `pi-durable` remains the conversation/task authority.
2. Pi concepts are used for coding/self-iteration and MCP/provider/tool registration.
3. Bot plugin lifecycle, storage, UI, policy, and permissions are defined by Tsukaima.
4. Borrow Cordis concepts for lifecycle/config/event modes/isolation/reload without depending on Cordis.
5. Borrow Chord concepts for API versioning, worker isolation, reload semantics, registries, and data-only UI contributions.
6. Reimplement required DSH plugin behavior; do not install DSH plugins.

## Consequences

- Plugin authors see one narrow, typed, permissioned SDK.
- Core runtime avoids unstable generic framework dependencies.
- More initial code is Tsukaima-specific, but each plugin contract remains auditable.
- Future migration to Chord or another framework is possible only if the public SDK stays independent of internals.
- Cordis/Chord remain design references, not runtime dependencies.
