ALTER TABLE "tasks" ADD COLUMN "snoozed_until" timestamptz;
--> statement-breakpoint
CREATE INDEX "tasks_snoozed_until_idx" ON "tasks" ("snoozed_until");
