import { type Request, type Response, type NextFunction } from "express";

/**
 * In-memory fixed-window rate limiter, applied at two levels:
 *  - per botId       (protects the API from a single bot going rogue)
 *  - per botId+userId (protects a bot from a single abusive user)
 *
 * In-memory means limits are per-process. Fine for a single-instance
 * deployment; swap for a Redis-backed limiter if you scale horizontally.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

function makeLimiter(limitPerMin: number) {
  const buckets = new Map<string, Bucket>();
  const windowMs = 60_000;

  return function check(key: string): boolean {
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (bucket.count >= limitPerMin) return false;
    bucket.count++;
    return true;
  };
}

const BOT_LIMIT_PER_MIN = Number(process.env["RATE_LIMIT_BOT_PER_MIN"] ?? 60);
const USER_LIMIT_PER_MIN = Number(process.env["RATE_LIMIT_USER_PER_MIN"] ?? 10);

const checkBotLimit = makeLimiter(BOT_LIMIT_PER_MIN);
const checkUserLimit = makeLimiter(USER_LIMIT_PER_MIN);

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const botId = req.botId;

  if (!checkBotLimit(botId)) {
    res.status(429).json({ success: false, error: "Rate limit exceeded for this bot" });
    return;
  }

  const body = { ...req.query, ...(req.body as Record<string, unknown>) } as Record<string, string>;
  const userId = body["userId"]?.trim();

  if (userId && !checkUserLimit(`${botId}:${userId}`)) {
    res.status(429).json({ success: false, error: "Rate limit exceeded for this user" });
    return;
  }

  next();
}
