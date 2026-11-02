import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://hearth:hearth@127.0.0.1:5432/hearth_test";
if (!/\/hearth_test(\?|$)/.test(databaseUrl)) {
  throw new Error("Refusing to run: DATABASE_URL must use the hearth_test database.");
}
process.env.DATABASE_URL = databaseUrl;
process.env.SESSION_SECRET ??= "test-session-secret-value";

const { createApp } = await import("./app.js");
const { db, pool, runMigrations } = await import("./db.js");
const { signSession } = await import("./actor.js");
const { areas, botTokens, bots, idempotencyKeys, memberships, projects, tasks, teams, users } = await import("./schema.js");
const { mintToken } = await import("./tokens.js");
const { and, eq } = await import("drizzle-orm");

const app = createApp();
const sessionSecret = process.env.SESSION_SECRET;

describe("task surface", { concurrency: 1 }, () => {
  before(async () => {
    await runMigrations();
    await runMigrations();
    const columns = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('idempotency_keys', 'bots')
       order by table_name, column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const column of ["actor_id", "actor_type", "idempotency_key", "request_hash", "task_id"]) {
      assert.ok(names.includes(column), `idempotency_keys.${column} missing`);
    }
    for (const column of ["agent_id", "name", "team_id"]) {
      assert.ok(names.includes(column), `bots.${column} missing`);
    }
    const catalog = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('tasks', 'projects', 'areas')`,
    );
    const has = (table: string, column: string) =>
      catalog.rows.some((row) => row.table_name === table && row.column_name === column);
    assert.equal(has("tasks", "project"), false);
    assert.equal(has("tasks", "project_id"), true);
    assert.equal(has("tasks", "area_id"), true);
    for (const column of ["id", "team_id", "name", "archived_at"]) {
      assert.equal(has("projects", column), true, `projects.${column}`);
      assert.equal(has("areas", column), true, `areas.${column}`);
    }
    assert.equal(has("projects", "notes"), true);
    assert.equal(has("projects", "area_id"), true);
    assert.equal(has("tasks", "sort_order"), true);
    assert.equal(has("areas", "notes"), false);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE users, teams, memberships, bot_tokens, bots, projects, areas, tasks, idempotency_keys RESTART IDENTITY CASCADE",
    );
  });

  after(async () => {
    await pool.end();
  });

  test("idempotent create replays, rejects a different body, and ignores key order", async () => {
    const fixture = await seed();
    const body = { teamId: fixture.team.id, title: "Buy oat milk", important: true, urgent: true };
    const first = await postTask(fixture.secret, body, "oat-milk-1");
    assert.equal(first.status, 201);
    assert.equal(first.replayed, null);
    const task = taskBody(first.json);

    const replay = await postTask(fixture.secret, body, "  oat-milk-1  ");
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, "true");
    assert.equal(taskBody(replay.json).id, task.id);

    const reordered = await postTask(
      fixture.secret,
      { urgent: true, title: "Buy oat milk", teamId: fixture.team.id, important: true },
      "oat-milk-1",
    );
    assert.equal(reordered.status, 200);
    assert.equal(taskBody(reordered.json).id, task.id);
    assert.equal(await countTasks(fixture.team.id), 1);

    const clash = await postTask(fixture.secret, { ...body, title: "Buy almond milk" }, "oat-milk-1");
    assert.equal(clash.status, 409);
    assert.equal(errorBody(clash.json).code, "idempotency_mismatch");
    assert.equal(await countTasks(fixture.team.id), 1);

    const userA = await postTask(fixture.secret, body, undefined, cookieFor(fixture.user.id));
    const userB = await postTask(fixture.secret, body, "oat-milk-1", cookieFor(fixture.user.id));
    assert.equal(userA.status, 201);
    assert.equal(userB.status, 201);
    assert.notEqual(taskBody(userA.json).id, taskBody(userB.json).id);
    assert.notEqual(taskBody(userB.json).id, task.id);

    const blank = await postTask(fixture.secret, body, "");
    assert.equal(blank.status, 400);
    assert.equal(errorBody(blank.json).code, "invalid_idempotency_key");
  });

  test("concurrent retries store one task", async () => {
    const fixture = await seed();
    const body = { teamId: fixture.team.id, title: "Take the bins out" };
    const results = await Promise.all(Array.from({ length: 8 }, () => postTask(fixture.secret, body, "bins")));
    assert.equal(await countTasks(fixture.team.id), 1);
    const ids = new Set(results.map((result) => taskBody(result.json).id));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.ok(results.every((result) => result.status === 200 || result.status === 201));
    const keys = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.actorId, fixture.tokenId));
    assert.equal(keys.length, 1);
  });

  test("a key can be reused after the window", async () => {
    const fixture = await seed();
    const body = { teamId: fixture.team.id, title: "First" };
    const created = await postTask(fixture.secret, body, "again");
    assert.equal(created.status, 201);
    await db
      .update(idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(idempotencyKeys.actorId, fixture.tokenId));
    const next = await postTask(fixture.secret, { ...body, title: "Second" }, "again");
    assert.equal(next.status, 201);
    assert.notEqual(taskBody(next.json).id, taskBody(created.json).id);
    assert.equal(await countTasks(fixture.team.id), 2);
  });

  test("registered bots are owners; unknown bots are rejected; tokens still work", async () => {
    const fixture = await seed();
    const registered = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/bots`, {
      agentId: "  grok-fin  ",
      name: "Fin",
    });
    assert.equal(registered.status, 201);
    const bot = botBody(registered.json);
    assert.equal(bot.agentId, "grok-fin");
    assert.equal(bot.name, "Fin");
    assert.equal("secret" in (registered.json as object), false);

    const again = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/bots`, {
      agentId: "grok-fin",
      name: "Fin",
    });
    assert.equal(again.status, 200);
    assert.equal(botBody(again.json).id, bot.id);

    const renamed = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/bots`, {
      agentId: "grok-fin",
      name: "Finley",
    });
    assert.equal(renamed.status, 200);
    assert.equal(botBody(renamed.json).id, bot.id);
    assert.equal(botBody(renamed.json).name, "Finley");

    const listed = await call(fixture.secret, "GET", `/teams/${fixture.team.id}/bots`);
    assert.equal(listed.status, 200);
    const botsJson = listed.json as { bots: { id: string; name: string }[] };
    assert.deepEqual(botsJson.bots.map((row) => row.id), [bot.id]);

    const owned = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Fin's list",
      owner: { type: "bot", id: bot.id },
    });
    assert.equal(owned.status, 201);
    assert.deepEqual(taskBody(owned.json).owner, { type: "bot", id: bot.id });

    const missing = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Nope",
      owner: { type: "bot", id: "00000000-0000-4000-8000-000000000099" },
    });
    assert.equal(missing.status, 400);
    assert.equal(errorBody(missing.json).code, "invalid_owner");

    const asToken = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Service owns this",
      owner: { type: "bot", id: fixture.tokenId },
    });
    assert.equal(asToken.status, 201);
    assert.equal(taskBody(asToken.json).owner.id, fixture.tokenId);

    const removed = await call(fixture.secret, "DELETE", `/teams/${fixture.team.id}/bots/${bot.id}`);
    assert.equal(removed.status, 200);
    const after = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "After unregister",
      owner: { type: "bot", id: bot.id },
    });
    assert.equal(after.status, 400);
    const empty = await call(fixture.secret, "GET", `/teams/${fixture.team.id}/bots`);
    assert.deepEqual((empty.json as { bots: unknown[] }).bots, []);
  });

  test("MCP tools register, create with idempotency, and call the task routes", async () => {
    const fixture = await seed();
    const anon = await rpc(null, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hearth-test", version: "0" },
    });
    assert.equal(anon.status, 401);

    const get = await app.request("/mcp", { method: "GET" });
    assert.equal(get.status, 405);

    const init = await rpc(fixture.secret, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hearth-test", version: "0" },
    });
    assert.equal(init.status, 200);
    const initResult = rpcResult(init.json) as { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } };
    assert.equal(initResult.serverInfo?.name, "hearth");
    assert.ok(initResult.capabilities?.tools);

    const listed = await rpc(fixture.secret, "tools/list");
    const listedTools = (rpcResult(listed.json) as { tools: { name: string; description?: string }[] }).tools;
    const tools = listedTools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, [
      "cancel_task",
      "complete_task",
      "create_area",
      "create_project",
      "create_task",
      "delete_task",
      "list_areas",
      "list_bots",
      "list_do_immediately",
      "list_projects",
      "list_tasks",
      "register_bot",
      "unregister_bot",
      "update_project",
      "update_task",
    ]);
    const description = (name: string) => listedTools.find((tool) => tool.name === name)?.description ?? "";
    assert.match(description("create_task"), /action later/);
    assert.match(description("update_task"), /later/);
    assert.match(description("list_tasks"), /projectId/);
    assert.match(description("list_do_immediately"), /later/);
    assert.match(description("create_project"), /notes/);
    assert.match(description("update_project"), /notes/);
    assert.match(description("list_projects"), /notes/);

    const registered = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "register_bot",
        arguments: { agentId: "grok-rally", name: "Rally" },
      }),
    ) as { id: string; name: string; agentId: string };
    assert.equal(registered.name, "Rally");
    assert.equal(registered.agentId, "grok-rally");

    const createArgs = {
      teamId: fixture.team.id,
      title: "Rally the morning",
      action: "do_now",
      important: true,
      urgent: true,
      owner: { type: "bot", id: registered.id },
      idempotencyKey: "rally-1",
    };
    const created = toolJson(await rpc(fixture.secret, "tools/call", { name: "create_task", arguments: createArgs })) as {
      id: string;
      owner: { id: string };
    };
    assert.equal(created.owner.id, registered.id);

    const replayed = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "create_task", arguments: createArgs }),
    ) as { id: string };
    assert.equal(replayed.id, created.id);
    assert.equal(await countTasks(fixture.team.id), 1);

    const restReplay = await postTask(fixture.secret, { ...createArgs, idempotencyKey: undefined }, "rally-1");
    assert.equal(restReplay.status, 200);
    assert.equal(taskBody(restReplay.json).id, created.id);

    const clash = await rpc(fixture.secret, "tools/call", {
      name: "create_task",
      arguments: { ...createArgs, title: "Different" },
    });
    const clashResult = rpcResult(clash.json) as { isError?: boolean; content?: { text: string }[] };
    assert.equal(clashResult.isError, true);
    assert.match(clashResult.content?.[0]?.text ?? "", /idempotency_mismatch/);

    const found = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "list_tasks",
        arguments: { action: "do_now", owner: `bot:${registered.id}` },
      }),
    ) as { tasks: { id: string }[] };
    assert.deepEqual(found.tasks.map((task) => task.id), [created.id]);

    const project = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "create_project",
        arguments: { name: "Tara AU returns", notes: "  Lodge, then confirm.  " },
      }),
    ) as { id: string; name: string; notes: string | null };
    assert.equal(project.name, "Tara AU returns");
    assert.equal(project.notes, "Lodge, then confirm.");
    const revised = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "update_project",
        arguments: { id: project.id, notes: "Lodge first" },
      }),
    ) as { id: string; notes: string | null };
    assert.equal(revised.id, project.id);
    assert.equal(revised.notes, "Lodge first");
    const sameProject = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "create_project",
        arguments: { name: "tara au returns" },
      }),
    ) as { id: string };
    assert.equal(sameProject.id, project.id);
    const area = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "create_area", arguments: { name: "Finance" } }),
    ) as { id: string; name: string };
    assert.equal(area.name, "Finance");
    const projectList = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "list_projects", arguments: {} }),
    ) as { projects: { id: string }[] };
    assert.deepEqual(projectList.projects.map((row) => row.id), [project.id]);

    const updated = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "update_task",
        arguments: { id: created.id, title: "Rally the morning list", projectId: project.id, areaId: area.id },
      }),
    ) as { title: string; project: { id: string; name: string } | null; area: { id: string; name: string } | null };
    assert.equal(updated.title, "Rally the morning list");
    assert.deepEqual(updated.project, { id: project.id, name: "Tara AU returns" });
    assert.deepEqual(updated.area, { id: area.id, name: "Finance" });

    const cleared = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "update_task",
        arguments: { id: created.id, projectId: null, areaId: null },
      }),
    ) as { project: null; area: null };
    assert.equal(cleared.project, null);
    assert.equal(cleared.area, null);

    const queue = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "list_do_immediately", arguments: {} }),
    ) as { tasks: { id: string }[] };
    assert.ok(queue.tasks.some((task) => task.id === created.id));

    const done = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "complete_task",
        arguments: { id: created.id, outcome: "Left on the table" },
      }),
    ) as { status: string; outcome: string };
    assert.equal(done.status, "done");
    assert.equal(done.outcome, "Left on the table");

    const botsListed = toolJson(await rpc(fixture.secret, "tools/call", { name: "list_bots", arguments: {} })) as {
      bots: { id: string }[];
    };
    assert.deepEqual(botsListed.bots.map((bot) => bot.id), [registered.id]);

    const removed = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "unregister_bot", arguments: { id: registered.id } }),
    ) as { id: string };
    assert.equal(removed.id, registered.id);
    const rows = await db.select().from(bots).where(and(eq(bots.teamId, fixture.team.id)));
    assert.equal(rows.length, 0);
  });

  test("source is stored, listed, streamed through MCP, and cleared", async () => {
    const fixture = await seed();
    const column = await pool.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'tasks' and column_name = 'source'`,
    );
    assert.equal(column.rows[0]?.data_type, "jsonb");

    const gmail = {
      type: "email" as const,
      href: "https://mail.google.com/mail/u/0/#all/18f2c4e8a1b2c3d4",
      label: "Re: boiler",
      externalId: "18f2c4e8a1b2c3d4",
    };
    const created = await postTask(
      fixture.secret,
      { teamId: fixture.team.id, title: "Book the boiler", action: "do_now", important: true, urgent: true, source: gmail },
      "boiler-1",
    );
    assert.equal(created.status, 201);
    assert.deepEqual(taskBody(created.json).source, gmail);

    const replayed = await postTask(
      fixture.secret,
      {
        teamId: fixture.team.id,
        title: "Book the boiler",
        action: "do_now",
        important: true,
        urgent: true,
        source: { externalId: gmail.externalId, href: `  ${gmail.href}  `, type: "email", label: "  Re: boiler  " },
      },
      "boiler-1",
    );
    assert.equal(replayed.status, 200);
    assert.equal(taskBody(replayed.json).id, taskBody(created.json).id);

    const plain = await postTask(fixture.secret, { teamId: fixture.team.id, title: "No link" });
    assert.equal(plain.status, 201);
    assert.equal(taskBody(plain.json).source, null);

    const listed = await call(fixture.secret, "GET", `/tasks?teamId=${fixture.team.id}`);
    assert.equal(listed.status, 200);
    const listedTasks = (listed.json as { tasks: { id: string; source: unknown }[] }).tasks;
    assert.deepEqual(
      listedTasks.find((task) => task.id === taskBody(created.json).id)?.source,
      gmail,
    );

    const queue = await call(fixture.secret, "GET", "/tasks/do-immediately");
    const queued = (queue.json as { tasks: { id: string; source: unknown }[] }).tasks.find(
      (task) => task.id === taskBody(created.json).id,
    );
    assert.deepEqual(queued?.source, gmail);

    const kept = await call(fixture.secret, "PATCH", `/tasks/${taskBody(created.json).id}`, { title: "Book the boiler service" });
    assert.equal(kept.status, 200);
    assert.deepEqual(taskBody(kept.json).source, gmail);

    const page = {
      type: "url" as const,
      href: "https://example.com/manuals/boiler",
      label: "Manual",
    };
    const replaced = await call(fixture.secret, "PATCH", `/tasks/${taskBody(created.json).id}`, { source: page });
    assert.equal(replaced.status, 200);
    assert.deepEqual(taskBody(replaced.json).source, page);

    const cleared = await call(fixture.secret, "PATCH", `/tasks/${taskBody(created.json).id}`, { source: null });
    assert.equal(cleared.status, 200);
    assert.equal(taskBody(cleared.json).source, null);

    const script = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Nope",
      source: { type: "url", href: "javascript:alert(1)" },
    });
    assert.equal(script.status, 400);
    assert.equal(errorBody(script.json).code, "invalid_body");

    const extra = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Nope",
      source: { type: "email", href: gmail.href, note: "nope" },
    });
    assert.equal(extra.status, 400);

    const text = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Nope",
      source: gmail.href,
    });
    assert.equal(text.status, 400);

    await assert.rejects(
      pool.query(`update tasks set source = '"just a string"'::jsonb where id = $1`, [taskBody(created.json).id]),
    );

    const init = await rpc(fixture.secret, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hearth-test", version: "0" },
    });
    assert.equal(init.status, 200);
    const tools = await rpc(fixture.secret, "tools/list");
    const createTool = (rpcResult(tools.json) as { tools: { name: string; inputSchema?: unknown }[] }).tools.find(
      (tool) => tool.name === "create_task",
    );
    const updateTool = (rpcResult(tools.json) as { tools: { name: string; inputSchema?: unknown }[] }).tools.find(
      (tool) => tool.name === "update_task",
    );
    assert.match(JSON.stringify(createTool?.inputSchema), /"source"/);
    assert.match(JSON.stringify(updateTool?.inputSchema), /"source"/);

    const viaMcp = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "create_task",
        arguments: {
          teamId: fixture.team.id,
          title: "From the inbox",
          source: gmail,
        },
      }),
    ) as { id: string; source: typeof gmail };
    assert.deepEqual(viaMcp.source, gmail);

    const found = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "list_tasks",
        arguments: { teamId: fixture.team.id },
      }),
    ) as { tasks: { id: string; source: unknown }[] };
    assert.deepEqual(found.tasks.find((task) => task.id === viaMcp.id)?.source, gmail);

    const edited = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "update_task",
        arguments: { id: viaMcp.id, source: { type: "url", href: "https://example.com/parts" } },
      }),
    ) as { source: { type: string; href: string } };
    assert.deepEqual(edited.source, { type: "url", href: "https://example.com/parts" });

    const removed = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "update_task",
        arguments: { id: viaMcp.id, source: null },
      }),
    ) as { source: null };
    assert.equal(removed.source, null);
  });

  test("projects and areas link, filter, archive, and stay on the team", async () => {
    const fixture = await seed();
    const created = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/projects`, { name: "  Novus switch  " });
    assert.equal(created.status, 201);
    const project = namedBody(created.json);
    assert.equal(project.name, "Novus switch");
    assert.equal(project.notes, null);
    assert.equal((created.json as { area: unknown }).area, null);
    const again = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/projects`, { name: "novus switch" });
    assert.equal(again.status, 200);
    assert.equal(namedBody(again.json).id, project.id);
    assert.equal(namedBody(again.json).name, "Novus switch");
    assert.equal(namedBody(again.json).notes, null);

    const areaResponse = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/areas`, { name: "House" });
    assert.equal(areaResponse.status, 201);
    const area = namedBody(areaResponse.json);
    assert.equal("notes" in (areaResponse.json as object), false);
    assert.equal("area" in (areaResponse.json as object), false);
    const areaNotes = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/areas`, { name: "Garden", notes: "nope" });
    assert.equal(areaNotes.status, 400);
    const clash = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      name: "Novus switch",
    });
    assert.equal(clash.status, 200);

    const [otherTeam] = await db.insert(teams).values({ name: "Elsewhere", kind: "household" }).returning();
    assert.ok(otherTeam);
    const [otherProject] = await db.insert(projects).values({ teamId: otherTeam.id, name: "Novus switch" }).returning();
    assert.ok(otherProject);
    const foreign = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Wrong team",
      projectId: otherProject.id,
    });
    assert.equal(foreign.status, 400);
    assert.equal(errorBody(foreign.json).code, "invalid_project");

    const noted = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      notes: "  Call the bank, then close.  ",
    });
    assert.equal(noted.status, 200);
    assert.equal(namedBody(noted.json).notes, "Call the bank, then close.");
    const keptNotes = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/projects`, { name: "novus switch" });
    assert.equal(keptNotes.status, 200);
    assert.equal(namedBody(keptNotes.json).notes, "Call the bank, then close.");
    const replacedNotes = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/projects`, {
      name: "novus switch",
      notes: "Close the account",
    });
    assert.equal(replacedNotes.status, 200);
    assert.equal(namedBody(replacedNotes.json).name, "Novus switch");
    assert.equal(namedBody(replacedNotes.json).notes, "Close the account");

    const task = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Switch the account",
      projectId: project.id,
      areaId: area.id,
    });
    assert.equal(task.status, 201);
    const body = taskBody(task.json);
    assert.equal(body.action, "later");
    assert.deepEqual(body.project, { id: project.id, name: "Novus switch" });
    assert.deepEqual(body.area, { id: area.id, name: "House" });

    const front = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Email the accountant",
      action: "do_now",
      important: true,
      urgent: true,
      projectId: project.id,
    });
    const secondFront = await postTask(fixture.secret, {
      teamId: fixture.team.id,
      title: "Download the statements",
      action: "do_now",
      important: true,
      urgent: true,
      projectId: project.id,
    });
    assert.equal(front.status, 201);
    assert.equal(secondFront.status, 201);
    const queue = await call(fixture.secret, "GET", `/tasks/do-immediately?teamId=${fixture.team.id}`);
    const queuedIds = new Set((queue.json as { tasks: { id: string; action: string }[] }).tasks.map((row) => row.id));
    assert.equal(queuedIds.has(taskBody(front.json).id), true);
    assert.equal(queuedIds.has(taskBody(secondFront.json).id), true);
    assert.equal(queuedIds.has(body.id), false);

    const listed = await call(
      fixture.secret,
      "GET",
      `/tasks?teamId=${fixture.team.id}&projectId=${project.id}&areaId=${area.id}`,
    );
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.json as { tasks: { id: string }[] }).tasks.map((row) => row.id), [body.id]);

    const ordered = await call(fixture.secret, "PATCH", `/tasks/${body.id}`, { sortOrder: 3 });
    assert.equal(ordered.status, 200);
    assert.equal((ordered.json as { sortOrder: number | null }).sortOrder, 3);
    const negative = await call(fixture.secret, "PATCH", `/tasks/${body.id}`, { sortOrder: -1 });
    assert.equal(negative.status, 400);

    const withArea = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      areaId: area.id,
    });
    assert.equal(withArea.status, 200);
    assert.deepEqual((withArea.json as { area: { id: string; name: string } | null }).area, {
      id: area.id,
      name: "House",
    });
    const badArea = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      areaId: "00000000-0000-4000-8000-000000000099",
    });
    assert.equal(badArea.status, 400);
    assert.equal(errorBody(badArea.json).code, "invalid_area");
    const clearedArea = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      areaId: null,
    });
    assert.equal(clearedArea.status, 200);
    assert.equal((clearedArea.json as { area: unknown }).area, null);

    const oldFilter = await call(fixture.secret, "GET", "/tasks?project=Novus%20switch");
    assert.equal(oldFilter.status, 400);
    assert.equal(errorBody(oldFilter.json).code, "invalid_query");

    const blockedArchive = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      archived: true,
    });
    assert.equal(blockedArchive.status, 409);
    assert.equal(errorBody(blockedArchive.json).code, "project_open_tasks");
    const stillOpen = await call(fixture.secret, "GET", `/teams/${fixture.team.id}/projects`);
    assert.equal(
      (stillOpen.json as { projects: { id: string; archivedAt: string | null }[] }).projects.some(
        (row) => row.id === project.id && row.archivedAt === null,
      ),
      true,
    );
    for (const id of [body.id, taskBody(front.json).id, taskBody(secondFront.json).id]) {
      const dropped = await call(fixture.secret, "POST", `/tasks/${id}/cancel`, {});
      assert.equal(dropped.status, 200);
    }

    const archived = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      archived: true,
    });
    assert.equal(archived.status, 200);
    assert.equal(typeof namedBody(archived.json).archivedAt, "string");
    const active = await call(fixture.secret, "GET", `/teams/${fixture.team.id}/projects`);
    assert.deepEqual((active.json as { projects: unknown[] }).projects, []);
    const withArchived = await call(fixture.secret, "GET", `/teams/${fixture.team.id}/projects?includeArchived=true`);
    assert.equal((withArchived.json as { projects: { id: string }[] }).projects[0]?.id, project.id);
    const still = await call(fixture.secret, "GET", `/tasks?teamId=${fixture.team.id}&projectId=${project.id}`);
    assert.equal((still.json as { tasks: { project: { name: string } | null }[] }).tasks[0]?.project?.name, "Novus switch");

    const restored = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/projects`, { name: "Novus switch" });
    assert.equal(restored.status, 200);
    assert.equal(namedBody(restored.json).archivedAt, null);
    assert.equal(namedBody(restored.json).id, project.id);
    assert.equal(namedBody(restored.json).notes, "Close the account");

    const [second] = await db.insert(projects).values({ teamId: fixture.team.id, name: "Tara AU returns" }).returning();
    assert.ok(second);
    const rename = await call(fixture.secret, "PATCH", `/teams/${fixture.team.id}/projects/${project.id}`, {
      name: "Tara AU returns",
    });
    assert.equal(rename.status, 409);
    assert.equal(errorBody(rename.json).code, "conflict");

    const cleared = await call(fixture.secret, "PATCH", `/tasks/${body.id}`, { projectId: null, areaId: null });
    assert.equal(cleared.status, 200);
    assert.equal(taskBody(cleared.json).project, null);
    assert.equal(taskBody(cleared.json).area, null);

    const missing = await call(fixture.secret, "PATCH", `/tasks/${body.id}`, {
      areaId: "00000000-0000-4000-8000-000000000099",
    });
    assert.equal(missing.status, 400);
    assert.equal(errorBody(missing.json).code, "invalid_area");
    assert.equal((await db.select().from(areas)).length >= 1, true);
  });

  test("cancel keeps an audit row and delete removes the task", async () => {
    const fixture = await seed();
    const other = await seed();
    const created = await postTask(
      fixture.secret,
      { teamId: fixture.team.id, title: "Buy oat milk", action: "do_now", important: true, urgent: true },
      "oat-1",
    );
    assert.equal(created.status, 201);
    const task = taskBody(created.json);

    const blocked = await call(fixture.secret, "PATCH", `/tasks/${task.id}`, { cancelledAt: new Date().toISOString() });
    assert.equal(blocked.status, 400);
    assert.equal(errorBody(blocked.json).code, "field_immutable");

    const deniedCancel = await call(other.secret, "POST", `/tasks/${task.id}/cancel`, {});
    assert.equal(deniedCancel.status, 403);
    const deniedDelete = await call(other.secret, "DELETE", `/tasks/${task.id}`);
    assert.equal(deniedDelete.status, 403);

    const blank = await call(fixture.secret, "POST", `/tasks/${task.id}/cancel`, { outcome: "   " });
    assert.equal(blank.status, 400);
    assert.equal(errorBody(blank.json).code, "invalid_body");

    const dropped = await call(fixture.secret, "POST", `/tasks/${task.id}/cancel`, {});
    assert.equal(dropped.status, 200);
    const cancelled = dropped.json as {
      id: string;
      status: string;
      outcome: string | null;
      cancelledAt: string | null;
      completedAt: string | null;
      updatedAt: string;
    };
    assert.equal(cancelled.id, task.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(typeof cancelled.cancelledAt, "string");
    assert.equal(cancelled.completedAt, null);
    assert.equal(cancelled.cancelledAt, cancelled.updatedAt);

    const open = await call(fixture.secret, "GET", `/tasks?teamId=${fixture.team.id}&status=open`);
    assert.equal(open.status, 200);
    assert.equal((open.json as { tasks: { id: string }[] }).tasks.some((row) => row.id === task.id), false);
    const queue = await call(fixture.secret, "GET", `/tasks/do-immediately?teamId=${fixture.team.id}`);
    assert.equal((queue.json as { tasks: { id: string }[] }).tasks.some((row) => row.id === task.id), false);
    const audit = await call(fixture.secret, "GET", `/tasks?teamId=${fixture.team.id}&status=cancelled`);
    assert.deepEqual(
      (audit.json as { tasks: { id: string }[] }).tasks.map((row) => row.id),
      [task.id],
    );
    const all = await call(fixture.secret, "GET", `/tasks?teamId=${fixture.team.id}`);
    assert.equal((all.json as { tasks: { id: string }[] }).tasks.some((row) => row.id === task.id), true);

    const twice = await call(fixture.secret, "POST", `/tasks/${task.id}/cancel`, { outcome: "again" });
    assert.equal(twice.status, 409);
    assert.equal(errorBody(twice.json).code, "already_cancelled");
    const completeCancelled = await call(fixture.secret, "POST", `/tasks/${task.id}/complete`, { outcome: "nope" });
    assert.equal(completeCancelled.status, 409);
    assert.equal(errorBody(completeCancelled.json).code, "already_cancelled");

    const finished = await postTask(fixture.secret, { teamId: fixture.team.id, title: "Done already" });
    const finishedId = taskBody(finished.json).id;
    const done = await call(fixture.secret, "POST", `/tasks/${finishedId}/complete`, { outcome: "Filed" });
    assert.equal(done.status, 200);
    const cancelDone = await call(fixture.secret, "POST", `/tasks/${finishedId}/cancel`, {});
    assert.equal(cancelDone.status, 409);
    assert.equal(errorBody(cancelDone.json).code, "already_done");

    const noted = await postTask(fixture.secret, { teamId: fixture.team.id, title: "Wrong list", action: "do_now" });
    const notedId = taskBody(noted.json).id;
    const withReason = toolJson(
      await rpc(fixture.secret, "tools/call", {
        name: "cancel_task",
        arguments: { id: notedId, outcome: "duplicate of the bins" },
      }),
    ) as { status: string; outcome: string; cancelledAt: string | null; completedAt: string | null };
    assert.equal(withReason.status, "cancelled");
    assert.equal(withReason.outcome, "duplicate of the bins");
    assert.equal(withReason.completedAt, null);
    assert.equal(typeof withReason.cancelledAt, "string");
    const queueAfter = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "list_do_immediately", arguments: { teamId: fixture.team.id } }),
    ) as { tasks: { id: string }[] };
    assert.equal(queueAfter.tasks.some((row) => row.id === notedId), false);

    const duplicate = await postTask(fixture.secret, { teamId: fixture.team.id, title: "Accidental" }, "accidental-1");
    const duplicateId = taskBody(duplicate.json).id;
    assert.equal((await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.taskId, duplicateId))).length, 1);
    const removed = toolJson(
      await rpc(fixture.secret, "tools/call", { name: "delete_task", arguments: { id: duplicateId } }),
    ) as { id: string; deleted: boolean };
    assert.deepEqual(removed, { id: duplicateId, deleted: true });
    assert.equal(await countTasks(fixture.team.id), 3);
    assert.equal((await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.taskId, duplicateId))).length, 0);
    const reused = await postTask(fixture.secret, { teamId: fixture.team.id, title: "Accidental again" }, "accidental-1");
    assert.equal(reused.status, 201);
    assert.notEqual(taskBody(reused.json).id, duplicateId);

    const gone = await call(fixture.secret, "DELETE", `/tasks/${duplicateId}`);
    assert.equal(gone.status, 404);
    assert.equal(errorBody(gone.json).code, "not_found");
    const missing = await call(fixture.secret, "DELETE", `/tasks/${crypto.randomUUID()}`);
    assert.equal(missing.status, 404);
    const badId = await call(fixture.secret, "DELETE", "/tasks/not-a-uuid");
    assert.equal(badId.status, 400);

    const removedDone = await call(fixture.secret, "DELETE", `/tasks/${finishedId}`);
    assert.equal(removedDone.status, 200);
    assert.deepEqual(removedDone.json, { id: finishedId, deleted: true });
    const doneList = await call(fixture.secret, "GET", `/tasks?teamId=${fixture.team.id}&status=done`);
    assert.equal((doneList.json as { tasks: { id: string }[] }).tasks.some((row) => row.id === finishedId), false);
  });
});

