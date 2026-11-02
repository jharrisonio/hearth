import { taskSourceSchema, type Task, type TaskSource } from "@hearth/shared";
import { iso } from "./http.js";
import { tasks } from "./schema.js";

export function toTask(row: typeof tasks.$inferSelect): Task {
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
    project: row.project,
    source: readSource(row.source),
    dueAt: iso(row.dueAt),
    outcome: row.outcome,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    completedAt: iso(row.completedAt),
    createdBy: { type: row.createdByType, id: row.createdById },
  };
}

function readSource(value: TaskSource | null): TaskSource | null {
  if (value == null) return null;
  const parsed = taskSourceSchema.safeParse(value);
  if (!parsed.success) throw new Error("Task source stored in an unexpected shape.");
  return parsed.data;
}
