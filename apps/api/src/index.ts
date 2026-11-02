import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./app.js";
import { pool, runMigrations } from "./db.js";
import { assertRuntime, readEnv } from "./env.js";
import { closeTaskEvents } from "./events.js";
import { seedIfEnabled } from "./seed.js";

const env = readEnv();
assertRuntime(env);
console.log(
  `hearth api public url ${env.publicUrl} oauth issuer ${env.oauthIssuer} (dev auth ${env.devAuth ? "on" : "off"})`,
);
await runMigrations();
if (env.seed) await seedIfEnabled();

const server = serve(
  { fetch: createApp().fetch, hostname: "0.0.0.0", port: env.port },
  (info) => {
    console.log(`hearth api listening on :${info.port}`);
  },
);

async function shutdown() {
  // SSE clients would otherwise hold the process open until the platform kills it.
  server.close();
  closeConnections(server);
  await closeTaskEvents();
  await pool.end();
  process.exit(0);
}

function closeConnections(server: ServerType) {
  const closer = server as { closeAllConnections?: () => void };
  closer.closeAllConnections?.();
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
