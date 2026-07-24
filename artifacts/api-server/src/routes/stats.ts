import { Router, type IRouter, type Request, type Response } from "express";
import { stats } from "../lib/stats.js";
import { listBots } from "../lib/bot-registry.js";
import { metricsCollector } from "../lib/memory-singletons.js";
import { plannerMetrics } from "../lib/planner/index.js";
import { reasonerMetrics } from "../lib/reasoner/index.js";
import { orchestratorMetrics } from "../lib/orchestrator/index.js";
import { toolIntelligenceMetrics } from "../lib/tool-intelligence/index.js";
import { toolLearningMetrics } from "../lib/tool-learning/index.js";

// Injected at build time by esbuild define — no runtime file I/O
declare const __APP_VERSION__: string;

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
    version: __APP_VERSION__,
    uptimeMs:          stats.uptimeMs,
    startTime:         stats.startTime,
    totalRequests:     stats.totalRequests,
    avgResponseTimeMs: stats.avgResponseTimeMs,
    botCount,
    memory:            metricsCollector.snapshot(),
    planning:          plannerMetrics.snapshot(),
    reasoning:         reasonerMetrics.snapshot(),
    execution:         orchestratorMetrics.snapshot(),
    tool_intelligence: toolIntelligenceMetrics.snapshot(),
    tool_learning:     toolLearningMetrics.snapshot(),
  });
});

export default router;
