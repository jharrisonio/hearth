import { and, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { memberships, teams, users } from "./schema.js";

export async function findUserByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user ?? null;
}

export async function findUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

export function personalListName(name: string) {
  return `${name}'s list`;
}

/** One personal team per user. Created on first sign-in. */
export async function ensurePersonalTeam(user: { id: string; name: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(CAST(${user.id} AS text)))`);
    const existing = await tx
      .select({ team: teams })
      .from(memberships)
      .innerJoin(teams, eq(teams.id, memberships.teamId))
      .where(and(eq(memberships.userId, user.id), eq(teams.kind, "personal")));
    const found = existing[0]?.team;
    if (found) return found;
    const [team] = await tx
      .insert(teams)
      .values({ name: personalListName(user.name), kind: "personal" })
      .returning();
    if (!team) throw new Error("Failed to create personal team");
    await tx.insert(memberships).values({ teamId: team.id, userId: user.id, role: "owner" });
    return team;
  });
}
