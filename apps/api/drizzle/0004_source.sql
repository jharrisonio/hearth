-- One optional link back to the email or page a task came from.
-- Shape: { "type": "email" | "url", "href": "https://…", "label"?: "…", "externalId"?: "…" }
ALTER TABLE "tasks" ADD COLUMN "source" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_chk" CHECK (
  "source" IS NULL
  OR (
    jsonb_typeof("source") = 'object'
    AND "source"->>'type' IN ('email', 'url')
    AND "source"->>'href' ~ '^https?://[^[:space:]]+$'
    AND char_length("source"->>'href') <= 2048
    AND (
      NOT ("source" ? 'label')
      OR (
        jsonb_typeof("source"->'label') = 'string'
        AND char_length(btrim("source"->>'label')) BETWEEN 1 AND 200
      )
    )
    AND (
      NOT ("source" ? 'externalId')
      OR (
        jsonb_typeof("source"->'externalId') = 'string'
        AND char_length(btrim("source"->>'externalId')) BETWEEN 1 AND 512
      )
    )
    AND ("source" - 'type' - 'href' - 'label' - 'externalId') = '{}'::jsonb
  )
);
