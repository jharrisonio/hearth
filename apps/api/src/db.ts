import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import pg from "pg";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

export const pool = new pg.Pool(poolConfig(connectionString));

/** Railway URLs often include sslmode=require. node-postgres does not apply that on its own. */
export function poolConfig(connectionString: string): pg.PoolConfig {
  const sslMode = /[?&]sslmode=([^&]+)/.exec(connectionString)?.[1];
  const requireSsl =
    process.env.DATABASE_SSL === "1" ||
    (sslMode != null && sslMode !== "disable" && sslMode !== "allow" && sslMode !== "prefer");
  const withoutSslMode = connectionString.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  const config: pg.PoolConfig = { connectionString: withoutSslMode };
  if (requireSsl) {
    config.ssl = { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === "1" };
  }
  return config;
}
export const db = drizzle(pool, { schema });

export async function runMigrations() {
  await migrate(db, {
    migrationsFolder: path.join(import.meta.dirname, "../drizzle"),
  });
}
