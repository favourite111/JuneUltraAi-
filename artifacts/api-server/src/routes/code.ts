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

  // Debug: log key verification details (never log the actual key values)
  const deliveryKeyConfigured = DELIVERY_KEY.length > 0;
  const apikeyProvided        = apikey.length > 0;
  req.log.debug(
    { deliveryKeyConfigured, apikeyProvided, apikeyLen: apikey.length, deliveryKeyLen: DELIVERY_KEY.length },
    "GET /code/chatbot.js — key check",
  );

  if (!verifyKey(apikey)) {
    if (!deliveryKeyConfigured) {
      req.log.error(
        "GET /code/chatbot.js → 401: CODE_DELIVERY_KEY env var is not set — set it so bots can authenticate",
      );
    } else if (!apikeyProvided) {
      req.log.warn("GET /code/chatbot.js → 401: request sent no apikey query param");
    } else {
      req.log.warn(
        { apikeyLen: apikey.length, deliveryKeyLen: DELIVERY_KEY.length },
        "GET /code/chatbot.js → 401: apikey does not match CODE_DELIVERY_KEY (length or content mismatch)",
      );
    }
    res.status(401).json({ success: false, error: "Invalid or missing apikey" });
    return;
  }

  const code = getCachedCode();
  if (!code) {
    req.log.error(
      "GET /code/chatbot.js → 503: no code cached yet — GitHub poller has not fetched chatbot.js. " +
      "Check that GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO are set, and look for poller errors above.",
    );
    res
      .status(503)
      .json({ success: false, error: "Not ready — server is still fetching the latest code" });
    return;
  }

  const hash    = getCachedHash();
  const version = getCachedVersion();
  req.log.info({ hash: hash?.slice(0, 7), version }, "GET /code/chatbot.js → 200: serving cached code");

  res.setHeader("Content-Type",  "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (hash)    res.setHeader("x-hash",    hash);
  if (version) res.setHeader("x-version", version);

  res.send(code);
});

export default router;
