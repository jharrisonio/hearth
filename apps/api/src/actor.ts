import type { ActorRef } from "@hearth/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db.js";
import { readEnv } from "./env.js";
import { HttpError } from "./errors.js";
import { botTokens, bots, memberships, oauthGrantTeams, oauthGrants, oauthTokens, teams } from "./schema.js";
import { hashToken } from "./tokens.js";

export type Actor =
  | { type: "user"; id: string }
  | {
      type: "bot";
      /** Bot token id, or the OAuth grant id. Both can own a task. */
      id: string;
      teamIds: string[];
      credential: { kind: "token"; id: string } | { kind: "oauth"; id: string };
    };

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

/** Bot Bearer token, the same check REST uses when Authorization is set. */
export async function actorFromBearer(header: string | undefined): Promise<Actor> {
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  const secret = match?.[1];
  if (!secret) throw new HttpError(401, "unauthorized", "Bearer token required.");
  if (secret.startsWith("hoa_")) {
    const oauth = await oauthFromSecret(secret);
    if (!oauth) throw new HttpError(401, "unauthorized", "Invalid or revoked token.");
    return oauth;
  }
  const bot = await botFromSecret(secret);
  if (!bot) throw new HttpError(401, "unauthorized", "Invalid or revoked token.");
  return { type: "bot", id: bot.id, teamIds: [bot.teamId], credential: { kind: "token", id: bot.id } };
}

export async function requireActor(c: Context<AppEnv>, next: () => Promise<void>) {
  const header = c.req.header("authorization");
  if (header) {
    c.set("actor", await actorFromBearer(header));
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
    if (!actor.teamIds.includes(teamId)) {
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
    if (requested && !actor.teamIds.includes(requested)) {
      throw new HttpError(403, "forbidden", "This token is not valid for that team.");
    }
    return requested ? [requested] : [...actor.teamIds];
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
  const [registered] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, owner.id), eq(bots.teamId, teamId)))
    .limit(1);
  if (registered) return;
  // A minted hth_ token can still own a task. Registration is not required for that escape hatch.
  const [token] = await db
    .select({ id: botTokens.id })
    .from(botTokens)
    .where(and(eq(botTokens.id, owner.id), eq(botTokens.teamId, teamId)))
    .limit(1);
  if (token) return;
  const [grant] = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .innerJoin(oauthGrantTeams, eq(oauthGrantTeams.grantId, oauthGrants.id))
    .where(and(eq(oauthGrants.id, owner.id), eq(oauthGrantTeams.teamId, teamId), isNull(oauthGrants.revokedAt)))
    .limit(1);
  if (grant) return;
  throw new HttpError(400, "invalid_owner", "That bot is not registered on this team.");
}

export function actorRef(actor: Actor): ActorRef {
  return { type: actor.type, id: actor.id };
}

/** A long-lived stream re-checks this. requireTeam does not see a revocation that happens later. */
export async function assertActorCurrent(actor: Actor, teamId: string) {
  if (actor.type === "user") {
    await requireTeam(actor, teamId);
    return;
  }
  if (actor.credential.kind === "token") {
    const [row] = await db
      .select({ revokedAt: botTokens.revokedAt, teamId: botTokens.teamId })
      .from(botTokens)
      .where(eq(botTokens.id, actor.credential.id))
      .limit(1);
    if (!row || row.revokedAt || row.teamId !== teamId) {
      throw new HttpError(401, "unauthorized", "Invalid or revoked token.");
    }
    return;
  }
  const [token] = await db
    .select({
      revokedAt: oauthTokens.revokedAt,
      accessExpiresAt: oauthTokens.accessExpiresAt,
      grantId: oauthTokens.grantId,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.id, actor.credential.id))
    .limit(1);
  if (!token || token.revokedAt || token.accessExpiresAt.getTime() <= Date.now()) {
    throw new HttpError(401, "unauthorized", "Invalid or revoked token.");
  }
  const [grant] = await db
    .select({ revokedAt: oauthGrants.revokedAt })
    .from(oauthGrants)
    .where(eq(oauthGrants.id, token.grantId))
    .limit(1);
  if (!grant || grant.revokedAt) throw new HttpError(401, "unauthorized", "Invalid or revoked token.");
  const [link] = await db
    .select({ teamId: oauthGrantTeams.teamId })
    .from(oauthGrantTeams)
    .where(and(eq(oauthGrantTeams.grantId, token.grantId), eq(oauthGrantTeams.teamId, teamId)))
    .limit(1);
  if (!link) throw new HttpError(403, "forbidden", "This token is not valid for that team.");
}

async function oauthFromSecret(secret: string): Promise<Actor | null> {
  const [token] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.accessHash, hashToken(secret)), isNull(oauthTokens.revokedAt)))
    .limit(1);
  if (!token) return null;
  if (token.accessExpiresAt.getTime() <= Date.now()) {
    throw new HttpError(401, "unauthorized", "Access token expired.");
  }
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, token.grantId)).limit(1);
  if (!grant || grant.revokedAt) return null;
  const links = await db
    .select({ teamId: oauthGrantTeams.teamId })
    .from(oauthGrantTeams)
    .where(eq(oauthGrantTeams.grantId, grant.id));
  return {
    type: "bot",
    id: grant.id,
    teamIds: links.map((link) => link.teamId),
    credential: { kind: "oauth", id: token.id },
  };
}
