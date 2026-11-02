import {
  completeTaskSchema,
  createTaskSchema,
  lanes,
  taskStatuses,
  updateTaskSchema,
  type ActorRef,
  type Lane,
  type Task,
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
  type AppEnv,
} from "../actor.js";
import { db } from "../db.js";
import { blankToNull, HttpError, parseBody } from "../errors.js";
import { iso, readJson, requireUuid } from "../http.js";
import { tasks } from "../schema.js";

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
    .where(and(inArray(tasks.teamId, ids), eq(tasks.status, "open"), eq(tasks.lane, "next")))
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
  const teamId = optionalUuid(query.teamId, "teamId");
  const ids = await teamIdsFor(actor, teamId);
  if (ids.length === 0) return c.json({ tasks: [] });

  const filters: SQL[] = [inArray(tasks.teamId, ids)];
  const lane = parseLane(query.lane);
  const status = parseStatus(query.status);
  const important = parseBool(query.important, "important");
  const urgent = parseBool(query.urgent, "urgent");
  const mine = parseBool(query.mine, "mine");
  if (lane) filters.push(eq(tasks.lane, lane));
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
  await requireTeam(actor, body.teamId);
  const lane = body.lane ?? "next";
  const waitingOn = lane === "waiting" ? blankToNull(body.waitingOn) ?? null : null;
  assertWaiting(lane, waitingOn);
  const owner = body.owner ?? actorRef(actor);
  await assertOwnerOnTeam(body.teamId, owner);
  const now = new Date();
  const [row] = await db
    .insert(tasks)
    .values({
      teamId: body.teamId,
      title: body.title.trim(),
      detail: blankToNull(body.detail) ?? null,
      ownerType: owner.type,
      ownerId: owner.id,
      important: body.important ?? false,
      urgent: body.urgent ?? false,
      lane,
      waitingOn,
      project: blankToNull(body.project) ?? null,
      dueAt: parseDue(body.dueAt),
      createdAt: now,
      updatedAt: now,
      createdByType: actor.type,
      createdById: actor.id,
    })
    .returning();
  if (!row) throw new Error("Failed to create task");
  return c.json(toTask(row), 201);
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

  const lane = body.lane ?? existing.lane;
  const waitingOn =
    lane === "waiting"
      ? body.waitingOn !== undefined
        ? blankToNull(body.waitingOn) ?? null
        : existing.waitingOn
      : null;
  assertWaiting(lane, waitingOn);
  const owner: ActorRef =
    body.owner ?? { type: existing.ownerType, id: existing.ownerId };
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
      lane,
      waitingOn,
      project: body.project !== undefined ? blankToNull(body.project) ?? null : existing.project,
      dueAt: body.dueAt !== undefined ? parseDue(body.dueAt) : existing.dueAt,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  return c.json(toTask(row));
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
  return c.json(toTask(row));
});

async function loadTask(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  return row;
}

function assertWaiting(lane: Lane, waitingOn: string | null) {
  if (lane === "waiting" && !waitingOn) {
    throw new HttpError(400, "waiting_on_required", "Waiting tasks need waitingOn.");
  }
}

function parseDue(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "invalid_body", "dueAt must be an ISO datetime.");
  }
  return date;
}

function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    teamId: row.teamId,
    title: row.title,
    detail: row.detail,
    status: row.status,
    owner: { type: row.ownerType, id: row.ownerId },
    important: row.important,
    urgent: row.urgent,
    lane: row.lane,
    waitingOn: row.waitingOn,
    project: row.project,
    dueAt: iso(row.dueAt),
    outcome: row.outcome,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    completedAt: iso(row.completedAt),
    createdBy: { type: row.createdByType, id: row.createdById },
  };
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

function parseLane(value: string | undefined): Lane | undefined {
  if (value === undefined) return undefined;
  if ((lanes as readonly string[]).includes(value)) return value as Lane;
  throw new HttpError(400, "invalid_query", "lane must be next, waiting, or someday.");
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
