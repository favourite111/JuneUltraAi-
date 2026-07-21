import { type Response } from "express";
import { logger } from "./logger.js";

// ── Config ────────────────────────────────────────────────────────────────────
const GITHUB_TOKEN  = (process.env["GITHUB_TOKEN"]           ?? "").trim();
const GITHUB_OWNER  = (process.env["GITHUB_OWNER"]           ?? "").trim();
const GITHUB_REPO   = (process.env["GITHUB_REPO"]            ?? "").trim();
const GITHUB_FILE   = (process.env["GITHUB_FILE_PATH"]       ?? "chatbot.js").trim();
const GITHUB_BRANCH = (process.env["GITHUB_BRANCH"]          ?? "main").trim();
const POLL_MS       = Number(process.env["GITHUB_POLL_INTERVAL_MS"] ?? "300000");

// ── In-memory state ───────────────────────────────────────────────────────────
let _code:    string | null = null;
let _hash:    string | null = null;
let _version: string | null = null;

const _clients = new Set<Response>();

// ── Public getters ────────────────────────────────────────────────────────────
export const getCachedCode    = () => _code;
export const getCachedHash    = () => _hash;
export const getCachedVersion = () => _version;
export const connectedClients = () => _clients.size;

// ── SSE client registry ───────────────────────────────────────────────────────
export function addClient(res: Response): void    { _clients.add(res); }
export function removeClient(res: Response): void { _clients.delete(res); }

// ── Broadcast to all connected bots ──────────────────────────────────────────
function broadcast(payload: object): void {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of _clients) {
    try {
      client.write(msg);
    } catch {
      // Dead connection — drop it
      _clients.delete(client);
    }
  }
}

// ── Extract version string from code ─────────────────────────────────────────
function extractVersion(code: string, sha: string): string {
  const m = code.match(/version\s*[=:]\s*['"`]([^'"`\r\n]+)['"`]/);
  return m?.[1] ?? sha.slice(0, 7);
}

// ── GitHub Contents API call ──────────────────────────────────────────────────
interface GitHubContentsResponse {
  content?: string;
  sha?: string;
  message?: string;
}

async function poll(): Promise<void> {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    logger.warn(
      "GitHub poller: GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO not set — skipping poll",
    );
    return;
  }

  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
    `/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`;

  logger.info({ url }, "GitHub poller: fetching");

  let fetchRes: globalThis.Response;
  try {
    fetchRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept:        "application/vnd.github.v3+json",
        "User-Agent":  "JUNE-Server/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error({ err, url }, "GitHub poller: network error — check internet access or GitHub reachability");
    return;
  }

  if (!fetchRes.ok) {
    // Read the body so we can show the GitHub error message (e.g. "Bad credentials", "Not Found")
    let body: unknown;
    try { body = await fetchRes.json(); } catch { body = await fetchRes.text().catch(() => "(unreadable)"); }
    logger.error(
      { status: fetchRes.status, url, body },
      "GitHub poller: API error — common causes: wrong token (401), wrong owner/repo/file (404), rate limited (403/429)",
    );
    return;
  }

  const data = (await fetchRes.json()) as GitHubContentsResponse;

  if (!data.sha || !data.content) {
    logger.error(
      { githubMessage: data.message, url },
      "GitHub poller: unexpected response shape — file path may be wrong or it's a directory, not a file",
    );
    return;
  }

  // No change — nothing to do
  if (data.sha === _hash) return;

  const code    = Buffer.from(data.content, "base64").toString("utf8");
  const version = extractVersion(code, data.sha);

  _code    = code;
  _hash    = data.sha;
  _version = version;

  logger.info(
    { sha: data.sha.slice(0, 7), version, clients: _clients.size },
    "GitHub poller: new version — broadcasting UPDATE",
  );
  broadcast({ type: "update", hash: data.sha, version });
}

// ── Startup env-var banner (printed before anything else) ─────────────────────
export function logPollerEnvStatus(): void {
  // Show lengths so paste/copy errors (extra space, truncated value) are obvious
  logger.info(
    {
      GITHUB_TOKEN:              GITHUB_TOKEN  ? `✅ set (${GITHUB_TOKEN.length} chars)` : "❌ MISSING",
      GITHUB_OWNER:              GITHUB_OWNER  ? `✅ "${GITHUB_OWNER}"`                  : "❌ MISSING",
      GITHUB_REPO:               GITHUB_REPO   ? `✅ "${GITHUB_REPO}"`                   : "❌ MISSING",
      GITHUB_FILE_PATH:          GITHUB_FILE,
      GITHUB_BRANCH:             GITHUB_BRANCH,
      GITHUB_POLL_INTERVAL_MS:   POLL_MS,
      CODE_DELIVERY_KEY:         (process.env["CODE_DELIVERY_KEY"] ?? "").length > 0
                                   ? `✅ set (${(process.env["CODE_DELIVERY_KEY"] ?? "").length} chars)`
                                   : "❌ MISSING — bots will get 401 on /code and /updates",
    },
    "=== GitHub Poller env vars ===",
  );
}

// ── Start ─────────────────────────────────────────────────────────────────────
export function startPoller(): void {
  logPollerEnvStatus();

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    logger.error(
      { impact: "GET /code/chatbot.js will always return 503 until the poller fetches code from GitHub" },
      "GitHub poller disabled — one or more required env vars are MISSING (see banner above)",
    );
    return;
  }

  // Kick off immediately, then on a fixed interval
  poll().catch((err) => logger.error({ err }, "GitHub poller: initial poll failed"));
  setInterval(
    () => poll().catch((err) => logger.error({ err }, "GitHub poller: poll failed")),
    POLL_MS,
  );

  logger.info(
    { intervalMs: POLL_MS, file: `${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_FILE}@${GITHUB_BRANCH}` },
    "GitHub poller started",
  );
}
