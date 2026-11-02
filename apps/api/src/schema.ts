import type { TaskSource } from "@hearth/shared";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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

/** A multi-step outcome, scoped to one team. Not a life area. */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("projects_team_idx").on(table.teamId)],
);

/** A life or work domain, scoped to one team. Not a project. */
export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("areas_team_idx").on(table.teamId)],
);

/** A bot you can assign a task to. Not a credential — tokens stay in bot_tokens. */
export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("bots_team_agent").on(table.teamId, table.agentId)],
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
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    areaId: uuid("area_id").references(() => areas.id, { onDelete: "set null" }),
    /** Email or page this task came from. Null when the task has no link. */
    source: jsonb("source").$type<TaskSource | null>(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByType: actorType("created_by_type").notNull(),
    createdById: uuid("created_by_id").notNull(),
  },
  (table) => [
    index("tasks_team_status_action_idx").on(table.teamId, table.status, table.action),
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_area_id_idx").on(table.areaId),
  ],
);

/** One successful POST /tasks per actor and Idempotency-Key. `actor_id` is a user or a bot, so it has no foreign key. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("idempotency_keys_actor_key").on(table.actorType, table.actorId, table.idempotencyKey)],
);
