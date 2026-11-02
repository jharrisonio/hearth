-- Cancel keeps the row. Status gains 'cancelled', with cancelled_at and an outcome.
-- Done stays completed_at. A new enum is created in this transaction: ALTER TYPE
-- ... ADD VALUE cannot be used until that transaction commits, and migrate()
-- runs every pending file in one transaction.
CREATE TYPE "task_status_new" AS ENUM ('open', 'done', 'cancelled');
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_outcome_chk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_completed_chk";
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "tasks"
  ALTER COLUMN "status" TYPE "task_status_new"
  USING "status"::text::"task_status_new";
--> statement-breakpoint
DROP TYPE "task_status";
--> statement-breakpoint
ALTER TYPE "task_status_new" RENAME TO "task_status";
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'open'::"task_status";
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancelled_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_outcome_chk" CHECK (
  "status" = 'open' OR ("outcome" IS NOT NULL AND length(btrim("outcome")) > 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_chk" CHECK (
  "status" <> 'done' OR "completed_at" IS NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cancelled_chk" CHECK (
  ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
);