async function seed() {
  const [user] = await db.insert(users).values({ email: `james-${crypto.randomUUID()}@example.com`, name: "James" }).returning();
  const [team] = await db.insert(teams).values({ name: "Harrison", kind: "household" }).returning();
  if (!user || !team) throw new Error("seed failed");
  await db.insert(memberships).values({ teamId: team.id, userId: user.id, role: "owner" });
  const minted = mintToken();
  const [token] = await db
    .insert(botTokens)
    .values({
      teamId: team.id,
      label: "service",
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      createdByUserId: user.id,
    })
    .returning();
  if (!token) throw new Error("token seed failed");
  return { user, team, secret: minted.secret, tokenId: token.id };
}

function cookieFor(userId: string) {
  return `hearth_session=${signSession(userId, sessionSecret, 3600)}`;
}

async function postTask(token: string | null, body: Record<string, unknown>, key?: string, cookie?: string) {
  const payload = { ...body };
  delete payload.idempotencyKey;
  return call(cookie ? null : token, "POST", "/tasks", payload, key, cookie);
}

async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  key?: string,
  cookie?: string,
) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (cookie) headers.set("cookie", cookie);
  if (key !== undefined) headers.set("idempotency-key", key);
  const response = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
    replayed: response.headers.get("idempotent-replayed"),
  };
}

