# JUNE_ULTRA_AI API Server

A production-ready Express chat API that powers the JUNE_ULTRA_AI persona — a casual, emoji-rich AI character. Supports multiple bots, private (DM) and group chats, with per-conversation memory stored in Neon PostgreSQL.

## Stack

- **Runtime:** Node.js 24, TypeScript, ESM
- **Framework:** Express v5
- **Build:** esbuild (bundles to `dist/index.mjs`)
- **Database:** Neon PostgreSQL (bot registry + conversation history, persistent across restarts)
- **Auth:** Argon2id-hashed API keys, cached verification, per-bot + per-user rate limiting
- **Logging:** Pino + pino-pretty
- **Package manager:** pnpm workspace

## Workspace layout

```
artifacts/api-server/
  src/
    lib/
      db.ts                   # Shared Neon/postgres client
      schema.ts                # DDL for bots + conversations tables, starts cleanup job
      crypto.ts                 # API key generation + Argon2id hash/verify
      bot-registry.ts           # Bot CRUD + verification cache (5 min TTL, invalidated on mutation)
      conversation-store.ts     # History read/append/reset, lazy + hourly expiry sweep
      logger.ts
    middlewares/
      auth.ts                  # Bearer + X-Bot-Id header verification (bot chat routes)
      admin-auth.ts             # Separate ADMIN_KEY check (admin routes), constant-time compare
      rate-limit.ts             # Per-bot and per-bot+user in-memory rate limiter
    routes/
      chat.ts                  # /v1/chat — GET/POST/DELETE
      admin.ts                  # /v1/admin/bots — register/list/patch/regenerate-key/delete
      health.ts                 # /api/healthz
openapi.yaml                    # Agreed API contract
lib/api-zod/                    # Shared Zod schemas (@workspace/api-zod)
lib/db/                         # Shared DB utilities (@workspace/db)
```

## Required secrets (Replit Secrets)

| Secret | Description |
|--------|-------------|
| `NEON_DATABASE_URL` | Neon PostgreSQL connection string |
| `ADMIN_KEY` | Long random string protecting `/v1/admin/*`. Separate from any bot API key. |

Optional:
- `CONVERSATION_TTL_MS` — inactivity timeout before history is cleared (default: 86400000 = 24 hours)
- `HISTORY_LIMIT` — max messages kept per conversation (default: 40)
- `RATE_LIMIT_BOT_PER_MIN` — requests/min per bot (default: 60)
- `RATE_LIMIT_USER_PER_MIN` — requests/min per bot+user (default: 10)

`API_KEYS` is no longer used — bots are now managed via the `/v1/admin/bots` API and stored in Neon.

## Authentication model

- **Chat routes** (`/v1/chat`): require `Authorization: Bearer <bot api key>` + `X-Bot-Id: <botId>` headers. Both are required and verified as a pair — a leaked key alone is useless without its matching `botId`, and a mismatched pair is always rejected. Keys are stored as Argon2id hashes and never logged (auth headers are redacted in logs); verification results are cached ~5 minutes per (botId, key) pair for latency, but the cache is invalidated immediately on suspend/delete/regenerate.
- **Admin routes** (`/v1/admin/*`): require `Authorization: Bearer <ADMIN_KEY>`, compared in constant time. Bot keys never work here.

## Conversation key scheme

| Chat type | Key |
|-----------|-----|
| Private / DM | `botId::userId` |
| Group | `botId::groupId::userId` |

Each group member's history stays isolated even though they share a `groupId`; the AI still sees who's speaking via the `speaker` field on each message.

## Tool Registry (Phase 1)

`/v1/chat` now routes each message through a deterministic Tool Registry (`artifacts/api-server/src/lib/tools/`) before falling back to the AI. Each tool is self-contained (metadata + intent matching + argument extraction + execution + response formatting) and the chat route never contains tool-specific logic — adding a tool means adding a file to `lib/tools/` and registering it in `registry.ts`.

Response envelope now includes `handledBy: "tool" | "ai"`. Tool responses add `tool`, `type` (`text | image | audio | document | sticker`), and a `data` payload; `reply` is always present as a text fallback/caption. Tools return whatever they naturally produce (a passthrough URL from an external API, or a base64 buffer for locally generated content) — the chatbot service has no object storage dependency; the calling client decides how to deliver media.

Tools implemented so far (all synchronous, no DB/scheduling):
- `url_shortener` — "shorten this url ..." → TinyURL
- `qrcode` — "qr code for ..." → base64 PNG via the `qrcode` package
- `website_screenshot` — "screenshot of ..." → `eliteprotech-apis.zone.id/ssweb`

