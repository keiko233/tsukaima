# ADR 0001: Use Bun as the runtime

## Status

Accepted

## Context

Tsukaima needs one modern TypeScript runtime for server, workers, CLI tools, tests, and build scripts. Bun offers a built-in SQLite driver, fast startup, native test runner, and built-in HTTP/WebSocket support. Pi's model and coding-agent layers already include Bun compatibility paths.

## Decision

Use Bun as the primary runtime and toolchain.

## Consequences

- Use `bun:sqlite` through a dedicated adapter for `pi-durable`.
- Validate PostgreSQL client compatibility before locking dependency versions.
- Keep pure/domain code runtime-neutral so it can run under Node if a blocker appears.
- Pin a specific Bun version in the test workflow and Dockerfiles.
