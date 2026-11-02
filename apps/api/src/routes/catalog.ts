import {
  createAreaSchema,
  createProjectSchema,
  updateAreaSchema,
  updateProjectSchema,
} from "@hearth/shared";
import type { Context, Hono } from "hono";
import { createNamed, listNamed, toNamed, updateNamed } from "../catalog.js";
import { requireTeam, type AppEnv } from "../actor.js";
import { HttpError, parseBody } from "../errors.js";
import { readJson, requireUuid } from "../http.js";

type Kind = "project" | "area";

const createSchemas = { project: createProjectSchema, area: createAreaSchema } as const;
const updateSchemas = { project: updateProjectSchema, area: updateAreaSchema } as const;

export function registerCatalogRoutes(routes: Hono<AppEnv>) {
  routes.get("/:teamId/projects", (c) => list(c, "project"));
  routes.post("/:teamId/projects", (c) => create(c, "project"));
  routes.patch("/:teamId/projects/:id", (c) => update(c, "project"));
  routes.get("/:teamId/areas", (c) => list(c, "area"));
  routes.post("/:teamId/areas", (c) => create(c, "area"));
  routes.patch("/:teamId/areas/:id", (c) => update(c, "area"));
}

async function list(c: Context<AppEnv>, kind: Kind) {
  const teamId = teamParam(c);
  await requireTeam(c.get("actor"), teamId);
  const includeArchived = parseFlag(c.req.query("includeArchived"), "includeArchived");
  const rows = await listNamed(kind, teamId, includeArchived);
  const key = kind === "project" ? "projects" : "areas";
  return c.json({ [key]: rows.map(toNamed) });
}

async function create(c: Context<AppEnv>, kind: Kind) {
  const teamId = teamParam(c);
  await requireTeam(c.get("actor"), teamId);
  const body = parseBody(createSchemas[kind], await readJson(c));
  const { row, created } = await createNamed(kind, teamId, body.name);
  return c.json(toNamed(row), created ? 201 : 200);
}

async function update(c: Context<AppEnv>, kind: Kind) {
  const teamId = teamParam(c);
  const id = c.req.param("id");
  if (!id) throw new HttpError(400, "invalid_query", "id must be a UUID.");
  requireUuid(id, "id");
  await requireTeam(c.get("actor"), teamId);
  const raw = await readJson(c);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new HttpError(400, "invalid_body", "Provide a name or archived.");
  }
  const body = parseBody(updateSchemas[kind], raw);
  const row = await updateNamed(kind, teamId, id, body);
  return c.json(toNamed(row));
}

function teamParam(c: Context<AppEnv>) {
  const teamId = c.req.param("teamId");
  if (!teamId) throw new HttpError(400, "invalid_query", "teamId must be a UUID.");
  requireUuid(teamId, "teamId");
  return teamId;
}

function parseFlag(value: string | undefined, name: string) {
  if (value === undefined) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new HttpError(400, "invalid_query", `${name} must be true or false.`);
}
