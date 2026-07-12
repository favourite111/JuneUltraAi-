import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdminKey } from "../middlewares/admin-auth.js";
import { registerBot, listBots, setBotStatus, deleteBot, regenerateApiKey } from "../lib/bot-registry.js";

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

export default router;
