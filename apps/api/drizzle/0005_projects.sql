-- Projects are multi-step outcomes. Areas are life or work domains.
-- A free-text tasks.project value becomes a project, unless it is an area
-- name that was stored on the wrong field. Those tasks are left unlinked.
-- The text column is dropped once the link is written.
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "archived_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "projects_name_len" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_team_name_idx" ON "projects" ("team_id", lower(btrim("name")));
--> statement-breakpoint
CREATE INDEX "projects_team_idx" ON "projects" ("team_id");
--> statement-breakpoint
CREATE TABLE "areas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "archived_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "areas_name_len" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "areas_team_name_idx" ON "areas" ("team_id", lower(btrim("name")));
--> statement-breakpoint
CREATE INDEX "areas_team_idx" ON "areas" ("team_id");
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  ADD COLUMN "area_id" uuid REFERENCES "areas"("id") ON DELETE SET NULL;
--> statement-breakpoint
WITH "excluded"("name") AS (
  VALUES
    ('house'),
    ('home'),
    ('finance'),
    ('work'),
    ('kitchen'),
    ('shed'),
    ('admin'),
    ('errands'),
    ('personal'),
    ('health'),
    ('family'),
    ('career')
),
"source" AS (
  SELECT DISTINCT ON ("team_id", lower(left(btrim("project"), 120)))
    "team_id",
    left(btrim("project"), 120) AS "name"
  FROM "tasks"
  WHERE "project" IS NOT NULL
    AND length(btrim("project")) > 0
    AND lower(btrim("project")) NOT IN (SELECT "name" FROM "excluded")
  ORDER BY
    "team_id",
    lower(left(btrim("project"), 120)),
    length(btrim("project")) DESC,
    left(btrim("project"), 120)
),
"inserted" AS (
  INSERT INTO "projects" ("team_id", "name")
  SELECT "team_id", "name" FROM "source"
  RETURNING "id", "team_id", "name"
)
UPDATE "tasks" AS t
SET "project_id" = i."id"
FROM "inserted" AS i
WHERE t."project" IS NOT NULL
  AND length(btrim(t."project")) > 0
  AND lower(btrim(t."project")) NOT IN (SELECT "name" FROM "excluded")
  AND i."team_id" = t."team_id"
  AND lower(i."name") = lower(left(btrim(t."project"), 120));
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "project";
--> statement-breakpoint
CREATE INDEX "tasks_project_id_idx" ON "tasks" ("project_id");
--> statement-breakpoint
CREATE INDEX "tasks_area_id_idx" ON "tasks" ("area_id");
