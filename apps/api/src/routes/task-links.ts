import { createAttachedLinkSchema, updateAttachedLinkSchema, type DeletedLink } from "@hearth/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { actorRef, requireTeam, type Actor, type AppEnv } from "../actor.js";
import { db } from "../db.js";
import { HttpError, parseBody } from "../errors.js";
import { publishTaskEvent } from "../events.js";
import { readJson, requireUuid } from "../http.js";
import { taskLinks, tasks } from "../schema.js";
import { loadTaskView, toAttachedLink } from "../task-json.js";
import { resolveTaskId } from "../task-ref.js";

export function registerTaskLinkRoutes(routes: Hono<AppEnv>) {
  routes.get("/:id/links", async (c) => {
    const task = await loadOwnedTask(c.get("actor"), c.req.param("id"));
    const rows = await db
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.taskId, task.id))
      .orderBy(asc(taskLinks.position), asc(taskLinks.createdAt), asc(taskLinks.id));
    return c.json({ links: rows.map(toAttachedLink) });
  });

  routes.post("/:id/links", async (c) => {
    const actor = c.get("actor");
    const task = await loadOwnedTask(actor, c.req.param("id"));
    const body = parseBody(createAttachedLinkSchema, await readJson(c));
    const position = body.position ?? (await nextPosition(task.id));
    const now = new Date();
    const owner = actorRef(actor);
    const inserted = await db
      .insert(taskLinks)
      .values({
        taskId: task.id,
        title: body.title,
        url: body.url,
        position,
        createdByType: owner.type,
        createdById: owner.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [taskLinks.taskId, taskLinks.url] })
      .returning();
    const created = inserted[0];
    if (!created) {
      const [existing] = await db
        .select()
        .from(taskLinks)
        .where(and(eq(taskLinks.taskId, task.id), eq(taskLinks.url, body.url)))
        .limit(1);
      if (!existing) throw new Error("Failed to add link");
      return c.json(toAttachedLink(existing), 200);
    }
    await touchTask(task.id);
    return c.json(toAttachedLink(created), 201);
  });

  routes.patch("/:id/links/:linkId", async (c) => {
    const task = await loadOwnedTask(c.get("actor"), c.req.param("id"));
    const linkId = c.req.param("linkId");
    requireUuid(linkId, "linkId");
    const body = parseBody(updateAttachedLinkSchema, await readJson(c));
    const [current] = await db
      .select()
      .from(taskLinks)
      .where(and(eq(taskLinks.id, linkId), eq(taskLinks.taskId, task.id)))
      .limit(1);
    if (!current) throw new HttpError(404, "not_found", "Link not found.");
    try {
      const [row] = await db
        .update(taskLinks)
        .set({
          title: body.title ?? current.title,
          url: body.url ?? current.url,
          position: body.position ?? current.position,
          updatedAt: new Date(),
        })
        .where(and(eq(taskLinks.id, linkId), eq(taskLinks.taskId, task.id)))
        .returning();
      if (!row) throw new HttpError(404, "not_found", "Link not found.");
      await touchTask(task.id);
      return c.json(toAttachedLink(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError(409, "duplicate_link", "That URL is already on this task.");
      }
      throw err;
    }
  });

  routes.delete("/:id/links/:linkId", async (c) => {
    const task = await loadOwnedTask(c.get("actor"), c.req.param("id"));
    const linkId = c.req.param("linkId");
    requireUuid(linkId, "linkId");
    const [row] = await db
      .delete(taskLinks)
      .where(and(eq(taskLinks.id, linkId), eq(taskLinks.taskId, task.id)))
      .returning();
    if (!row) throw new HttpError(404, "not_found", "Link not found.");
    await touchTask(task.id);
    const body: DeletedLink = { id: row.id, deleted: true };
    return c.json(body);
  });
}

async function loadOwnedTask(actor: Actor, rawId: string) {
  const id = await resolveTaskId(actor, rawId);
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "Task not found.");
  await requireTeam(actor, row.teamId);
  return row;
}

async function nextPosition(taskId: string) {
  const [row] = await db
    .select({ value: sql<number | null>`coalesce(max(${taskLinks.position}), -1)` })
    .from(taskLinks)
    .where(eq(taskLinks.taskId, taskId));
  return Number(row?.value ?? -1) + 1;
}

async function touchTask(id: string) {
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, id));
  const task = await loadTaskView(id);
  if (!task) throw new HttpError(404, "not_found", "Task not found.");
  await publishTaskEvent("updated", task);
  return task;
}

function isUniqueViolation(err: unknown) {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && (current as { code?: unknown }).code === "23505") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
