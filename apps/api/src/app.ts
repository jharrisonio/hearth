import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { pool } from "./db.js";
import { HttpError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { taskRoutes } from "./routes/tasks.js";
import { teamRoutes } from "./routes/teams.js";

export function createApp() {
  const app = new Hono();
  const origins = corsOrigins();
  if (origins.length > 0) {
    const allowed = new Set(origins);
    app.use(
      "*",
      cors({
        origin: (origin) => (allowed.has(origin) ? origin : null),
        credentials: true,
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      }),
    );
  }
  app.use("*", logger());
  app.get("/health", async (c) => {
    await pool.query("select 1");
    return c.json({ ok: true });
  });
  app.route("/", authRoutes);
  app.route("/teams", teamRoutes);
  app.route("/tasks", taskRoutes);
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });
  return app;
}

function corsOrigins() {
  return (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter((origin) => origin.length > 0 && origin !== "*");
}
