import { and, eq } from "drizzle-orm";
import { requireTeam, type Actor } from "./actor.js";
import { db } from "./db.js";
import { HttpError } from "./errors.js";
import { tasks, teams } from "./schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^([A-Za-z]+)-(\d+)$/;

/**
 * A task route accepts the row UUID or a key such as J-142.
 * The letter part is case-insensitive. A key on a team this actor cannot
 * access is forbidden, the same as a UUID on that team.
 */
export async function resolveTaskId(actor: Actor, raw: string): Promise<string> {
  const value = raw.trim();
  if (UUID.test(value)) return value;
  const match = KEY.exec(value);
  const letters = match?.[1];
  const digits = match?.[2];
  if (!letters || digits === undefined) {
    throw new HttpError(400, "invalid_query", "Task id must be a UUID or a key like J-142.");
  }
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new HttpError(400, "invalid_query", "Task id must be a UUID or a key like J-142.");
  }
  const [row] = await db
    .select({ id: tasks.id, teamId: tasks.teamId })
    .from(tasks)
    .innerJoin(teams, eq(teams.id, tasks.teamId))
    .where(and(eq(teams.key, letters.toUpperCase()), eq(tasks.number, number)))
    .limit(1);
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  await requireTeam(actor, row.teamId);
  return row.id;
}
