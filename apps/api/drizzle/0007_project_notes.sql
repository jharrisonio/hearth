-- Project notes hold the natural-planning sketch.
-- Steps stay tasks: active fronts are do_now, delegate, or schedule;
-- future or dependent steps are action later. Several fronts are allowed.
ALTER TABLE "projects" ADD COLUMN "notes" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_notes_len" CHECK ("notes" IS NULL OR char_length("notes") <= 5000);
