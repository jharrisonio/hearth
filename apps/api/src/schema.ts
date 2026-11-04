import type { OAuthAgent, TaskSource } from "@hearth/shared";
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const teamKind = pgEnum("team_kind", ["personal", "household"]);
export const membershipRole = pgEnum("membership_role", ["owner", "member"]);
export const taskStatus = pgEnum("task_status", ["open", "done", "cancelled"]);
export const taskAction = pgEnum("task_action", ["do_now", "delegate", "schedule", "later"]);
export const actorType = pgEnum("actor_type", ["user", "bot"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  googleSub: text("google_sub").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: teamKind("kind").notNull(),
    /** Uppercase letters. James's personal list is J, the Harrison household is H. */
    key: text("key").notNull().default(""),
    /** Last task number handed out. The next create stores this plus one. */
    nextTaskNumber: integer("next_task_number").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("teams_key_unique").on(table.key)],
);

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
    /** Natural-planning notes. The steps are tasks linked to this project. */
    notes: text("notes"),
    /** Life or work domain this outcome sits in. Not a step. */
    areaId: uuid("area_id").references(() => areas.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("projects_team_idx").on(table.teamId), index("projects_area_id_idx").on(table.areaId)],
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

/** Dynamic or metadata MCP client. `client_id` is the public id, not a secret. */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  source: text("source").notNull().default("dcr"),
  metadataFetchedAt: timestamp("metadata_fetched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Browser handoff for one install. Consumed when the person authorises or denies. */
export const oauthRequests = pgTable("oauth_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  state: text("state"),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  agents: jsonb("agents").$type<OAuthAgent[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One consent. The row id is the bot owner id for tasks this connector creates. */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    oauthClientId: uuid("oauth_client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("oauth_grants_user_idx").on(table.userId)],
);

export const oauthGrantTeams = pgTable(
  "oauth_grant_teams",
  {
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.grantId, table.teamId] }), index("oauth_grant_teams_team_idx").on(table.teamId)],
);

export const oauthCodes = pgTable("oauth_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  grantId: uuid("grant_id")
    .notNull()
    .references(() => oauthGrants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    accessHash: text("access_hash").notNull().unique(),
    accessPrefix: text("access_prefix").notNull(),
    refreshHash: text("refresh_hash").unique(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("oauth_tokens_grant_idx").on(table.grantId)],
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
    /** Order of a step inside its project list. Null sorts after numbered steps. */
    sortOrder: integer("sort_order"),
    /** Email or page this task came from. Null when the task has no link. */
    source: jsonb("source").$type<TaskSource | null>(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** While this is in the future the task is snoozed and stays on its action. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdByType: actorType("created_by_type").notNull(),
    createdById: uuid("created_by_id").notNull(),
    /** Per-team sequence. With teams.key this is the public id, such as J-142. */
    number: integer("number").notNull(),
  },
  (table) => [
    index("tasks_team_status_action_idx").on(table.teamId, table.status, table.action),
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_area_id_idx").on(table.areaId),
    unique("tasks_team_number_unique").on(table.teamId, table.number),
  ],
);

/**
 * An http(s) page attached to a task.
 * `created_by_*` is a user or a bot, the same shape as `tasks`, so it has no foreign key.
 */
export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    createdByType: actorType("created_by_type").notNull(),
    createdById: uuid("created_by_id").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("task_links_task_id_idx").on(table.taskId),
    unique("task_links_task_url_key").on(table.taskId, table.url),
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
