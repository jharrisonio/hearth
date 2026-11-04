import {
  actions,
  cancelTaskSchema,
  completeTaskSchema,
  createTaskSchema,
  delegateRequiresWaitingOn,
  followUpFrom,
  resolveNeedsCalendar,
  scheduleRequiresDueAt,
  snoozeTaskSchema,
  suggestAction,
  taskStatuses,
  updateTaskSchema,
  type Action,
  type ActorRef,
  type CreateTaskInput,
  type DeletedTask,
  type TaskStatus,
} from "@hearth/shared";
import { and, desc, eq, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import {
  actorRef,
  assertOwnerOnTeam,
  requireActor,
  requireTeam,
  teamIdsFor,
  type Actor,
  type AppEnv,
} from "../actor.js";
import { db } from "../db.js";
import { blankToNull, HttpError, parseBody } from "../errors.js";
import { publishTaskEvent } from "../events.js";
import { readJson, requireUuid } from "../http.js";
import { parseIdempotencyKey, withCreateIdempotency } from "../idempotency.js";
import { assertNamedOnTeam } from "../catalog.js";
import { tasks, teams } from "../schema.js";
import { attachLinks, loadTaskView, taskViews, viewTask } from "../task-json.js";
import { resolveTaskId } from "../task-ref.js";
import { registerTaskLinkRoutes } from "./task-links.js";

const BLOCKED_UPDATE = new Set([
  "status",
  "outcome",
  "completedAt",
  "cancelledAt",
  "id",
  "teamId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "snoozedUntil",
  "key",
  "number",
]);

export const taskRoutes = new Hono<AppEnv>();
taskRoutes.use("*", requireActor);
registerTaskLinkRoutes(taskRoutes);

taskRoutes.get("/do-immediately", async (c) => {
  const actor = c.get("actor");
  const teamId = optionalUuid(c.req.query("teamId"), "teamId");
  const ids = await teamIdsFor(actor, teamId);
  if (ids.length === 0) return c.json({ tasks: [] });
  const rows = await taskViews()
    .where(
      and(
        inArray(tasks.teamId, ids),
        eq(tasks.status, "open"),
        notCurrentlySnoozed(),
        actor.type === "bot" ? botQueueFilter(actor.id) : morningQueueFilter(),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${tasks.important} AND ${tasks.urgent} THEN 0 WHEN ${tasks.important} THEN 1 WHEN ${tasks.urgent} THEN 2 ELSE 3 END`,
      sql`${tasks.dueAt} ASC NULLS LAST`,
      desc(tasks.updatedAt),
    )
    .limit(100);
  return c.json({ tasks: await attachLinks(rows.map(viewTask)) });
});

taskRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  const query = c.req.query();
  if (query.lane !== undefined) {
    throw new HttpError(400, "invalid_query", "lane has been removed. Filter with action.");
  }
  const teamId = optionalUuid(query.teamId, "teamId");
  const ids = await teamIdsFor(actor, teamId);
  if (ids.length === 0) return c.json({ tasks: [] });

  const filters: SQL[] = [inArray(tasks.teamId, ids)];
  const action = parseAction(query.action);
  const status = parseStatus(query.status);
  const important = parseBool(query.important, "important");
  const urgent = parseBool(query.urgent, "urgent");
  const needsCalendar = parseBool(query.needsCalendar, "needsCalendar");
  const mine = parseBool(query.mine, "mine");
  if (action) filters.push(eq(tasks.action, action));
  if (status) filters.push(eq(tasks.status, status));
  if (important !== undefined) filters.push(eq(tasks.important, important));
  if (urgent !== undefined) filters.push(eq(tasks.urgent, urgent));
  if (needsCalendar !== undefined) filters.push(eq(tasks.needsCalendar, needsCalendar));
  if (query.project !== undefined) {
    throw new HttpError(400, "invalid_query", "project has been removed. Filter with projectId.");
  }
  if (query.projectId !== undefined) {
    requireUuid(query.projectId, "projectId");
    filters.push(eq(tasks.projectId, query.projectId));
  }
  if (query.areaId !== undefined) {
    requireUuid(query.areaId, "areaId");
    filters.push(eq(tasks.areaId, query.areaId));
  }
  if (query.dueBefore !== undefined) {
    const due = new Date(query.dueBefore);
    if (Number.isNaN(due.getTime())) {
      throw new HttpError(400, "invalid_query", "dueBefore must be an ISO datetime.");
    }
    const dueFilter = and(isNotNull(tasks.dueAt), lt(tasks.dueAt, due));
    if (dueFilter) filters.push(dueFilter);
  }
  if (query.owner !== undefined) {
    const owner = parseOwner(query.owner);
    filters.push(eq(tasks.ownerType, owner.type));
    filters.push(eq(tasks.ownerId, owner.id));
  }
  if (mine) {
    filters.push(eq(tasks.ownerType, actor.type));
    filters.push(eq(tasks.ownerId, actor.id));
  }
  const includeSnoozed = parseBool(query.includeSnoozed, "includeSnoozed");
  if (!includeSnoozed) filters.push(notCurrentlySnoozed());

  const rows = await taskViews()
    .where(and(...filters))
    .orderBy(desc(tasks.updatedAt), desc(tasks.createdAt))
    .limit(200);
  return c.json({ tasks: await attachLinks(rows.map(viewTask)) });
});

taskRoutes.post("/", async (c) => {
  const actor = c.get("actor");
  const body = parseBody(createTaskSchema, await readJson(c));
  const key = parseIdempotencyKey(c.req.header("idempotency-key"));
  await requireTeam(actor, body.teamId);
  const values = taskInsertValues(actor, body, new Date());
  await assertOwnerOnTeam(body.teamId, values.owner);
  await assertLinks(body.teamId, values.row.projectId, values.row.areaId);
  const { row, replayed } = await withCreateIdempotency(actor, key, body, async (tx) => {
    const [counter] = await tx
      .update(teams)
      .set({ nextTaskNumber: sql`${teams.nextTaskNumber} + 1` })
      .where(eq(teams.id, body.teamId))
      .returning({ nextTaskNumber: teams.nextTaskNumber });
    if (!counter) throw new Error("Failed to number task");
    const [inserted] = await tx
      .insert(tasks)
      .values({ ...values.row, number: counter.nextTaskNumber })
      .returning();
    if (!inserted) throw new Error("Failed to create task");
    return inserted;
  });
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  if (replayed) {
    c.header("Idempotent-Replayed", "true");
    return c.json(task, 200);
  }
  await publishTaskEvent("created", task);
  return c.json(task, 201);
});

taskRoutes.get("/:id", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  const task = await loadTaskView(id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  return c.json(task);
});

taskRoutes.patch("/:id", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const raw = await readJson(c);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_body", "Body must be a JSON object.");
  }
  if (Object.keys(raw).length === 0) {
    throw new HttpError(400, "invalid_body", "Provide at least one field to update.");
  }
  if ("status" in raw) {
    throw new HttpError(
      400,
      "status_immutable",
      "Status cannot be changed here. Complete the task with POST /tasks/:id/complete, cancel it with POST /tasks/:id/cancel, or reopen it with POST /tasks/:id/reopen.",
    );
  }
  for (const key of Object.keys(raw)) {
    if (BLOCKED_UPDATE.has(key)) {
      throw new HttpError(400, "field_immutable", `${key} cannot be changed on this endpoint.`);
    }
  }
  const body = parseBody(updateTaskSchema, raw);
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);

  const action = body.action ?? existing.action;
  const owner: ActorRef = body.owner ?? { type: existing.ownerType, id: existing.ownerId };
  const waitingOn =
    action === "delegate"
      ? body.waitingOn !== undefined
        ? blankToNull(body.waitingOn) ?? null
        : existing.waitingOn
      : null;
  assertDelegate(action, waitingOn, owner);
  const calendarEventId =
    body.calendarEventId !== undefined ? blankToNull(body.calendarEventId) ?? null : existing.calendarEventId;
  const dueAt = body.dueAt !== undefined ? parseDue(body.dueAt) : existing.dueAt;
  assertScheduleDue(action, calendarEventId, dueAt);
  const needsCalendar = resolveNeedsCalendar(action, calendarEventId, body.needsCalendar, {
    action: existing.action,
    needsCalendar: existing.needsCalendar,
  });
  if (body.owner) await assertOwnerOnTeam(existing.teamId, owner);
  const projectId = body.projectId !== undefined ? body.projectId : existing.projectId;
  const areaId = body.areaId !== undefined ? body.areaId : existing.areaId;
  if (body.projectId) await assertNamedOnTeam("project", existing.teamId, body.projectId);
  if (body.areaId) await assertNamedOnTeam("area", existing.teamId, body.areaId);

  const [row] = await db
    .update(tasks)
    .set({
      title: body.title?.trim() ?? existing.title,
      detail: body.detail !== undefined ? blankToNull(body.detail) ?? null : existing.detail,
      ownerType: owner.type,
      ownerId: owner.id,
      important: body.important ?? existing.important,
      urgent: body.urgent ?? existing.urgent,
      action,
      waitingOn,
      calendarEventId,
      needsCalendar,
      projectId,
      areaId,
      sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
      source: body.source !== undefined ? body.source : existing.source,
      dueAt,
      snoozedUntil: acknowledgeWake(existing.snoozedUntil) ? null : existing.snoozedUntil,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("updated", task);
  return c.json(task);
});

taskRoutes.post("/:id/complete", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const body = parseBody(completeTaskSchema, await readJson(c));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  if (existing.status === "done") {
    throw new HttpError(409, "already_done", "This task is already done.");
  }
  if (existing.status === "cancelled") {
    throw new HttpError(409, "already_cancelled", "This task is cancelled.");
  }
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({
      status: "done",
      outcome: body.outcome.trim(),
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("completed", task);
  return c.json(task);
});

taskRoutes.post("/:id/cancel", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const body = parseBody(cancelTaskSchema, await readJson(c));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  if (existing.status === "done") {
    throw new HttpError(409, "already_done", "This task is already done.");
  }
  if (existing.status === "cancelled") {
    throw new HttpError(409, "already_cancelled", "This task is already cancelled.");
  }
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({
      status: "cancelled",
      outcome: body.outcome ?? "cancelled",
      cancelledAt: now,
      updatedAt: now,
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("cancelled", task);
  return c.json(task);
});

taskRoutes.post("/:id/reopen", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  if (existing.status === "open") {
    const task = await loadTaskView(id);
    if (!task) throw new HttpError(404, "not_found", "Task not found.");
    return c.json(task);
  }
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({
      status: "open",
      outcome: null,
      completedAt: null,
      cancelledAt: null,
      updatedAt: now,
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("updated", task);
  return c.json(task);
});

taskRoutes.post("/:id/snooze", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const body = parseBody(snoozeTaskSchema, await readJson(c));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  if (existing.status !== "open") {
    throw new HttpError(409, "not_open", "Only an open task can be snoozed.");
  }
  const until = new Date(body.until);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    throw new HttpError(400, "until_not_future", "until must be a time in the future.");
  }
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({ snoozedUntil: until, updatedAt: now })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("updated", task);
  return c.json(task);
});

taskRoutes.post("/:id/unsnooze", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  if (existing.snoozedUntil == null) {
    const task = await loadTaskView(id);
    if (!task) throw new HttpError(404, "not_found", "Task not found.");
    return c.json(task);
  }
  const now = new Date();
  const [row] = await db
    .update(tasks)
    .set({ snoozedUntil: null, updatedAt: now })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = await loadTaskView(row.id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("updated", task);
  return c.json(task);
});

taskRoutes.delete("/:id", async (c) => {
  const id = await resolveTaskId(c.get("actor"), c.req.param("id"));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  const snapshot = await loadTaskView(id);
  if (!snapshot) throw new HttpError(404, "not_found", "Task not found.");
  const [row] = await db.delete(tasks).where(eq(tasks.id, id)).returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("deleted", snapshot, new Date().toISOString());
  const body: DeletedTask = { id: snapshot.id, deleted: true };
  return c.json(body);
});

async function loadTask(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  return row;
}

function taskInsertValues(actor: Actor, body: CreateTaskInput, now: Date) {
  const important = body.important ?? false;
  const urgent = body.urgent ?? false;
  const action = body.action ?? suggestAction(important, urgent);
  const owner = body.owner ?? actorRef(actor);
  const waitingOn = action === "delegate" ? blankToNull(body.waitingOn) ?? null : null;
  assertDelegate(action, waitingOn, owner);
  const calendarEventId = blankToNull(body.calendarEventId) ?? null;
  const needsCalendar = resolveNeedsCalendar(action, calendarEventId, body.needsCalendar, null);
  const dueAt = action === "delegate" && body.dueAt === undefined ? followUpFrom(now) : parseDue(body.dueAt);
  assertScheduleDue(action, calendarEventId, dueAt);
  return {
    owner,
    row: {
      teamId: body.teamId,
      title: body.title.trim(),
      detail: blankToNull(body.detail) ?? null,
      ownerType: owner.type,
      ownerId: owner.id,
      important,
      urgent,
      action,
      waitingOn,
      calendarEventId,
      needsCalendar,
      projectId: body.projectId ?? null,
      areaId: body.areaId ?? null,
      sortOrder: body.sortOrder ?? null,
      source: body.source ?? null,
      dueAt,
      createdAt: now,
      updatedAt: now,
      createdByType: actor.type,
      createdById: actor.id,
    },
  };
}

async function assertLinks(teamId: string, projectId: string | null, areaId: string | null) {
  if (projectId) await assertNamedOnTeam("project", teamId, projectId);
  if (areaId) await assertNamedOnTeam("area", teamId, areaId);
}

function assertDelegate(action: Action, waitingOn: string | null, owner: ActorRef) {
  if (delegateRequiresWaitingOn(action, owner) && !waitingOn) {
    throw new HttpError(
      400,
      "waiting_on_required",
      "Delegated tasks need waitingOn unless a bot owns them.",
    );
  }
}

function assertScheduleDue(action: Action, calendarEventId: string | null, dueAt: Date | null) {
  if (!scheduleRequiresDueAt(action, calendarEventId, dueAt)) return;
  throw new HttpError(
    400,
    "due_at_required",
    "A linked schedule needs a time. Set dueAt to the event, then the open task can be checked in after it passes.",
  );
}

/**
 * Human morning queue. Same membership as `inMorningQueue` when `owner` is set.
 * Schedule needs a calendar, or is a check-in (`needsCheckIn`: dueAt strictly past).
 * An outsider delegate includes due now.
 * `later` is excluded, including future steps on a project.
 * Several do_now, delegate, or schedule tasks may share a project; this does not limit them.
 * Bot-owned delegates stay out: they are that bot's work, not an outsider nudge.
 */
function morningQueueFilter() {
  return sql`(
    ${tasks.action} = 'do_now'
    OR (
      ${tasks.action} = 'schedule'
      AND (
        ${tasks.needsCalendar}
        OR (${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < now())
      )
    )
    OR (
      ${tasks.action} = 'delegate'
      AND ${tasks.ownerType} <> 'bot'
      AND (
        (${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} <= now())
        OR (${tasks.dueAt} IS NULL AND ${tasks.createdAt} < now() - interval '3 days')
      )
    )
  )`;
}

/** Same membership as `inBotQueue` in @hearth/shared. Schedule check-ins for this token's owner id. */
function botQueueFilter(botId: string) {
  return and(
    eq(tasks.ownerType, "bot"),
    eq(tasks.ownerId, botId),
    sql`(
      ${tasks.action} = 'delegate'
      OR (
        ${tasks.action} = 'schedule'
        AND (
          ${tasks.needsCalendar}
          OR (${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < now())
        )
      )
    )`,
  );
}

function parseDue(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "invalid_body", "dueAt must be an ISO datetime.");
  }
  return date;
}

function optionalUuid(value: string | undefined, name: string) {
  if (value === undefined || value === "") return undefined;
  requireUuid(value, name);
  return value;
}

function parseBool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new HttpError(400, "invalid_query", `${name} must be true or false.`);
}

function parseAction(value: string | undefined): Action | undefined {
  if (value === undefined) return undefined;
  if ((actions as readonly string[]).includes(value)) return value as Action;
  throw new HttpError(400, "invalid_query", "action must be do_now, delegate, schedule, or later.");
}

/** Snoozed means snoozed_until is strictly after now. A passed time is awake again. */
function notCurrentlySnoozed() {
  return sql`(${tasks.snoozedUntil} IS NULL OR ${tasks.snoozedUntil} <= now())`;
}

function acknowledgeWake(snoozedUntil: Date | null) {
  return snoozedUntil != null && snoozedUntil.getTime() <= Date.now();
}

function parseStatus(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if ((taskStatuses as readonly string[]).includes(value)) return value as TaskStatus;
  throw new HttpError(400, "invalid_query", "status must be open, done, or cancelled.");
}

function parseOwner(value: string): ActorRef {
  const match = /^(user|bot):([0-9a-f-]{36})$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new HttpError(400, "invalid_query", "owner must be user:<uuid> or bot:<uuid>.");
  }
  requireUuid(match[2], "owner");
  return { type: match[1] as "user" | "bot", id: match[2] };
}
