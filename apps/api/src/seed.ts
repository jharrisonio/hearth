import type { Action } from "@hearth/shared";
import { and, count, eq } from "drizzle-orm";
import { ensurePersonalTeam, findUserByEmail } from "./accounts.js";
import { createNamed } from "./catalog.js";
import { db } from "./db.js";
import { memberships, tasks, teams, users } from "./schema.js";

const JAMES = { email: "james@example.com", name: "James" };
const NAOMI = { email: "naomi@example.com", name: "Naomi" };
const HOUSEHOLD = "Harrison household";

export async function seedIfEnabled() {
  const james = await upsertUser(JAMES.email, JAMES.name);
  const naomi = await upsertUser(NAOMI.email, NAOMI.name);
  const jamesPersonal = await ensurePersonalTeam(james);
  const naomiPersonal = await ensurePersonalTeam(naomi);
  const household = await ensureHousehold(james.id, naomi.id);
  await seedTasks(james.id, naomi.id, jamesPersonal.id, naomiPersonal.id, household.id);
  console.log("seed ready: james@example.com, naomi@example.com, Harrison household");
}

async function upsertUser(email: string, name: string) {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  const [created] = await db.insert(users).values({ email, name }).returning();
  if (!created) throw new Error(`Failed to seed ${email}`);
  return created;
}

async function ensureHousehold(jamesId: string, naomiId: string) {
  const existing = await db
    .select({ team: teams })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(
      and(
        eq(teams.kind, "household"),
        eq(teams.name, HOUSEHOLD),
        eq(memberships.userId, jamesId),
        eq(memberships.role, "owner"),
      ),
    )
    .limit(1);
  const team = existing[0]?.team;
  const household =
    team ??
    (
      await db.insert(teams).values({ name: HOUSEHOLD, kind: "household" }).returning()
    )[0];
  if (!household) throw new Error("Failed to seed household");
  await db
    .insert(memberships)
    .values([
      { teamId: household.id, userId: jamesId, role: "owner" },
      { teamId: household.id, userId: naomiId, role: "member" },
    ])
    .onConflictDoNothing();
  return household;
}

async function seedTasks(
  jamesId: string,
  naomiId: string,
  jamesTeamId: string,
  naomiTeamId: string,
  householdId: string,
) {
  const kitchen = await namedId("area", householdId, "Kitchen");
  const house = await namedId("area", householdId, "House");
  const shed = await namedId("area", householdId, "Shed");
  const boiler = await namedId("project", householdId, "Boiler service");
  const admin = await namedId("area", jamesTeamId, "Admin");
  const errands = await namedId("area", naomiTeamId, "Errands");
  await insertIfEmpty(householdId, [
    task(householdId, jamesId, {
      title: "Buy oat milk",
      areaId: kitchen,
      important: true,
      urgent: true,
      action: "do_now",
      dueAt: daysFromNow(1),
    }),
    task(householdId, naomiId, {
      title: "Book the boiler service",
      areaId: house,
      projectId: boiler,
      important: true,
      urgent: false,
      action: "delegate",
      waitingOn: "a plumber to ring back",
    }),
    task(householdId, jamesId, {
      title: "Sort the camping gear",
      areaId: shed,
      important: false,
      urgent: false,
      action: "later",
    }),
  ]);
  await insertIfEmpty(jamesTeamId, [
    task(jamesTeamId, jamesId, {
      title: "Send the rates notice",
      areaId: admin,
      important: true,
      urgent: false,
      action: "do_now",
      dueAt: daysFromNow(3),
    }),
  ]);
  await insertIfEmpty(naomiTeamId, [
    task(naomiTeamId, naomiId, {
      title: "Return the library book",
      areaId: errands,
      important: false,
      urgent: true,
      action: "do_now",
      dueAt: daysFromNow(2),
    }),
  ]);
}

async function namedId(kind: "project" | "area", teamId: string, name: string) {
  const { row } = await createNamed(kind, teamId, name);
  return row.id;
}

function task(
  teamId: string,
  userId: string,
  fields: {
    title: string;
    projectId?: string;
    areaId?: string;
    important: boolean;
    urgent: boolean;
    action: Action;
    waitingOn?: string;
    dueAt?: Date;
    calendarEventId?: string | null;
  },
) {
  const calendarEventId = fields.calendarEventId ?? null;
  return {
    teamId,
    title: fields.title,
    projectId: fields.projectId ?? null,
    areaId: fields.areaId ?? null,
    important: fields.important,
    urgent: fields.urgent,
    action: fields.action,
    waitingOn: fields.waitingOn ?? null,
    calendarEventId,
    needsCalendar: fields.action === "schedule" && !calendarEventId,
    dueAt: fields.dueAt !== undefined ? fields.dueAt : fields.action === "delegate" ? daysFromNow(3) : null,
    ownerType: "user" as const,
    ownerId: userId,
    createdByType: "user" as const,
    createdById: userId,
  };
}

async function insertIfEmpty(
  teamId: string,
  rows: (ReturnType<typeof task>)[],
) {
  const [row] = await db.select({ n: count() }).from(tasks).where(eq(tasks.teamId, teamId));
  if (Number(row?.n ?? 0) > 0) return;
  await db.insert(tasks).values(rows);
}

function daysFromNow(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(17, 0, 0, 0);
  return date;
}
