# JUNE_ULTRA_AI

**JUNE_ULTRA_AI** is a production-ready, multi-tenant, persona-driven chat REST API built with Express v5 and TypeScript (ESM). It powers a casual AI persona named "JUNE"—a fake human who texts like a real person, uses emojis, has personality, and remembers things about users.

The API is designed to power any messaging front-end, such as WhatsApp (via Baileys), Telegram bots, or custom clients. Each deployment is a "bot" registered via the admin API with its own API key, isolated conversation history, and per-user memory.

## 🌟 Key Features

- **Hybrid Deterministic + Generative Architecture:** Known intents (URL shortening, QR codes, screenshots, PDF generation) are intercepted by a deterministic Tool Registry before any AI call. Identity and meta-questions use hardcoded replies. Only genuine conversations hit the AI backend (Shizo API).
- **Multi-Tenant by Design:** All data (conversations, user facts) is scoped to `(botId, userId)`. One server instance can run hundreds of bots simultaneously with zero configuration changes.
- **Persistence-First:** Conversation history and user facts survive restarts via Neon PostgreSQL. Nothing important is kept in-memory only.
- **Secret-Safe:** API keys are stored as Argon2id hashes, auth headers are redacted from logs, and no secrets are passed in query parameters.
- **Push-Update System:** The server acts as a "radio station" that polls GitHub and broadcasts updates to all connected bots via Server-Sent Events (SSE), enabling zero-downtime hot-swaps.

## 🛠️ Tech Stack

- **Runtime:** Node.js 24, TypeScript, ESM
- **Framework:** Express v5
- **Database:** Neon PostgreSQL (via `postgres.js`)
- **Authentication:** Argon2id hashing for API keys
- **Logging:** Pino + `pino-pretty`
- **Build Tool:** esbuild (custom `build.mjs` pipeline)
- **Package Manager:** pnpm workspace

## 🚀 Getting Started

### Prerequisites

- Node.js 24+
- pnpm
- A Neon PostgreSQL database (or Replit's built-in PostgreSQL)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/favourite111/JuneUltraAi-.git
   cd JuneUltraAi-
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Set up environment variables (e.g., in a `.env` file or Replit Secrets):
   - `PORT`: The port the server will listen on (e.g., `8080`).
   - `NEON_DATABASE_URL`: Your Neon PostgreSQL connection string.
   - `ADMIN_KEY`: A secure string protecting `/v1/admin/*` routes.

### Running the Server

- **Development Mode (Build + Start):**
  ```bash
  pnpm --filter @workspace/api-server run dev
  ```

- **Build Only:**
  ```bash
  pnpm --filter @workspace/api-server run build
  ```

- **Start Production Server:**
  ```bash
  pnpm --filter @workspace/api-server run start
  ```

## 📚 API Endpoints

### Public Endpoints
- `GET /api/healthz`: Health check endpoint. Returns `{"status":"ok"}`.
- `GET /api/stats`: Returns runtime metrics and bot count.

### Chat Endpoints (Requires Bot Auth)
- `GET|POST /v1/chat`: Main chat handler. Requires `prompt` and `userId`.
- `DELETE /v1/chat`: Resets a conversation for a specific `userId`.

### Admin Endpoints (Requires Admin Auth)
- `GET /v1/admin/bots`: List all registered bots.
- `POST /v1/admin/bots`: Register a new bot.
- `PATCH /v1/admin/bots/:botId`: Suspend or activate a bot.
- `POST /v1/admin/bots/:botId/regenerate-key`: Rotate a bot's API key.
- `DELETE /v1/admin/bots/:botId`: Delete a bot and its conversations.

## 🔐 Authentication

- **Bot Routes (`/v1/chat`):** Require `Authorization: Bearer <bot_api_key>` and `X-Bot-Id: <botId>` headers.
- **Admin Routes (`/v1/admin/*`):** Require `Authorization: Bearer <ADMIN_KEY>`.

## 🧠 Memory System

JUNE_ULTRA_AI features a sophisticated memory system that extracts and persists objective personal facts (e.g., name, language, location, likes/dislikes) from user messages. These facts are stored separately from conversation history and persist even if the conversation is reset.

## 🧰 Tool Registry

The deterministic Tool Registry handles specific intents without calling the AI:
- **URL Shortener:** Converts long URLs to TinyURLs.
- **QR Code Generator:** Generates base64 PNG QR codes.
- **Website Screenshot:** Captures screenshots of provided URLs.
- **Text to PDF:** Converts text into a downloadable PDF document.

## 📄 Documentation

For deeper technical details, please refer to the following documents in the repository:
- `PROJECT_CONTEXT.md`: Comprehensive project overview and knowledge base.
- `ARCHITECTURE.md`: Detailed architecture and handoff document.
- `replit.md`: Deployment notes and user preferences.

---
*Built with ❤️ by the JUNE_ULTRA_AI Team.*
