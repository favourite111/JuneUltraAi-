import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdminKey } from "../middlewares/admin-auth.js";
import {
  registerBot,
  listBots,
  setBotStatus,
  deleteBot,
  regenerateApiKey,
  setBotWebhookUrl,
  regenerateWebhookSecret,
} from "../lib/bot-registry.js";
import { listJobsForBot } from "../lib/job-store.js";

const router: IRouter = Router();

router.use(requireAdminKey);

router.get("/bots", async (_req: Request, res: Response) => {
  const bots = await listBots();
  res.json({ success: true, bots });
});

router.post("/bots", async (req: Request, res: Response) => {
  const { botId, owner } = req.body as { botId?: string; owner?: string };

  if (!botId?.trim() || !owner?.trim()) {
    res.status(400).json({ success: false, error: "botId and owner are required" });
    return;
  }

  try {
    const result = await registerBot(botId.trim(), owner.trim());
    res.status(201).json({
      success: true,
      botId: result.botId,
      apiKey: result.apiKey,
      warning: "Save this key now — it will not be shown again.",
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      res.status(409).json({ success: false, error: "botId already exists" });
      return;
    }
    throw err;
  }
});

router.patch("/bots/:botId", async (req: Request, res: Response) => {
  const botId = req.params["botId"] as string;
  const { status } = req.body as { status?: string };

  if (status !== "active" && status !== "suspended") {
    res.status(400).json({ success: false, error: "status must be 'active' or 'suspended'" });
    return;
  }

  const ok = await setBotStatus(botId, status);
  if (!ok) {
    res.status(404).json({ success: false, error: "Bot not found" });
    return;
  }

  res.json({ success: true, botId, status });
});

router.post("/bots/:botId/regenerate-key", async (req: Request, res: Response) => {
  const botId = req.params["botId"] as string;
  const newKey = await regenerateApiKey(botId);

  if (!newKey) {
    res.status(404).json({ success: false, error: "Bot not found" });
    return;
  }

  res.json({
    success: true,
    botId,
    apiKey: newKey,
    warning: "Save this key now — it will not be shown again.",
  });
});

router.delete("/bots/:botId", async (req: Request, res: Response) => {
  const botId = req.params["botId"] as string;
  const ok = await deleteBot(botId);

  if (!ok) {
    res.status(404).json({ success: false, error: "Bot not found" });
    return;
  }

  res.json({ success: true, message: "Bot and its conversations deleted" });
});

router.patch("/bots/:botId/webhook", async (req: Request, res: Response) => {
  const botId = req.params["botId"] as string;
  const { webhookUrl } = req.body as { webhookUrl?: string | null };

  if (webhookUrl !== null && webhookUrl !== undefined && typeof webhookUrl !== "string") {
    res.status(400).json({ success: false, error: "webhookUrl must be a string or null" });
    return;
  }

  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      res.status(400).json({ success: false, error: "webhookUrl must be a valid URL" });
      return;
    }
  }

  const result = await setBotWebhookUrl(botId, webhookUrl ?? null);
  if (!result) {
    res.status(404).json({ success: false, error: "Bot not found" });
    return;
  }

  res.json({
    success: true,
    botId,
    webhookUrl: result.webhookUrl,
    webhookSecret: result.webhookSecret,
    ...(result.webhookSecret
      ? { note: "Use this secret to verify the X-Signature header on incoming webhook deliveries." }
      : {}),
  });
});

router.post("/bots/:botId/regenerate-webhook-secret", async (req: Request, res: Response) => {
  const botId = req.params["botId"] as string;
  const secret = await regenerateWebhookSecret(botId);

  if (!secret) {
    res.status(404).json({ success: false, error: "Bot not found or has no webhook configured" });
    return;
  }

  res.json({
    success: true,
    botId,
    webhookSecret: secret,
    warning: "Save this secret now — it will not be shown again.",
  });
});

router.get("/bots/:botId/jobs", async (req: Request, res: Response) => {
  const botId = req.params["botId"] as string;
  const type = typeof req.query["type"] === "string" ? req.query["type"] : undefined;
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;

  const jobs = await listJobsForBot(
    botId,
    type,
    status as Parameters<typeof listJobsForBot>[2],
  );

  res.json({ success: true, jobs });
});

export default router;
