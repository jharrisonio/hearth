import { taskSourceSchema, type Task, type TaskSource } from "@hearth/shared";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { iso } from "./http.js";
import { areas, projects, tasks } from "./schema.js";

type TaskRow = typeof tasks.$inferSelect;

export function toTask(row: TaskRow, names: { projectName: string | null; areaName: string | null }): Task {
  return {
    id: row.id,
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
    outcome: row.outcome,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    createdBy: { type: row.createdByType, id: row.createdById },
  };
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
    })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(areas, eq(areas.id, tasks.areaId));
}

export async function loadTaskView(id: string): Promise<Task | null> {
  const [row] = await taskViews().where(eq(tasks.id, id)).limit(1);
  if (!row) return null;
  return toTask(row.task, row);
}

export function viewTask(row: { task: TaskRow; projectName: string | null; areaName: string | null }) {
  return toTask(row.task, row);
}
