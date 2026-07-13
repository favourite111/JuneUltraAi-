import { Router, type IRouter, type Request, type Response } from "express";
import { stats } from "../lib/stats.js";
import { listBots } from "../lib/bot-registry.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

const router: IRouter = Router();

router.get("/", async (_req: Request, res: Response) => {
  let botCount = 0;
  try {
    const bots = await listBots();
    botCount = bots.length;
  } catch {
    botCount = 0;
  }

  res.json({
    version,
    uptimeMs:         stats.uptimeMs,
    startTime:        stats.startTime,
    totalRequests:    stats.totalRequests,
    avgResponseTimeMs: stats.avgResponseTimeMs,
    botCount,
  });
});

export default router;
