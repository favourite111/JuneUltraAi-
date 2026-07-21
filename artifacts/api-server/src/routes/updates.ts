/**
 * GET /updates?apikey=KEY
 *
 * Server-Sent Events stream. Bots connect once on startup and stay connected.
 * The server sends:
 *   - { type: "current", hash, version }  immediately on connect (so bots can
 *     check if they're already on the latest version without fetching the file)
 *   - { type: "update",  hash, version }  whenever a new chatbot.js is detected
 *   - ": heartbeat"  every 30 s (keeps the connection alive through proxies)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  addClient,
  removeClient,
  getCachedHash,
  getCachedVersion,
} from "../lib/github-poller.js";

const router: IRouter = Router();

const DELIVERY_KEY = process.env["CODE_DELIVERY_KEY"] ?? "";

function verifyKey(key: string): boolean {
  if (!DELIVERY_KEY || !key) return false;
  try {
    const a = Buffer.from(DELIVERY_KEY);
    const b = Buffer.from(key);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

router.get("/", (req: Request, res: Response) => {
  const apikey = (req.query["apikey"] as string | undefined) ?? "";

  const deliveryKeyConfigured = DELIVERY_KEY.length > 0;
  const apikeyProvided        = apikey.length > 0;
  req.log.debug(
    { deliveryKeyConfigured, apikeyProvided, apikeyLen: apikey.length, deliveryKeyLen: DELIVERY_KEY.length },
    "GET /updates — key check",
  );

  if (!verifyKey(apikey)) {
    if (!deliveryKeyConfigured) {
      req.log.error(
        "GET /updates → 401: CODE_DELIVERY_KEY env var is not set — bots cannot connect to the SSE stream",
      );
    } else if (!apikeyProvided) {
      req.log.warn("GET /updates → 401: request sent no apikey query param");
    } else {
      req.log.warn(
        { apikeyLen: apikey.length, deliveryKeyLen: DELIVERY_KEY.length },
        "GET /updates → 401: apikey does not match CODE_DELIVERY_KEY",
      );
    }
    res.status(401).json({ success: false, error: "Invalid or missing apikey" });
    return;
  }

  // ── SSE handshake ─────────────────────────────────────────────────────────
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // tell nginx not to buffer
  res.flushHeaders();

  // ── Tell the bot what version is live right now ───────────────────────────
  const hash    = getCachedHash();
  const version = getCachedVersion();
  if (hash) {
    res.write(`data: ${JSON.stringify({ type: "current", hash, version })}\n\n`);
  }

  // ── Register for future broadcasts ────────────────────────────────────────
  addClient(res);
  req.log.info("SSE client connected");

  // ── Keep connection alive through load-balancers / proxies ────────────────
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  // ── Clean up on disconnect ────────────────────────────────────────────────
  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(res);
    req.log.info("SSE client disconnected");
  });
});

export default router;
