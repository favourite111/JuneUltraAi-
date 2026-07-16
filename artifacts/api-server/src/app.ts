import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import adminRouter from "./routes/admin.js";
import statsRouter from "./routes/stats.js";
import { logger } from "./lib/logger.js";
import { stats } from "./lib/stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: Request) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res: Response) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
// CORS — allow all origins (public bot API; tighten if needed via ALLOWED_ORIGINS env var)
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim());
app.use(cors({
  origin: allowedOrigins?.length ? allowedOrigins : true,
  methods: ["GET", "POST", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Bot-Id", "X-Client-Ver"],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Request stats tracking middleware ─────────────────────────────────────────
// Exclude /api/stats itself so the landing page polling doesn't inflate the count
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/stats")) { next(); return; }
  const start = Date.now();
  res.on("finish", () => stats.recordRequest(Date.now() - start));
  next();
});

// Serve static files from dist/static at runtime
app.use(express.static(path.join(__dirname, "static")));

// ── Cyberpunk landing page ────────────────────────────────────────────────────
app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>JUNE_ULTRA_AI</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');

    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

    :root {
      --neon-purple: #bf5fff;
      --neon-pink:   #ff2d78;
      --neon-cyan:   #00f5ff;
      --dark:        #060610;
      --card-bg:     rgba(255,255,255,0.03);
    }

    body {
      min-height: 100vh;
      background: var(--dark);
      font-family: 'Share Tech Mono', monospace;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow-x: hidden;
    }

    /* animated grid background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(191,95,255,.07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(191,95,255,.07) 1px, transparent 1px);
      background-size: 40px 40px;
      animation: gridMove 20s linear infinite;
      pointer-events: none;
    }
    @keyframes gridMove {
      0%   { background-position: 0 0; }
      100% { background-position: 40px 40px; }
    }

    /* floating particles */
    .particles { position:fixed; inset:0; pointer-events:none; overflow:hidden; }
    .particle {
      position: absolute;
      border-radius: 50%;
      animation: float linear infinite;
      opacity: 0;
    }
    @keyframes float {
      0%   { transform: translateY(100vh) scale(0); opacity:0; }
      10%  { opacity: .6; }
      90%  { opacity: .3; }
      100% { transform: translateY(-10vh) scale(1); opacity:0; }
    }

    .wrap {
      position: relative;
      z-index: 1;
      text-align: center;
      padding: 40px 20px 60px;
      width: 100%;
      max-width: 480px;
    }

    /* avatar */
    .avatar-ring {
      position: relative;
      width: 140px;
      height: 140px;
      margin: 0 auto 28px;
    }
    .avatar-ring::before, .avatar-ring::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      background: conic-gradient(var(--neon-purple), var(--neon-pink), var(--neon-cyan), var(--neon-purple));
      animation: spin 4s linear infinite;
      z-index: 0;
    }
    .avatar-ring::after {
      filter: blur(8px);
      opacity: .6;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .avatar-ring img {
      position: relative;
      z-index: 1;
      width: 134px;
      height: 134px;
      border-radius: 50%;
      object-fit: cover;
      border: 3px solid var(--dark);
    }

    /* live badge */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(191,95,255,.12);
      border: 1px solid var(--neon-purple);
      color: var(--neon-purple);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 3px;
      padding: 4px 14px;
      border-radius: 99px;
      margin-bottom: 14px;
      text-transform: uppercase;
      box-shadow: 0 0 12px rgba(191,95,255,.3);
    }
    .badge-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--neon-purple);
      animation: blink 1.2s ease-in-out infinite;
      box-shadow: 0 0 6px var(--neon-purple);
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }

    /* title */
    h1 {
      font-family: 'Orbitron', sans-serif;
      font-size: clamp(1.1rem, 5.5vw, 1.75rem);
      font-weight: 900;
      letter-spacing: 1px;
      background: linear-gradient(135deg, var(--neon-purple) 0%, var(--neon-pink) 50%, var(--neon-cyan) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-shadow: none;
      filter: drop-shadow(0 0 20px rgba(191,95,255,.5));
      margin-bottom: 8px;
    }
    .tagline { color: #6b7280; font-size: .85rem; margin-bottom: 32px; }

    /* online status bar */
    .online-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: rgba(0,245,100,.06);
      border: 1px solid rgba(0,245,100,.3);
      border-radius: 10px;
      padding: 10px 20px;
      font-size: .82rem;
      color: #4ade80;
      margin-bottom: 28px;
      box-shadow: 0 0 16px rgba(0,245,100,.1);
    }
    .online-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 8px #4ade80;
      animation: blink 1.8s ease-in-out infinite;
    }

    /* stats grid */
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid rgba(191,95,255,.2);
      border-radius: 14px;
      padding: 16px 12px;
      position: relative;
      overflow: hidden;
      transition: border-color .3s, box-shadow .3s;
    }
    .stat-card::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, rgba(191,95,255,.05), transparent);
      pointer-events: none;
    }
    .stat-card:hover {
      border-color: var(--neon-purple);
      box-shadow: 0 0 20px rgba(191,95,255,.2);
    }
    .stat-icon { font-size: 1.2rem; margin-bottom: 6px; }
    .stat-label { font-size: .65rem; color: #6b7280; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 4px; }
    .stat-value {
      font-family: 'Orbitron', sans-serif;
      font-size: .95rem;
      font-weight: 700;
      color: var(--neon-purple);
      text-shadow: 0 0 10px rgba(191,95,255,.5);
    }
    .stat-card.pink  .stat-value { color: var(--neon-pink);  text-shadow: 0 0 10px rgba(255,45,120,.5); }
    .stat-card.cyan  .stat-value { color: var(--neon-cyan);  text-shadow: 0 0 10px rgba(0,245,255,.5); }
    .stat-card.green .stat-value { color: #4ade80;            text-shadow: 0 0 10px rgba(74,222,128,.5); }

    /* footer */
    .footer { color: #374151; font-size: .72rem; }
    .footer span { color: var(--neon-purple); }

    /* scan line overlay */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0,0,0,.03) 2px,
        rgba(0,0,0,.03) 4px
      );
      pointer-events: none;
      z-index: 9999;
    }
  </style>
