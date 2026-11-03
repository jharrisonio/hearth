-- http(s) pages attached to a task. created_by is a user or a bot, same as tasks, so it has no foreign key.
CREATE TABLE "task_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "url" text NOT NULL,
  "created_by_type" "actor_type" NOT NULL,
  "created_by_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "task_links_title_chk" CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "task_links_url_chk" CHECK (
    char_length("url") BETWEEN 1 AND 2048
    AND "url" ~ '^https?://[^[:space:]]+$'
  ),
  CONSTRAINT "task_links_position_chk" CHECK ("position" >= 0),
  CONSTRAINT "task_links_task_url_key" UNIQUE ("task_id", "url")
);
--> statement-breakpoint
CREATE INDEX "task_links_task_id_idx" ON "task_links" ("task_id");
