import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { readEnv } from "./env.js";
import { HttpError } from "./errors.js";
import { sessionCookieName, signSession } from "./actor.js";

const MAX_AGE = 60 * 60 * 24 * 30;

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be JSON.");
  }
}

export function setSession(c: Context, userId: string) {
  const env = readEnv();
  setCookie(c, sessionCookieName(), signSession(userId, env.sessionSecret, MAX_AGE), {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.publicUrl.startsWith("https://"),
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearSession(c: Context) {
  const env = readEnv();
  deleteCookie(c, sessionCookieName(), {
    path: "/",
    secure: env.publicUrl.startsWith("https://"),
  });
}

export function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function requireUuid(value: string, name: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "invalid_query", `${name} must be a UUID.`);
  }
}
