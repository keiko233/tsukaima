# ADR 0005: Use Elysia, oRPC, TanStack, beUI, and Drizzle

## Status

Accepted

## Context

Tsukaima needs a strongly typed server API, a modern IM-style admin UI, and a small operational footprint. Bun is already the runtime. The project should avoid manually maintaining client/server types and should reuse mature UI primitives where possible.

## Decision

Use:

- Elysia as the HTTP/WebSocket server.
- oRPC as the typed RPC layer, with Zod schemas.
- TanStack Router, Query, and Form on React.
- oRPC's TanStack Query integration for client calls.
- beUI as the design system and animated component source.
- SQLite and Drizzle ORM for domain data.
- oxlint, oxfmt, commitlint, lint-staged, and Husky for quality gates.

## Consequences

- oRPC contracts are the single source of API types.
- Elysia handles hosting and raw HTTP/WS concerns; oRPC handles procedure typing and validation.
- beUI requires Tailwind CSS and Motion.
- Domain and durable data remain separate SQLite files with separate ownership and migrations.
- Local hooks stay fast; full checks run in CI.
