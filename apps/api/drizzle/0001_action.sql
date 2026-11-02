-- Map GTD lane onto Eisenhower action. Calendar event ids are not invented.
-- Waiting tasks with no due date get a follow-up of created_at + 3 days
-- (created_at is NOT NULL, so a now()+3 days fallback is unnecessary).
CREATE TYPE "task_action" AS ENUM ('do_now', 'delegate', 'schedule', 'later');
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN "action" "task_action",
  ADD COLUMN "calendar_event_id" text,
  ADD COLUMN "needs_calendar" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "tasks"
SET
  "action" = CASE "lane"
    WHEN 'next' THEN 'do_now'::"task_action"
    WHEN 'waiting' THEN 'delegate'::"task_action"
    WHEN 'someday' THEN 'later'::"task_action"
  END,
  "due_at" = CASE
    WHEN "lane" = 'waiting' AND "due_at" IS NULL THEN "created_at" + interval '3 days'
    ELSE "due_at"
  END,
  "needs_calendar" = false;
--> statement-breakpoint
ALTER TABLE "tasks"
  ALTER COLUMN "action" SET NOT NULL,
  ALTER COLUMN "action" SET DEFAULT 'later'::"task_action";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_waiting_on_chk";
--> statement-breakpoint
DROP INDEX "tasks_team_status_lane_idx";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "lane";
--> statement-breakpoint
DROP TYPE "task_lane";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_delegate_waiting_chk" CHECK (
  "action" <> 'delegate' OR ("waiting_on" IS NOT NULL AND length(btrim("waiting_on")) > 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_calendar_chk" CHECK (
  ("calendar_event_id" IS NULL OR length(btrim("calendar_event_id")) > 0)
  AND ("calendar_event_id" IS NULL OR "needs_calendar" = false)
  AND (
    "action" <> 'schedule'
    OR "calendar_event_id" IS NOT NULL
    OR "needs_calendar" = true
  )
);
--> statement-breakpoint
CREATE INDEX "tasks_team_status_action_idx" ON "tasks" ("team_id", "status", "action");
