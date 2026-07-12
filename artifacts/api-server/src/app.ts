import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import adminRouter from "./routes/admin.js";
import { logger } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: Request) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: Response) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (mascot image, etc.) from dist/static at runtime
app.use(express.static(path.join(__dirname, "static")));

// Root landing page — fixes "Cannot GET /" on Render
app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>JUNE_ULTRA_AI</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0d0d0d;font-family:'Segoe UI',sans-serif;color:#fff}
    .card{text-align:center;padding:40px 32px;max-width:420px;width:90%}
    .mascot{width:220px;height:220px;object-fit:contain;margin-bottom:24px;
      border-radius:20px}
    .badge{display:inline-block;background:#1a1a2e;border:1px solid #7c3aed;
      color:#a78bfa;font-size:11px;font-weight:600;letter-spacing:2px;
      padding:5px 14px;border-radius:99px;margin-bottom:16px;text-transform:uppercase}
    h1{font-size:2.2rem;font-weight:800;letter-spacing:-1px;
      background:linear-gradient(135deg,#a78bfa,#ec4899);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
    .tagline{color:#9ca3af;font-size:.95rem;margin-bottom:28px}
    .status{display:flex;align-items:center;justify-content:center;gap:8px;
      background:#0f2a1a;border:1px solid #16a34a;border-radius:12px;
      padding:11px 22px;font-size:.9rem;color:#4ade80;font-weight:500}
    .dot{width:8px;height:8px;border-radius:50%;background:#4ade80;
      animation:pulse 1.8s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .footer{margin-top:32px;color:#4b5563;font-size:.78rem}
    .footer span{color:#7c3aed}
  </style>
</head>
<body>
  <div class="card">
    <img class="mascot" src="/mascot.jpg" alt="JUNE mascot"/>
    <div class="badge">⚡ Live</div>
    <h1>JUNE_ULTRA_AI</h1>
    <p class="tagline">Your AI — coded by impeccable &amp; supreme 😎</p>
    <div class="status">
      <div class="dot"></div>
      API is online and ready
    </div>
    <p class="footer">Coded by <span>impeccable &amp; supreme</span></p>
  </div>
</body>
</html>`);
});

app.use("/api", healthRouter); // GET /api/healthz
app.use("/v1/chat", chatRouter); // GET/POST/DELETE /v1/chat
app.use("/v1/admin", adminRouter); // /v1/admin/bots...

export default app;
