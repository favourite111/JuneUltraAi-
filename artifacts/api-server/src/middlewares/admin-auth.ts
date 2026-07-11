import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison to avoid leaking key length/prefix via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Protects /v1/admin/* with a separate admin key — bot keys never work here. */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env["ADMIN_KEY"];
  if (!adminKey) {
    res.status(503).json({ success: false, error: "Admin API is not configured" });
    return;
  }

  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Authorization: Bearer <admin key> is required" });
    return;
  }

  const provided = authHeader.slice("Bearer ".length).trim();
  if (!safeEqual(provided, adminKey)) {
    res.status(401).json({ success: false, error: "Invalid admin key" });
    return;
  }

  next();
}
