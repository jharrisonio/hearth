import { taskSourceSchema, type AttachedLink, type Task, type TaskSource } from "@hearth/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db.js";
import { iso } from "./http.js";
import { areas, projects, taskLinks, tasks, teams } from "./schema.js";

type TaskRow = typeof tasks.$inferSelect;

export function toTask(
  row: TaskRow,
  names: { projectName: string | null; areaName: string | null; teamKey: string },
): Task {
  return {
    id: row.id,
    key: `${names.teamKey}-${row.number}`,
    number: row.number,
    teamId: row.teamId,
    title: row.title,
    detail: row.detail,
    status: row.status,
    owner: { type: row.ownerType, id: row.ownerId },
    important: row.important,
    urgent: row.urgent,
    action: row.action,
    waitingOn: row.waitingOn,
    calendarEventId: row.calendarEventId,
    needsCalendar: row.needsCalendar,
    project: row.projectId && names.projectName ? { id: row.projectId, name: names.projectName } : null,
    area: row.areaId && names.areaName ? { id: row.areaId, name: names.areaName } : null,
    source: readSource(row.source),
    dueAt: iso(row.dueAt),
    snoozedUntil: iso(row.snoozedUntil),
    outcome: row.outcome,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    sortOrder: row.sortOrder,
    createdBy: { type: row.createdByType, id: row.createdById },
    links: [],
  };
}

type LinkRow = typeof taskLinks.$inferSelect;

export function toAttachedLink(row: LinkRow): AttachedLink {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    position: row.position,
    createdBy: { type: row.createdByType, id: row.createdById },
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

export async function attachLinks(items: Task[]): Promise<Task[]> {
  if (items.length === 0) return items;
  const rows = await db
    .select()
    .from(taskLinks)
    .where(
      inArray(
        taskLinks.taskId,
        items.map((item) => item.id),
      ),
    )
    .orderBy(asc(taskLinks.position), asc(taskLinks.createdAt), asc(taskLinks.id));
  const grouped = new Map<string, AttachedLink[]>();
  for (const row of rows) {
    const link = toAttachedLink(row);
    const list = grouped.get(row.taskId);
    if (list) list.push(link);
    else grouped.set(row.taskId, [link]);
  }
  return items.map((item) => ({ ...item, links: grouped.get(item.id) ?? [] }));
}

function readSource(value: TaskSource | null): TaskSource | null {
  if (value == null) return null;
  const parsed = taskSourceSchema.safeParse(value);
  if (!parsed.success) throw new Error("Task source stored in an unexpected shape.");
  return parsed.data;
}

export function taskViews() {
  return db
    .select({
      task: tasks,
      projectName: projects.name,
      areaName: areas.name,
      teamKey: teams.key,
    })
    .from(tasks)
    .innerJoin(teams, eq(teams.id, tasks.teamId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(areas, eq(areas.id, tasks.areaId));
}

export async function loadTaskView(id: string): Promise<Task | null> {
  const [row] = await taskViews().where(eq(tasks.id, id)).limit(1);
  if (!row) return null;
  const [task] = await attachLinks([toTask(row.task, row)]);
  return task ?? null;
}

export function viewTask(row: {
  task: TaskRow;
  projectName: string | null;
  areaName: string | null;
  teamKey: string;
}) {
  return toTask(row.task, row);
}
