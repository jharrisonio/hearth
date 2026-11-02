import {
  devLoginSchema,
  type AuthConfig,
  type CurrentUser,
} from "@hearth/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { ensurePersonalTeam, findUserByEmail, findUserById } from "../accounts.js";
import { readEnv } from "../env.js";
import { parseBody, HttpError } from "../errors.js";
import { clearSession, readJson, setSession } from "../http.js";
import { db } from "../db.js";
import { users } from "../schema.js";
import { readSessionUserId, sessionCookieName, signValue, unsignValue } from "../actor.js";

const STATE_COOKIE = "hearth_oauth_state";

export const authRoutes = new Hono();

authRoutes.get("/auth/config", async (c) => {
  const env = readEnv();
  const body: AuthConfig = {
    devAuth: env.devAuth,
    google: Boolean(env.googleClientId && env.googleClientSecret),
  };
  if (env.devAuth) {
    const rows = await db.select({ email: users.email, name: users.name }).from(users).orderBy(users.email);
    body.devUsers = rows;
  }
  return c.json(body);
});

authRoutes.post("/auth/dev", async (c) => {
  const env = readEnv();
  if (!env.devAuth) throw new HttpError(404, "not_found", "Not found.");
  const body = parseBody(devLoginSchema, await readJson(c));
  const email = body.email.toLowerCase();
  const user = await findUserByEmail(email);
  if (!user) {
    throw new HttpError(404, "not_found", "No seeded user with that email. Sign-in does not create accounts when DEV_AUTH is on.");
  }
  await ensurePersonalTeam(user);
  setSession(c, user.id);
  return c.json({ user: toUser(user) });
});

authRoutes.get("/auth/google", (c) => {
  const env = readEnv();
  if (!env.googleClientId || !env.googleClientSecret) {
    return c.redirect("/signin?error=google_not_configured");
  }
  const state = randomBytes(24).toString("base64url");
  setCookie(c, STATE_COOKIE, signValue(state, env.sessionSecret), {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.publicUrl.startsWith("https://"),
    path: "/",
    maxAge: 600,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", redirectUri(env.publicUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

authRoutes.get("/auth/google/callback", async (c) => {
  const env = readEnv();
  const error = c.req.query("error");
  if (error) return c.redirect("/signin?error=google");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const signed = getCookie(c, STATE_COOKIE);
  const expected = signed ? unsignValue(signed, env.sessionSecret) : null;
  if (!code || !state || !expected || state !== expected) {
    return c.redirect("/signin?error=state");
  }
  if (!env.googleClientId || !env.googleClientSecret) {
    return c.redirect("/signin?error=google_not_configured");
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: redirectUri(env.publicUrl),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("google token exchange failed", tokenRes.status);
    return c.redirect("/signin?error=google");
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return c.redirect("/signin?error=google");
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) return c.redirect("/signin?error=google");
  const profile = (await profileRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (!profile.sub || !profile.email || profile.email_verified === false) {
    return c.redirect("/signin?error=google");
  }
  const user = await upsertGoogleUser({
    sub: profile.sub,
    email: profile.email.toLowerCase(),
    name: profile.name?.trim() || profile.email.split("@")[0] || "Member",
  });
  await ensurePersonalTeam(user);
  setSession(c, user.id);
  return c.redirect("/");
});

authRoutes.get("/auth/me", async (c) => {
  const env = readEnv();
  const userId = readSessionUserId(getCookie(c, sessionCookieName()), env.sessionSecret);
  if (!userId) throw new HttpError(401, "unauthorized", "Sign in required.");
  const user = await findUserById(userId);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required.");
  return c.json({ user: toUser(user) });
});

authRoutes.post("/auth/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

function redirectUri(publicUrl: string) {
  return `${publicUrl}/api/auth/google/callback`;
}

function toUser(user: { id: string; email: string; name: string }): CurrentUser {
  return { id: user.id, email: user.email, name: user.name };
}

async function upsertGoogleUser(profile: { sub: string; email: string; name: string }) {
  const [bySub] = await db.select().from(users).where(eq(users.googleSub, profile.sub)).limit(1);
  if (bySub) return bySub;
  const existing = await findUserByEmail(profile.email);
  if (existing) {
    if (existing.googleSub && existing.googleSub !== profile.sub) {
      throw new HttpError(409, "conflict", "That email is already linked to a different Google account.");
    }
    const [updated] = await db
      .update(users)
      .set({ googleSub: profile.sub, name: existing.name || profile.name })
      .where(eq(users.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [created] = await db
    .insert(users)
    .values({ email: profile.email, name: profile.name, googleSub: profile.sub })
    .returning();
  if (!created) throw new Error("Could not create user.");
  return created;
}
