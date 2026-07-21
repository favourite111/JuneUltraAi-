/**
 * GET /code/chatbot.js?apikey=KEY
 *
 * Serves the latest chatbot.js fetched from GitHub.
 * Bots hit this after receiving an UPDATE event on the /updates SSE stream.
 */
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { getCachedCode, getCachedHash, getCachedVersion } from "../lib/github-poller.js";

const router = Router();

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

router.get("/chatbot.js", (req: Request, res: Response) => {
  const apikey = (req.query["apikey"] as string | undefined) ?? "";

  if (!verifyKey(apikey)) {
    res.status(401).json({ success: false, error: "Invalid or missing apikey" });
    return;
  }

  const code = getCachedCode();
  if (!code) {
    res
      .status(503)
      .json({ success: false, error: "Not ready — server is still fetching the latest code" });
    return;
  }

  const hash    = getCachedHash();
  const version = getCachedVersion();

  res.setHeader("Content-Type",  "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (hash)    res.setHeader("x-hash",    hash);
  if (version) res.setHeader("x-version", version);

  res.send(code);
});

export default router;
