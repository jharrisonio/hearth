import {
  actions,
  completeTaskSchema,
  createTaskSchema,
  followUpFrom,
  resolveNeedsCalendar,
  suggestAction,
  taskStatuses,
  updateTaskSchema,
  type Action,
  type ActorRef,
  type CreateTaskInput,
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
import { tasks } from "../schema.js";
import { toTask } from "../task-json.js";

const BLOCKED_UPDATE = new Set([
  "status",
  "outcome",
  "completedAt",
  "id",
  "teamId",
  "createdAt",
  "updatedAt",
  "createdBy",
]);

export const taskRoutes = new Hono<AppEnv>();
taskRoutes.use("*", requireActor);

taskRoutes.get("/do-immediately", async (c) => {
  const actor = c.get("actor");
  const teamId = optionalUuid(c.req.query("teamId"), "teamId");
  const ids = await teamIdsFor(actor, teamId);
  if (ids.length === 0) return c.json({ tasks: [] });
  const rows = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.teamId, ids), eq(tasks.status, "open"), morningQueueFilter()))
    .orderBy(
      sql`CASE WHEN ${tasks.important} AND ${tasks.urgent} THEN 0 WHEN ${tasks.important} THEN 1 WHEN ${tasks.urgent} THEN 2 ELSE 3 END`,
      sql`${tasks.dueAt} ASC NULLS LAST`,
      desc(tasks.updatedAt),
    )
    .limit(100);
  return c.json({ tasks: rows.map(toTask) });
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
  const mine = parseBool(query.mine, "mine");
  if (action) filters.push(eq(tasks.action, action));
  if (status) filters.push(eq(tasks.status, status));
  if (important !== undefined) filters.push(eq(tasks.important, important));
  if (urgent !== undefined) filters.push(eq(tasks.urgent, urgent));
  if (query.project !== undefined) {
    if (query.project.length > 120) throw new HttpError(400, "invalid_query", "project is too long.");
    filters.push(eq(tasks.project, query.project));
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

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...filters))
    .orderBy(desc(tasks.updatedAt), desc(tasks.createdAt))
    .limit(200);
  return c.json({ tasks: rows.map(toTask) });
});

taskRoutes.post("/", async (c) => {
  const actor = c.get("actor");
  const body = parseBody(createTaskSchema, await readJson(c));
  const key = parseIdempotencyKey(c.req.header("idempotency-key"));
  await requireTeam(actor, body.teamId);
  const values = taskInsertValues(actor, body, new Date());
  await assertOwnerOnTeam(body.teamId, values.owner);
  const { row, replayed } = await withCreateIdempotency(actor, key, body, async (tx) => {
    const [inserted] = await tx.insert(tasks).values(values.row).returning();
    if (!inserted) throw new Error("Failed to create task");
    return inserted;
  });
  const task = toTask(row);
  if (replayed) {
    c.header("Idempotent-Replayed", "true");
    return c.json(task, 200);
  }
  await publishTaskEvent("created", task);
  return c.json(task, 201);
});

taskRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  requireUuid(id, "id");
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
      "Status cannot be changed here. Complete the task with POST /tasks/:id/complete.",
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
  const waitingOn =
    action === "delegate"
      ? body.waitingOn !== undefined
        ? blankToNull(body.waitingOn) ?? null
        : existing.waitingOn
      : null;
  assertDelegate(action, waitingOn);
  const calendarEventId =
    body.calendarEventId !== undefined ? blankToNull(body.calendarEventId) ?? null : existing.calendarEventId;
  const needsCalendar = resolveNeedsCalendar(action, calendarEventId, body.needsCalendar, {
    action: existing.action,
    needsCalendar: existing.needsCalendar,
  });
  const owner: ActorRef = body.owner ?? { type: existing.ownerType, id: existing.ownerId };
  if (body.owner) await assertOwnerOnTeam(existing.teamId, owner);

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
      project: body.project !== undefined ? blankToNull(body.project) ?? null : existing.project,
      dueAt: body.dueAt !== undefined ? parseDue(body.dueAt) : existing.dueAt,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  const task = toTask(row);
  await publishTaskEvent("updated", task);
  return c.json(task);
});

taskRoutes.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  requireUuid(id, "id");
  const body = parseBody(completeTaskSchema, await readJson(c));
  const existing = await loadTask(id);
  await requireTeam(c.get("actor"), existing.teamId);
  if (existing.status === "done") {
    throw new HttpError(409, "already_done", "This task is already done.");
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
  const task = toTask(row);
  await publishTaskEvent("completed", task);
  return c.json(task);
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
  const waitingOn = action === "delegate" ? blankToNull(body.waitingOn) ?? null : null;
  assertDelegate(action, waitingOn);
  const calendarEventId = blankToNull(body.calendarEventId) ?? null;
  const needsCalendar = resolveNeedsCalendar(action, calendarEventId, body.needsCalendar, null);
  const owner = body.owner ?? actorRef(actor);
  const dueAt = action === "delegate" && body.dueAt === undefined ? followUpFrom(now) : parseDue(body.dueAt);
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
      project: blankToNull(body.project) ?? null,
      dueAt,
      createdAt: now,
      updatedAt: now,
      createdByType: actor.type,
      createdById: actor.id,
    },
  };
}

function assertDelegate(action: Action, waitingOn: string | null) {
  if (action === "delegate" && !waitingOn) {
    throw new HttpError(400, "waiting_on_required", "Delegated tasks need waitingOn.");
  }
}

/** Same membership as `inMorningQueue` in @hearth/shared. Schedule is strictly past; delegate includes due now. */
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
      AND (
        (${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} <= now())
        OR (${tasks.dueAt} IS NULL AND ${tasks.createdAt} < now() - interval '3 days')
      )
    )
  )`;
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

function parseStatus(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if ((taskStatuses as readonly string[]).includes(value)) return value as TaskStatus;
  throw new HttpError(400, "invalid_query", "status must be open or done.");
}

function parseOwner(value: string): ActorRef {
  const match = /^(user|bot):([0-9a-f-]{36})$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new HttpError(400, "invalid_query", "owner must be user:<uuid> or bot:<uuid>.");
  }
  requireUuid(match[2], "owner");
  return { type: match[1] as "user" | "bot", id: match[2] };
}
