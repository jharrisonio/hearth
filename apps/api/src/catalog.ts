import type { AreaSummary, ProjectSummary } from "@hearth/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.js";
import { HttpError } from "./errors.js";
import { iso } from "./http.js";
import { areas, projects } from "./schema.js";

type Kind = "project" | "area";
type NamedRow = typeof projects.$inferSelect;

const tables = { project: projects, area: areas } as const;

function table(kind: Kind): typeof projects {
  return tables[kind] as typeof projects;
}

function noun(kind: Kind) {
  return kind === "project" ? "Project" : "Area";
}

export function toNamed(row: NamedRow): ProjectSummary | AreaSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
  };
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

/** Same name on the team returns the existing row. An archived row is restored. */
export async function createNamed(kind: Kind, teamId: string, name: string) {
  const normalised = name.trim();
  const existing = await findByName(kind, teamId, normalised);
  if (existing) {
    if (!existing.archivedAt) return { row: existing, created: false };
    const [row] = await db
      .update(table(kind))
      .set({ name: normalised, archivedAt: null, updatedAt: new Date() })
      .where(eq(table(kind).id, existing.id))
      .returning();
    if (!row) throw new Error(`Failed to restore ${kind}`);
    return { row, created: false };
  }
  try {
    const [row] = await db.insert(table(kind)).values({ teamId, name: normalised }).returning();
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
  input: { name?: string; archived?: boolean },
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
  if (input.archived === true) archivedAt = existing.archivedAt ?? new Date();
  if (input.archived === false) archivedAt = null;
  try {
    const [row] = await db
      .update(table(kind))
      .set({ name, archivedAt, updatedAt: new Date() })
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
