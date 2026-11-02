import type { AreaSummary, ProjectSummary } from "@hearth/shared";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db.js";
import { blankToNull, HttpError } from "./errors.js";
import { iso } from "./http.js";
import { areas, projects, tasks } from "./schema.js";

type Kind = "project" | "area";
type NamedRow = typeof projects.$inferSelect;

const tables = { project: projects, area: areas } as const;

function table(kind: Kind): typeof projects {
  return tables[kind] as typeof projects;
}

function noun(kind: Kind) {
  return kind === "project" ? "Project" : "Area";
}

export function toNamed(kind: Kind, row: NamedRow, areaName?: string | null): ProjectSummary | AreaSummary {
  const summary = {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
  };
  if (kind === "project") {
    return {
      ...summary,
      notes: row.notes ?? null,
      area: row.areaId && areaName ? { id: row.areaId, name: areaName } : null,
    };
  }
  return summary;
}

export async function withProjectAreas(rows: NamedRow[]): Promise<ProjectSummary[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.areaId ? [row.areaId] : [])))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const found = await db.select({ id: areas.id, name: areas.name }).from(areas).where(inArray(areas.id, ids));
    for (const area of found) names.set(area.id, area.name);
  }
  return rows.map((row) => toNamed("project", row, row.areaId ? names.get(row.areaId) ?? null : null) as ProjectSummary);
}

export async function listNamed(kind: Kind, teamId: string, includeArchived: boolean) {
  const filters = [eq(table(kind).teamId, teamId)];
  if (!includeArchived) filters.push(isNull(table(kind).archivedAt));
  return db
    .select()
    .from(table(kind))
    .where(and(...filters))
    .orderBy(table(kind).name, table(kind).createdAt);
}

/**
 * Same name on the team returns the existing row. An archived row is restored.
 * For a project, `notes` when provided replaces the stored plan. Omit it to leave the plan alone.
 */
export async function createNamed(kind: Kind, teamId: string, name: string, notes?: string | null) {
  const normalised = name.trim();
  const notesProvided = kind === "project" && notes !== undefined;
  const storedNotes = notesProvided ? blankToNull(notes) ?? null : null;
  const existing = await findByName(kind, teamId, normalised);
  if (existing) {
    if (!existing.archivedAt && !notesProvided) return { row: existing, created: false };
    const [row] = await db
      .update(table(kind))
      .set({
        name: existing.archivedAt ? normalised : existing.name,
        archivedAt: null,
        updatedAt: new Date(),
        ...(notesProvided ? { notes: storedNotes } : {}),
      })
      .where(eq(table(kind).id, existing.id))
      .returning();
    if (!row) throw new Error(`Failed to restore ${kind}`);
    return { row, created: false };
  }
  try {
    const [row] = await db
      .insert(table(kind))
      .values(kind === "project" ? { teamId, name: normalised, notes: storedNotes } : { teamId, name: normalised })
      .returning();
    if (!row) throw new Error(`Failed to create ${kind}`);
    return { row, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = await findByName(kind, teamId, normalised);
    if (!again) throw err;
    return { row: again, created: false };
  }
}

export async function updateNamed(
  kind: Kind,
  teamId: string,
  id: string,
  input: { name?: string; archived?: boolean; notes?: string | null; areaId?: string | null },
) {
  const [existing] = await db
    .select()
    .from(table(kind))
    .where(and(eq(table(kind).id, id), eq(table(kind).teamId, teamId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "not_found", `${noun(kind)} not found.`);
  const name = input.name?.trim() ?? existing.name;
  if (input.name !== undefined) {
    const clash = await findByName(kind, teamId, name);
    if (clash && clash.id !== id) {
      throw new HttpError(409, "conflict", `That ${kind} name is already used.`);
    }
  }
  let archivedAt = existing.archivedAt;
  if (input.archived === true && kind === "project") {
    const [open] = await db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, id), eq(tasks.status, "open")));
    if (Number(open?.n ?? 0) > 0) {
      throw new HttpError(
        409,
        "project_open_tasks",
        "Complete or cancel open tasks before completing this project.",
      );
    }
  }
  if (input.archived === true) archivedAt = existing.archivedAt ?? new Date();
  if (input.archived === false) archivedAt = null;
  const notes = kind === "project" && input.notes !== undefined ? blankToNull(input.notes) ?? null : undefined;
  if (kind === "project" && input.areaId) await assertNamedOnTeam("area", teamId, input.areaId);
  const areaId = kind === "project" && input.areaId !== undefined ? input.areaId : undefined;
  try {
    const [row] = await db
      .update(table(kind))
      .set({
        name,
        archivedAt,
        updatedAt: new Date(),
        ...(notes !== undefined ? { notes } : {}),
        ...(areaId !== undefined ? { areaId } : {}),
      })
      .where(and(eq(table(kind).id, id), eq(table(kind).teamId, teamId)))
      .returning();
    if (!row) throw new HttpError(404, "not_found", `${noun(kind)} not found.`);
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "conflict", `That ${kind} name is already used.`);
    }
    throw err;
  }
}

export async function assertNamedOnTeam(kind: Kind, teamId: string, id: string) {
  const [row] = await db
    .select({ id: table(kind).id })
    .from(table(kind))
    .where(and(eq(table(kind).id, id), eq(table(kind).teamId, teamId)))
    .limit(1);
  if (!row) {
    throw new HttpError(
      400,
      kind === "project" ? "invalid_project" : "invalid_area",
      `${noun(kind)} is not on this team.`,
    );
  }
}

async function findByName(kind: Kind, teamId: string, name: string) {
  const [row] = await db
    .select()
    .from(table(kind))
    .where(and(eq(table(kind).teamId, teamId), sql`lower(btrim(${table(kind).name})) = ${name.toLowerCase()}`))
    .limit(1);
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ("code" in err && (err as { code?: unknown }).code === "23505") return true;
  if ("cause" in err) return isUniqueViolation((err as { cause?: unknown }).cause);
  return false;
}