async function rpc(token: string | null, method: string, params?: unknown) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (method !== "initialize") headers.set("mcp-protocol-version", "2025-03-26");
  const response = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
}

function rpcResult(json: unknown) {
  const result = (json as { result?: unknown }).result;
  assert.ok(result, `missing MCP result: ${JSON.stringify(json)}`);
  return result;
}

function toolJson(response: { json: unknown }) {
  const result = rpcResult(response.json) as { isError?: boolean; content?: { text?: string }[] };
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const text = result.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text ?? "") as unknown;
}

function taskBody(json: unknown) {
  const task = json as {
    id: string;
    owner: { type: string; id: string };
    title: string;
    action: string;
    source: unknown;
    project: { id: string; name: string } | null;
    area: { id: string; name: string } | null;
  };
  assert.equal(typeof task.id, "string");
  assert.ok("source" in task, "task includes source");
  return task;
}

function namedBody(json: unknown) {
  const row = json as { id: string; name: string; archivedAt: string | null; notes?: string | null };
  assert.equal(typeof row.id, "string");
  assert.equal(typeof row.name, "string");
  return row;
}

function botBody(json: unknown) {
  const bot = json as { id: string; agentId: string; name: string };
  assert.equal(typeof bot.id, "string");
  return bot;
}

function errorBody(json: unknown) {
  const error = (json as { error?: { code?: string; message?: string } }).error;
  assert.ok(error?.code, JSON.stringify(json));
  return error;
}

async function countTasks(teamId: string) {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.teamId, teamId));
  return rows.length;
}
