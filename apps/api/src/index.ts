import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { pool, runMigrations } from "./db.js";
import { assertRuntime, readEnv } from "./env.js";
import { seedIfEnabled } from "./seed.js";

const env = readEnv();
assertRuntime(env);
console.log(`hearth api public url ${env.publicUrl} (dev auth ${env.devAuth ? "on" : "off"})`);
await runMigrations();
if (env.seed) await seedIfEnabled();

const server = serve(
  { fetch: createApp().fetch, hostname: "0.0.0.0", port: env.port },
  (info) => {
    console.log(`hearth api listening on :${info.port}`);
  },
);

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
