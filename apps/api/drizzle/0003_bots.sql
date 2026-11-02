-- Bot identity, separate from bot_tokens. agent_id is the external id (for example a Grok Bot agent id).
-- The row id is what tasks store as owner_id. No secret is minted.
CREATE TABLE "bots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "bots_team_agent" UNIQUE ("team_id", "agent_id"),
  CONSTRAINT "bots_agent_len" CHECK (char_length("agent_id") BETWEEN 1 AND 200),
  CONSTRAINT "bots_name_len" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80)
);
