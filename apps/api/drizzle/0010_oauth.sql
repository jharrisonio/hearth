-- MCP OAuth clients, one-time install requests, grants, codes, and tokens.
-- An access token is scoped to the teams on its grant. The grant id is the bot owner, the same way a bot token id is.
CREATE TABLE "oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" text NOT NULL UNIQUE,
  "client_name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
  "source" text DEFAULT 'dcr' NOT NULL,
  "metadata_fetched_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_clients_name_len" CHECK (char_length(btrim("client_name")) BETWEEN 1 AND 120),
  CONSTRAINT "oauth_clients_source" CHECK ("source" IN ('dcr', 'cimd'))
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "state" text,
  "resource" text NOT NULL,
  "scope" text NOT NULL,
  "agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "oauth_client_id" uuid NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resource" text NOT NULL,
  "scope" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_grant_teams" (
  "grant_id" uuid NOT NULL REFERENCES "oauth_grants"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "oauth_grant_teams_pk" PRIMARY KEY ("grant_id", "team_id")
);
--> statement-breakpoint
CREATE INDEX "oauth_grant_teams_team_idx" ON "oauth_grant_teams" ("team_id");
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" text NOT NULL UNIQUE,
  "grant_id" uuid NOT NULL REFERENCES "oauth_grants"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "resource" text NOT NULL,
  "scope" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "oauth_grants"("id") ON DELETE CASCADE,
  "access_hash" text NOT NULL UNIQUE,
  "access_prefix" text NOT NULL,
  "refresh_hash" text UNIQUE,
  "resource" text NOT NULL,
  "scope" text NOT NULL,
  "access_expires_at" timestamptz NOT NULL,
  "refresh_expires_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" ("grant_id");
