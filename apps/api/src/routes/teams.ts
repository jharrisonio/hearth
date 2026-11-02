import {
  addMemberSchema,
  createTeamSchema,
  createTokenSchema,
  registerBotSchema,
  type BotSummary,
  type BotTokenSummary,
  type Member,
  type TeamSummary,
} from "@hearth/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ensurePersonalTeam, findUserByEmail } from "../accounts.js";
import { requireActor, requireOwner, requireTeam, type AppEnv } from "../actor.js";
import { db } from "../db.js";
import { ensureTaskEvents, openTaskEventStream } from "../events.js";
import { HttpError, parseBody } from "../errors.js";
import { iso, readJson, requireUuid } from "../http.js";
import { botTokens, bots, memberships, teams, users } from "../schema.js";
import { mintToken } from "../tokens.js";

export const teamRoutes = new Hono<AppEnv>();
teamRoutes.use("*", requireActor);

teamRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  if (actor.type === "bot") {
    const access = await requireTeam(actor, actor.teamId);
    return c.json({
      teams: [toSummary(access.team, "member")],
    });
  }
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(eq(memberships.userId, actor.id))
    .orderBy(teams.kind, teams.name);
  return c.json({
    teams: rows.map((row) => toSummary(row.team, row.role)),
  });
});

teamRoutes.post("/", async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") {
    throw new HttpError(403, "forbidden", "Bots cannot create teams.");
  }
  const body = parseBody(createTeamSchema, await readJson(c));
  const user = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
  const me = user[0];
  if (!me) throw new HttpError(401, "unauthorized", "Sign in required.");
  await ensurePersonalTeam(me);
  const created = await db.transaction(async (tx) => {
    const [team] = await tx.insert(teams).values({ name: body.name, kind: "household" }).returning();
    if (!team) throw new Error("Failed to create team");
    await tx.insert(memberships).values({ teamId: team.id, userId: actor.id, role: "owner" });
    return team;
  });
  return c.json(toSummary(created, "owner"), 201);
});

teamRoutes.get("/:teamId/events", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  await requireTeam(c.get("actor"), teamId);
  await ensureTaskEvents();
  return openTaskEventStream(c, teamId);
});

teamRoutes.get("/:teamId", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  const access = await requireTeam(c.get("actor"), teamId);
  const members = await listMembers(teamId);
  return c.json({
    team: toSummary(access.team, access.role ?? "member"),
    members,
  });
});

teamRoutes.post("/:teamId/members", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  const access = await requireOwner(c.get("actor"), teamId);
  if (access.team.kind !== "household") {
    throw new HttpError(400, "personal_team", "Personal lists don't have extra members. Grant a bot token instead.");
  }
  const body = parseBody(addMemberSchema, await readJson(c));
  const email = body.email.toLowerCase();
  const user = await findUserByEmail(email);
  if (!user) {
    throw new HttpError(
      404,
      "user_not_found",
      "No one with that email has signed in yet. They need to sign in once first.",
    );
  }
  const inserted = await db
    .insert(memberships)
    .values({ teamId, userId: user.id, role: "member" })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) {
    throw new HttpError(409, "conflict", "They are already on this team.");
  }
  return c.json(
    { userId: user.id, email: user.email, name: user.name, role: "member" } satisfies Member,
    201,
  );
});

teamRoutes.get("/:teamId/bots", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  await requireTeam(c.get("actor"), teamId);
  const rows = await db.select().from(bots).where(eq(bots.teamId, teamId)).orderBy(bots.name, bots.createdAt);
  return c.json({ bots: rows.map(toBot) });
});

teamRoutes.post("/:teamId/bots", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  await requireTeam(c.get("actor"), teamId);
  const body = parseBody(registerBotSchema, await readJson(c));
  const inserted = await db
    .insert(bots)
    .values({ teamId, agentId: body.agentId, name: body.name })
    .onConflictDoNothing({ target: [bots.teamId, bots.agentId] })
    .returning();
  const created = inserted[0];
  if (created) return c.json(toBot(created), 201);
  const [existing] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.teamId, teamId), eq(bots.agentId, body.agentId)))
    .limit(1);
  if (!existing) throw new Error("Failed to register bot");
  if (existing.name === body.name) return c.json(toBot(existing), 200);
  const [renamed] = await db.update(bots).set({ name: body.name }).where(eq(bots.id, existing.id)).returning();
  if (!renamed) throw new Error("Failed to register bot");
  return c.json(toBot(renamed), 200);
});

teamRoutes.delete("/:teamId/bots/:botId", async (c) => {
  const teamId = c.req.param("teamId");
  const botId = c.req.param("botId");
  requireUuid(teamId, "teamId");
  requireUuid(botId, "botId");
  await requireTeam(c.get("actor"), teamId);
  const [row] = await db
    .delete(bots)
    .where(and(eq(bots.id, botId), eq(bots.teamId, teamId)))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Bot not found.");
  return c.json(toBot(row));
});

teamRoutes.get("/:teamId/tokens", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  await requireTeam(c.get("actor"), teamId);
  const rows = await db.select().from(botTokens).where(eq(botTokens.teamId, teamId)).orderBy(botTokens.createdAt);
  return c.json({ tokens: rows.map(toToken) });
});

teamRoutes.post("/:teamId/tokens", async (c) => {
  const teamId = c.req.param("teamId");
  requireUuid(teamId, "teamId");
  const actor = c.get("actor");
  await requireOwner(actor, teamId);
  const body = parseBody(createTokenSchema, await readJson(c));
  const minted = mintToken();
  const [row] = await db
    .insert(botTokens)
    .values({
      teamId,
      label: body.label,
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      createdByUserId: actor.id,
    })
    .returning();
  if (!row) throw new Error("Failed to create token");
  return c.json({ token: toToken(row), secret: minted.secret }, 201);
});

teamRoutes.delete("/:teamId/tokens/:tokenId", async (c) => {
  const teamId = c.req.param("teamId");
  const tokenId = c.req.param("tokenId");
  requireUuid(teamId, "teamId");
  requireUuid(tokenId, "tokenId");
  await requireOwner(c.get("actor"), teamId);
  const [row] = await db
    .update(botTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(botTokens.id, tokenId), eq(botTokens.teamId, teamId)))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Token not found.");
  return c.json({ token: toToken(row) });
});

function toSummary(
  team: { id: string; name: string; kind: "personal" | "household"; createdAt: Date | string },
  role: "owner" | "member",
): TeamSummary {
  return {
    id: team.id,
    name: team.name,
    kind: team.kind,
    role,
    createdAt: iso(team.createdAt) ?? new Date(0).toISOString(),
  };
}

function toBot(row: typeof bots.$inferSelect): BotSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    agentId: row.agentId,
    name: row.name,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

function toToken(row: typeof botTokens.$inferSelect): BotTokenSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    label: row.label,
    prefix: row.tokenPrefix,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    revokedAt: iso(row.revokedAt),
    createdByUserId: row.createdByUserId,
  };
}

async function listMembers(teamId: string): Promise<Member[]> {
  const rows = await db
    .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.teamId, teamId))
    .orderBy(users.name);
  return rows;
}
