import { type Request, type Response, type NextFunction } from "express";
import { verifyBotKey } from "../lib/bot-registry.js";

/**
 * Bot auth — reads the key from the Authorization header (not a query
 * param, so it never ends up in access logs or browser history) plus the
 * X-Bot-Id header. Both are required and verified as a pair.
 */

declare global {
  namespace Express {
    interface Request {
      botId: string;
    }
  }
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header("authorization");
  const botId = req.header("x-bot-id")?.trim();

  if (!authHeader?.startsWith("Bearer ") || !botId) {
    res.status(401).json({
      success: false,
      error: "Authorization: Bearer <key> and X-Bot-Id headers are required",
    });
    return;
  }

  const rawKey = authHeader.slice("Bearer ".length).trim();
  if (!rawKey) {
    res.status(401).json({ success: false, error: "Invalid Authorization header" });
    return;
  }

  try {
    const valid = await verifyBotKey(botId, rawKey);
    if (!valid) {
      res.status(401).json({ success: false, error: "Invalid apikey or botId" });
      return;
    }
  } catch (err) {
    req.log.error({ err }, "Bot auth check failed");
    res.status(500).json({ success: false, error: "Internal error" });
    return;
  }

  req.botId = botId;
  next();
}
