# ADR 0008: Use Better Auth for the WebUI administrator

## Status

Accepted.

## Context

The first implementation used a small in-house auth service: argon2id credentials in
`admin_credentials`, in-memory sessions, hand-built cookies, and a process-local sign-in lockout.
That was useful while the HTTP and API surfaces were being established, but it duplicated mature
authentication logic and created avoidable gaps: sessions died on restart, there was no session
management surface, and password/session behavior was outside a maintained library.

The project policy is to prefer mature libraries. Better Auth 1.7 supports Bun, SQLite, Drizzle,
username/password authentication, database sessions, signed cookies, rate limiting, and session
refresh.

## Decision

Use Better Auth as the sole authentication authority for the single WebUI administrator.

- Mount Better Auth's native HTTP handler at `/api/auth/*` on Elysia.
- Enable the username plugin and bootstrap the first user through the server-side Better Auth API.
- Store core auth tables in `domain.sqlite` using the Drizzle adapter.
- Keep only `auth.status` in oRPC for setup guidance and API clients.
- Validate oRPC and SSE requests through `auth.api.getSession` with the raw request headers.
- Reject public sign-up at the Elysia boundary. The in-process bootstrap is the only account creator.
- Use `TSUKAIMA_ADMIN_USERNAME`/`TSUKAIMA_ADMIN_PASSWORD` only while `auth_user` is empty. The database
  remains authoritative afterwards.
- Add optional actor fields to the SDK audit entry so Better Auth hooks and admin RPC calls record
  `admin:<username>` directly.

## Consequences

- Passwords, cookies, sessions, and sign-in throttling are maintained by Better Auth.
- Sessions survive restarts and can be extended by the session-refresh path.
- The WebUI depends on `better-auth/react` for sign-in/sign-out/session commands; TanStack Query
  wraps `getSession` so the rest of the application keeps a single server-state model.
- The public auth surface is broader than three oRPC procedures, so the Elysia mount must preserve
  Better Auth routing, origin checks, and disabled sign-up behavior.
- Sign-in throttling uses an in-process per-instance bucket keyed by client IP. Direct connections
  use Bun's socket peer address rather than trusting client-supplied `X-Forwarded-For`; reverse
  proxies must be explicitly listed in `TSUKAIMA_TRUSTED_PROXIES`.
- Migration `0005` drops the legacy `admin_credentials` table. Argon2id hashes are not portable to
  Better Auth accounts; the pre-deployment upgrade path recreates the administrator from the
  bootstrap environment values.