Tool matching notes:
- Each tool matches a list of alias phrases (`utils.containsAnyPhrase`), not a single regex — e.g. the shortener recognizes "shorten/shrink/trim/compress/tinyurl/make it shorter/...".
- Matching is word-boundary anchored (so "shorten" won't fire inside "shortened") and, for tools that need a link, requires an actual URL in the message alongside the trigger phrase — this is what keeps normal conversation from accidentally triggering a tool.
- Registry order (`registry.ts`) is the deterministic priority order: first match wins. Current tools' trigger phrases don't overlap; if a future tool's phrases could collide with an existing one, order matters and should be commented.
- Shared helpers live in `lib/tools/utils.ts` (`containsAnyPhrase`, `extractUrl`, `fetchOrThrow`, `textResult`/`imageResult`) so tools don't duplicate HTTP/formatting code.

Phase 2 added `text_to_pdf` (via `pdfkit`) — triggers on action+"pdf" phrases like "convert to pdf", "create a pdf", "turn this into a pdf" (never a bare "pdf" mention, to avoid false positives), and requires leftover text content after stripping the command phrase. Note: `pdfkit`'s standard fonts are loaded from `.afm` files at runtime relative to `__dirname`, which esbuild's bundling doesn't preserve — `build.mjs` has a post-build step that copies `pdfkit`'s `data/` directory next to the bundle; this pattern will be needed again for any future library that loads assets from disk at runtime.

Planned next: a stateful Reminder tool (Phase 3) with a `reminders` table, a scheduler sweep, and signed-HMAC webhook delivery to a per-bot `webhookUrl` (3 retries, exponential backoff, delivery history).

## API endpoints

See `artifacts/api-server/openapi.yaml` for the full contract. Summary:

### `GET /api/healthz` — no auth
`{"status":"ok"}`

### `GET|POST /v1/chat` — bot auth + rate limit
Body/query: `prompt`, `userId` (required), `groupId` (optional).
Response: `{ "success": true, "reply": "...", "model": "JUNE_ULTRA_AI", "conversationKey": "..." }`

### `DELETE /v1/chat` — bot auth
Resets a conversation. Body/query: `userId` (required), `groupId` (optional).

### `POST /v1/admin/bots` — admin auth
Registers a bot. Body: `{ "botId", "owner" }`. Returns the raw API key **once** — it is never shown again.

### `GET /v1/admin/bots` — admin auth
Lists all bots (no keys returned).

### `PATCH /v1/admin/bots/:botId` — admin auth
Body: `{ "status": "active" | "suspended" }`.

### `POST /v1/admin/bots/:botId/regenerate-key` — admin auth
Rotates a bot's key without deleting it. Old key stops working immediately. Returns the new raw key once.

### `DELETE /v1/admin/bots/:botId` — admin auth
Deletes a bot and cascades to its conversations.

## Error responses

All errors follow `{ "success": false, "error": "..." }`:

| Status | Cause |
|--------|-------|
| 401 | Missing/invalid auth headers, invalid or mismatched bot key, wrong admin key |
| 400 | Missing required field |
| 409 | Duplicate `botId` on registration |
| 429 | Rate limit exceeded (per-bot or per-bot+user) |
| 502 | Upstream AI service unavailable |
| 500 | Internal server error |
| 503 | Admin API not configured (`ADMIN_KEY` unset) |

## Running locally (Replit)

The workflow `artifacts/api-server: API Server` runs:
```
pnpm --filter @workspace/api-server run dev
```
Builds via esbuild, then starts on `PORT`, ensures the Neon schema exists, and starts the hourly conversation cleanup sweep.

Set up on this Replit workspace (2026-07-11):
- `PORT=8080` is set as a shared env var (the server requires `PORT` and has no default).
- `NEON_DATABASE_URL` and `ADMIN_KEY` are set as Replit Secrets.
- Health check: `GET /api/healthz` on port 8080.

## Deploying to Koyeb / Render

The `Dockerfile` is a self-contained multi-stage build — push the whole repo to GitHub and point Koyeb/Render at it.

Required environment variables on the host:
- `NEON_DATABASE_URL` — your Neon connection string
- `ADMIN_KEY` — admin secret
- `PORT` — set automatically by Koyeb/Render

## User preferences

- Deploying to Koyeb (not Replit Deploy)
- Conversation history + bot registry in Neon PostgreSQL (not in-memory, not env vars)
- 24-hour inactivity TTL
- `botId` always verified server-side against its API key, never trusted from the client alone
- Bot auth via `Authorization: Bearer` + `X-Bot-Id` headers (not query params — avoids leaking keys into logs)
- Admin routes protected by a separate `ADMIN_KEY`, distinct from bot keys
