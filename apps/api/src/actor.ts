import type { ActorRef } from "@hearth/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db.js";
import { readEnv } from "./env.js";
import { HttpError } from "./errors.js";
import { botTokens, memberships, teams } from "./schema.js";
import { hashToken } from "./tokens.js";

export type Actor =
  | { type: "user"; id: string }
  | { type: "bot"; id: string; teamId: string };

export type AppEnv = { Variables: { actor: Actor } };

const COOKIE = "hearth_session";

type Session = { sub: string; exp: number };

export function sessionCookieName() {
  return COOKIE;
}

export function signSession(userId: string, secret: string, maxAgeSec: number) {
  const payload: Session = { sub: userId, exp: Math.floor(Date.now() / 1000) + maxAgeSec };
  return signValue(JSON.stringify(payload), secret);
}

export function readSessionUserId(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const raw = unsignValue(token, secret);
  if (!raw) return null;
  let parsed: Session;
  try {
    parsed = JSON.parse(raw) as Session;
  } catch {
    return null;
  }
  if (!parsed.sub || typeof parsed.exp !== "number") return null;
  if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed.sub;
}

export function signValue(payload: string, secret: string) {
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function unsignValue(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}

export async function requireActor(c: Context<AppEnv>, next: () => Promise<void>) {
  const header = c.req.header("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const secret = match?.[1];
    if (!secret) throw new HttpError(401, "unauthorized", "Bearer token required.");
    const bot = await botFromSecret(secret);
    if (!bot) throw new HttpError(401, "unauthorized", "Invalid or revoked token.");
    c.set("actor", { type: "bot", id: bot.id, teamId: bot.teamId });
    await next();
    return;
  }
  const env = readEnv();
  const userId = readSessionUserId(getCookie(c, COOKIE), env.sessionSecret);
  if (!userId) throw new HttpError(401, "unauthorized", "Sign in required.");
  c.set("actor", { type: "user", id: userId });
  await next();
}

async function botFromSecret(secret: string) {
  const [row] = await db
    .select({ id: botTokens.id, teamId: botTokens.teamId })
    .from(botTokens)
    .where(and(eq(botTokens.tokenHash, hashToken(secret)), isNull(botTokens.revokedAt)))
    .limit(1);
  return row ?? null;
}

export async function requireTeam(actor: Actor, teamId: string) {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) throw new HttpError(404, "not_found", "Team not found.");
  if (actor.type === "bot") {
    if (actor.teamId !== teamId) {
      throw new HttpError(403, "forbidden", "This token is not valid for that team.");
    }
    return { team, role: null as null };
  }
  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, actor.id)))
    .limit(1);
  if (!membership) throw new HttpError(403, "forbidden", "You are not a member of this team.");
  return { team, role: membership.role };
}

export async function requireOwner(actor: Actor, teamId: string) {
  if (actor.type !== "user") {
    throw new HttpError(403, "forbidden", "Only a team owner can do that.");
  }
  const access = await requireTeam(actor, teamId);
  if (access.role !== "owner") {
    throw new HttpError(403, "forbidden", "Only a team owner can do that.");
  }
  return access;
}

export async function teamIdsFor(actor: Actor, requested: string | undefined): Promise<string[]> {
  if (actor.type === "bot") {
    if (requested && requested !== actor.teamId) {
      throw new HttpError(403, "forbidden", "This token is not valid for that team.");
    }
    return [actor.teamId];
  }
  if (requested) {
    await requireTeam(actor, requested);
    return [requested];
  }
  const rows = await db
    .select({ teamId: memberships.teamId })
    .from(memberships)
    .where(eq(memberships.userId, actor.id));
  return rows.map((row) => row.teamId);
}

export async function assertOwnerOnTeam(teamId: string, owner: ActorRef) {
  if (owner.type === "user") {
    const [membership] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.teamId, teamId), eq(memberships.userId, owner.id)))
      .limit(1);
    if (!membership) {
      throw new HttpError(400, "invalid_owner", "The owner must be a member of this team.");
    }
    return;
  }
  const [bot] = await db
    .select({ id: botTokens.id })
    .from(botTokens)
    .where(and(eq(botTokens.id, owner.id), eq(botTokens.teamId, teamId)))
    .limit(1);
  if (!bot) throw new HttpError(400, "invalid_owner", "That bot is not on this team.");
}

export function actorRef(actor: Actor): ActorRef {
  return { type: actor.type, id: actor.id };
}
