-- Short team keys (J, H, …) and a per-team task number.
-- A task's public key is team.key || '-' || tasks.number, for example J-142.
ALTER TABLE "teams" ADD COLUMN "key" text;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "next_task_number" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hearth_pick_team_key(team_name text, team_kind text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  words text[];
  word text;
  initials text := '';
  letters text := '';
  candidate text;
  extra int := 0;
BEGIN
  IF team_kind = 'personal' AND team_name ~* '^james\M' AND NOT EXISTS (SELECT 1 FROM teams WHERE key = 'J') THEN
    RETURN 'J';
  END IF;
  IF team_kind = 'household' AND team_name ~* 'harrison' AND NOT EXISTS (SELECT 1 FROM teams WHERE key = 'H') THEN
    RETURN 'H';
  END IF;

  words := ARRAY(
    SELECT w
    FROM regexp_split_to_table(upper(regexp_replace(team_name, '[^A-Za-z]+', ' ', 'g')), '\s+') AS w
    WHERE char_length(w) > 1
  );
  IF words IS NULL OR cardinality(words) = 0 THEN
    words := ARRAY['X'];
  END IF;
  FOREACH word IN ARRAY words LOOP
    initials := initials || substr(word, 1, 1);
    letters := letters || word;
  END LOOP;

  candidate := initials;
  WHILE EXISTS (SELECT 1 FROM teams WHERE key = candidate) LOOP
    IF char_length(candidate) < char_length(letters) THEN
      candidate := substr(letters, 1, char_length(candidate) + 1);
    ELSE
      extra := extra + 1;
      IF extra > 260 THEN
        RAISE EXCEPTION 'could not assign a team key';
      END IF;
      candidate := initials || repeat('A', (extra - 1) / 26) || chr(65 + ((extra - 1) % 26));
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hearth_assign_task_numbers() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY team_id ORDER BY created_at ASC, id ASC) AS n
    FROM tasks
  )
  UPDATE tasks AS t
  SET number = ranked.n
  FROM ranked
  WHERE t.id = ranked.id;

  UPDATE teams
  SET next_task_number = COALESCE((SELECT max(number) FROM tasks WHERE tasks.team_id = teams.id), 0);
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  rec record;
  assigned text;
BEGIN
  FOR rec IN
    SELECT id, name, kind::text AS kind
    FROM teams
    WHERE key IS NULL OR btrim(key) = ''
    ORDER BY
      CASE
        WHEN kind = 'personal' AND name ~* '^james\M' THEN 0
        WHEN kind = 'household' AND name ~* 'harrison' THEN 1
        ELSE 2
      END,
      created_at,
      id
  LOOP
    assigned := hearth_pick_team_key(rec.name, rec.kind);
    UPDATE teams SET key = assigned WHERE id = rec.id;
  END LOOP;
END $$;
--> statement-breakpoint
SELECT hearth_assign_task_numbers();
--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "key" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_key_unique" UNIQUE ("key");
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_key_letters" CHECK ("key" ~ '^[A-Z]+$');
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_number_unique" UNIQUE ("team_id", "number");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION teams_fill_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key IS NULL OR btrim(NEW.key) = '' THEN
    NEW.key := hearth_pick_team_key(NEW.name, NEW.kind::text);
  ELSE
    NEW.key := upper(btrim(NEW.key));
  END IF;
  IF NEW.next_task_number IS NULL THEN
    NEW.next_task_number := 0;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS teams_fill_key ON teams;
--> statement-breakpoint
CREATE TRIGGER teams_fill_key
  BEFORE INSERT ON teams
  FOR EACH ROW
  EXECUTE FUNCTION teams_fill_key();
