---
name: Replit built-in Postgres uses sslmode=disable
description: Why a postgres.js client hardcoded to ssl:"require" fails against Replit's provisioned DATABASE_URL, and how to handle it.
---

Replit's built-in/provisioned PostgreSQL `DATABASE_URL` includes `?sslmode=disable` in
the connection string. A `postgres` (postgres.js) client constructed with a hardcoded
`ssl: "require"` option will fail to connect against it with an opaque
`Client network socket disconnected before secure TLS connection was established`
(`ECONNRESET`) error — the server never negotiates TLS because the app forced it on
top of a connection string that explicitly disables it.

**Why:** Some imported/external projects hardcode `ssl: "require"` because they were
written against a different Postgres provider (e.g. Neon) that always requires TLS.
That assumption breaks silently against Replit's own database.

**How to apply:** When wiring a project's DB client to Replit's built-in Postgres,
derive the `ssl` option from the connection string itself instead of hardcoding it,
e.g. `ssl: /sslmode=disable/.test(url) ? false : "require"`. More generally, when a
Postgres client from an imported project fails to connect only with a TLS/handshake
error (not auth/host errors), check whether the connection string's `sslmode` conflicts
with a hardcoded `ssl` option in the client config before assuming credentials are wrong.
