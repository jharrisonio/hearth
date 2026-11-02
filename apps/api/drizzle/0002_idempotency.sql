-- Idempotency-Key on POST /tasks, scoped to the actor that created the task.
-- actor_id is a user or a bot, so it is not a foreign key.
CREATE TABLE "idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_type" "actor_type" NOT NULL,
  "actor_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "idempotency_keys_actor_key" UNIQUE ("actor_type", "actor_id", "idempotency_key"),
  CONSTRAINT "idempotency_keys_key_len" CHECK (char_length("idempotency_key") BETWEEN 1 AND 255)
);
