import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import adminRouter from "./routes/admin.js";
import { logger } from "./lib/logger.js";

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

app.use("/api", healthRouter); // GET /api/healthz
app.use("/v1/chat", chatRouter); // GET/POST/DELETE /v1/chat
app.use("/v1/admin", adminRouter); // /v1/admin/bots...

export default app;
