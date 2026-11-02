import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

const rootUrl = "postgres://hearth:hearth@127.0.0.1:5432/postgres";
const database = "hearth_migrate";
const databaseUrl = `postgres://hearth:hearth@127.0.0.1:5432/${database}`;

const teamA = "11111111-1111-4111-8111-111111111111";
const teamB = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";

let client: pg.Client;

before(async () => {
  await dropDatabase();
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${database} OWNER hearth`);
  await root.end();
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const dir = path.join(import.meta.dirname, "../drizzle");
  for (const file of ["0000_init.sql", "0001_action.sql", "0002_idempotency.sql", "0003_bots.sql", "0004_source.sql"]) {
    await runFile(path.join(dir, file));
  }
});

after(async () => {
  await client?.end();
  await dropDatabase();
});

async function dropDatabase() {
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  await root.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  await root.query(`DROP DATABASE IF EXISTS ${database}`);
  await root.end();
}

test("free-text project strings become projects, and area names are left unset", async () => {
  const longName = `${"Tara returns ".repeat(12)}end`;
  assert.ok(longName.length > 120);
  await client.query(
    `insert into teams (id, name, kind) values ($1, 'A', 'household'), ($2, 'B', 'personal')`,
    [teamA, teamB],
  );
  await client.query(
    `insert into tasks (team_id, title, owner_type, owner_id, created_by_type, created_by_id, action, project)
     values
       ($1, 'Real', 'user', $3, 'user', $3, 'later', 'Tara AU returns'),
       ($1, 'House task', 'user', $3, 'user', $3, 'later', 'House'),
       ($1, 'Finance task', 'user', $3, 'user', $3, 'later', ' finance '),
       ($1, 'Novus', 'user', $3, 'user', $3, 'later', 'Novus switch'),
       ($1, 'Novus lower', 'user', $3, 'user', $3, 'later', 'novus switch'),
       ($1, 'Kitchen', 'user', $3, 'user', $3, 'later', 'Kitchen'),
       ($1, 'Blank', 'user', $3, 'user', $3, 'later', '   '),
       ($1, 'Empty', 'user', $3, 'user', $3, 'later', null),
       ($1, 'Long', 'user', $3, 'user', $3, 'later', $4),
       ($2, 'Other team', 'user', $3, 'user', $3, 'later', 'Tara AU returns')`,
    [teamA, teamB, owner, longName],
  );

  await runFile(path.join(import.meta.dirname, "../drizzle/0005_projects.sql"));

  const columns = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'project'`,
  );
  assert.equal(columns.rowCount, 0);

  const projects = await client.query<{ team_id: string; name: string }>(
    `select team_id::text, name from projects order by team_id::text, lower(name)`,
  );
  const names = projects.rows.map((row) => `${row.team_id}:${row.name}`);
  assert.equal(names.filter((name) => name.endsWith(":Tara AU returns")).length, 2);
  assert.equal(names.filter((name) => name.toLowerCase().endsWith(":novus switch")).length, 1);
  assert.equal(
    projects.rows.some((row) => row.name.length === 120 && row.team_id === teamA),
    true,
  );
  assert.equal(
    projects.rows.some((row) => ["house", "finance", "kitchen"].includes(row.name.toLowerCase())),
    false,
  );

  const links = await client.query<{ title: string; project: string | null }>(
    `select t.title, p.name as project
     from tasks t
     left join projects p on p.id = t.project_id
     order by t.title`,
  );
  const byTitle = new Map(links.rows.map((row) => [row.title, row.project]));
  assert.equal(byTitle.get("Real"), "Tara AU returns");
  assert.equal(byTitle.get("Other team"), "Tara AU returns");
  assert.equal(byTitle.get("House task"), null);
  assert.equal(byTitle.get("Finance task"), null);
  assert.equal(byTitle.get("Kitchen"), null);
  assert.equal(byTitle.get("Blank"), null);
  assert.equal(byTitle.get("Empty"), null);
  assert.equal(byTitle.get("Novus")?.toLowerCase(), "novus switch");
  assert.equal(byTitle.get("Novus lower")?.toLowerCase(), "novus switch");
  assert.equal(byTitle.get("Novus"), byTitle.get("Novus lower"));
  assert.equal(byTitle.get("Long")?.length, 120);

  const areas = await client.query("select id from areas");
  assert.equal(areas.rowCount, 0);
  const areaIds = await client.query(`select count(*)::int as n from tasks where area_id is not null`);
  assert.equal(Number(areaIds.rows[0]?.n), 0);
});

async function runFile(file: string) {
  const parts = readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("--")));
  for (const statement of parts) {
    try {
      await client.query(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${path.basename(file)}: ${message}\n${statement.slice(0, 240)}`);
    }
  }
}
