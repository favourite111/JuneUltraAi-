import { Router, type IRouter, type Request, type Response } from "express";
import { stats } from "../lib/stats.js";
import { listBots } from "../lib/bot-registry.js";

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
    uptimeMs:         stats.uptimeMs,
    startTime:        stats.startTime,
    totalRequests:    stats.totalRequests,
    avgResponseTimeMs: stats.avgResponseTimeMs,
    botCount,
  });
});

export default router;
