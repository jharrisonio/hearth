CREATE TYPE "team_kind" AS ENUM ('personal', 'household');
--> statement-breakpoint
CREATE TYPE "membership_role" AS ENUM ('owner', 'member');
--> statement-breakpoint
CREATE TYPE "task_status" AS ENUM ('open', 'done');
--> statement-breakpoint
CREATE TYPE "task_lane" AS ENUM ('next', 'waiting', 'someday');
--> statement-breakpoint
CREATE TYPE "actor_type" AS ENUM ('user', 'bot');
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "google_sub" text UNIQUE,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" "team_kind" NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" "membership_role" NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "memberships_team_user" UNIQUE ("team_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" ("user_id");
--> statement-breakpoint
CREATE TABLE "bot_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "token_prefix" text NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "bot_tokens_team_idx" ON "bot_tokens" ("team_id");
--> statement-breakpoint
CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "detail" text,
  "status" "task_status" DEFAULT 'open' NOT NULL,
  "owner_type" "actor_type" NOT NULL,
  "owner_id" uuid NOT NULL,
  "important" boolean DEFAULT false NOT NULL,
  "urgent" boolean DEFAULT false NOT NULL,
  "lane" "task_lane" DEFAULT 'next' NOT NULL,
  "waiting_on" text,
  "project" text,
  "due_at" timestamptz,
  "outcome" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  "created_by_type" "actor_type" NOT NULL,
  "created_by_id" uuid NOT NULL,
  CONSTRAINT "tasks_waiting_on_chk" CHECK (
    "lane" <> 'waiting' OR ("waiting_on" IS NOT NULL AND length(btrim("waiting_on")) > 0)
  ),
  CONSTRAINT "tasks_outcome_chk" CHECK (
    "status" <> 'done' OR ("outcome" IS NOT NULL AND length(btrim("outcome")) > 0)
  ),
  CONSTRAINT "tasks_completed_chk" CHECK (
    "status" <> 'done' OR "completed_at" IS NOT NULL
  )
);
--> statement-breakpoint
CREATE INDEX "tasks_team_status_lane_idx" ON "tasks" ("team_id", "status", "lane");
