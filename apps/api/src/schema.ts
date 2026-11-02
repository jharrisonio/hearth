import { boolean, index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const teamKind = pgEnum("team_kind", ["personal", "household"]);
export const membershipRole = pgEnum("membership_role", ["owner", "member"]);
export const taskStatus = pgEnum("task_status", ["open", "done"]);
export const taskAction = pgEnum("task_action", ["do_now", "delegate", "schedule", "later"]);
export const actorType = pgEnum("actor_type", ["user", "bot"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  googleSub: text("google_sub").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: teamKind("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("memberships_team_user").on(table.teamId, table.userId),
    index("memberships_user_idx").on(table.userId),
  ],
);

export const botTokens = pgTable(
  "bot_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("bot_tokens_team_idx").on(table.teamId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    detail: text("detail"),
    status: taskStatus("status").notNull().default("open"),
    ownerType: actorType("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    important: boolean("important").notNull().default(false),
    urgent: boolean("urgent").notNull().default(false),
    action: taskAction("action").notNull().default("later"),
    waitingOn: text("waiting_on"),
    calendarEventId: text("calendar_event_id"),
    needsCalendar: boolean("needs_calendar").notNull().default(false),
    project: text("project"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByType: actorType("created_by_type").notNull(),
    createdById: uuid("created_by_id").notNull(),
  },
  (table) => [index("tasks_team_status_action_idx").on(table.teamId, table.status, table.action)],
);
