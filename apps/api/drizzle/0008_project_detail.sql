-- A project sits in one area. Step order is a thin integer on the task.
-- Null sort_order stays at the end of its list. Archive still uses archived_at.
ALTER TABLE "projects" ADD COLUMN "area_id" uuid REFERENCES "areas"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "projects_area_id_idx" ON "projects" ("area_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sort_order" integer;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sort_order_chk" CHECK ("sort_order" IS NULL OR "sort_order" >= 0);
