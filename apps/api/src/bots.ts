import { and, eq } from "drizzle-orm";
import { db } from "./db.js";
import { bots } from "./schema.js";

/** Insert a bot, or return the existing row. A new name renames it and keeps the id. */
export async function upsertBot(teamId: string, agentId: string, name: string) {
  const inserted = await db
    .insert(bots)
    .values({ teamId, agentId, name })
    .onConflictDoNothing({ target: [bots.teamId, bots.agentId] })
    .returning();
  const created = inserted[0];
  if (created) return { bot: created, created: true as const };
  const [existing] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.teamId, teamId), eq(bots.agentId, agentId)))
    .limit(1);
  if (!existing) throw new Error("Failed to register bot");
  if (existing.name === name) return { bot: existing, created: false as const };
  const [renamed] = await db.update(bots).set({ name }).where(eq(bots.id, existing.id)).returning();
  if (!renamed) throw new Error("Failed to register bot");
  return { bot: renamed, created: false as const };
}