</head>
<body>
  <div class="particles" id="particles"></div>

  <div class="wrap">
    <div class="avatar-ring">
      <img src="/mascot.jpg" alt="JUNE"/>
    </div>

    <div class="badge"><div class="badge-dot"></div> LIVE</div>

    <h1>JUNE_ULTRA_AI</h1>
    <p class="tagline">Your AI — coded by impeccable &amp; supreme 😎</p>

    <div class="online-bar">
      <div class="online-dot"></div>
      API is online and ready
    </div>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-icon">⏱</div>
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="uptime">--</div>
      </div>
      <div class="stat-card pink">
        <div class="stat-icon">💬</div>
        <div class="stat-label">Requests</div>
        <div class="stat-value" id="requests">--</div>
      </div>
      <div class="stat-card cyan">
        <div class="stat-icon">🤖</div>
        <div class="stat-label">Bots</div>
        <div class="stat-value" id="bots">--</div>
      </div>
      <div class="stat-card green">
        <div class="stat-icon">⚡</div>
        <div class="stat-label">Avg Response</div>
        <div class="stat-value" id="avgrt">--</div>
      </div>
    </div>

    <p class="stat-label" style="margin-bottom:28px">
      Online since: <span id="startTime" style="color:#bf5fff">--</span>
    </p>

    <p class="footer">Coded by <span>impeccable &amp; supreme</span></p>
  </div>

  <script>
    // ── Particles ────────────────────────────────────────────────────────────
    const colors = ['#bf5fff','#ff2d78','#00f5ff'];
    const pc = document.getElementById('particles');
    for (let i = 0; i < 18; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const s = Math.random() * 4 + 2;
      p.style.cssText = [
        'width:' + s + 'px', 'height:' + s + 'px',
        'left:' + Math.random() * 100 + '%',
        'background:' + colors[Math.floor(Math.random() * colors.length)],
        'box-shadow: 0 0 6px ' + colors[Math.floor(Math.random() * colors.length)],
        'animation-duration:' + (Math.random() * 10 + 8) + 's',
        'animation-delay:' + (Math.random() * 10) + 's',
      ].join(';');
      pc.appendChild(p);
    }

    // ── Uptime formatter ─────────────────────────────────────────────────────
    function fmtUptime(ms) {
      const s  = Math.floor(ms / 1000);
      const m  = Math.floor(s  / 60);
      const h  = Math.floor(m  / 60);
      const d  = Math.floor(h  / 24);
      if (d > 0)  return d + 'd ' + (h % 24) + 'h ' + (m % 60) + 'm';
      if (h > 0)  return h + 'h ' + (m % 60) + 'm ' + (s % 60) + 's';
      if (m > 0)  return m + 'm ' + (s % 60) + 's';
      return s + 's';
    }

    // ── Poll /api/stats every 5s ─────────────────────────────────────────────
    let serverStartTime = null;
    let uptimeBaseMs    = 0;
    let localStart      = null;

    async function fetchStats() {
      try {
        const r = await fetch('/api/stats');
        const d = await r.json();
        uptimeBaseMs    = d.uptimeMs;
        localStart      = Date.now();
        serverStartTime = d.startTime;

        document.getElementById('requests').textContent = d.totalRequests.toLocaleString();
        document.getElementById('bots').textContent     = d.botCount;
        document.getElementById('avgrt').textContent    = d.avgResponseTimeMs + 'ms';
        document.getElementById('startTime').textContent =
          new Date(d.startTime).toLocaleString();
      } catch (_) {}
    }

    // Live uptime tick every second
    function tickUptime() {
      if (localStart === null) return;
      const elapsed = Date.now() - localStart;
      document.getElementById('uptime').textContent = fmtUptime(uptimeBaseMs + elapsed);
    }

    fetchStats();
    setInterval(fetchStats,  5000);
    setInterval(tickUptime,  1000);
  </script>
</body>
</html>`);
});

app.use("/api", healthRouter);        // GET /api/healthz
app.use("/api/stats", statsRouter);   // GET /api/stats
app.use("/v1/chat", chatRouter);      // GET/POST/DELETE /v1/chat
app.use("/v1/admin", adminRouter);    // /v1/admin/bots...

export default app;
