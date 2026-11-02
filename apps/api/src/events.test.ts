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
const { closeTaskEvents, handleRemoteNotification, taskEventOrigin } = await import("./events.js");
const { botTokens, memberships, teams, users } = await import("./schema.js");
const { mintToken } = await import("./tokens.js");
const { and, eq } = await import("drizzle-orm");

const app = createApp();
const sessionSecret = process.env.SESSION_SECRET;

describe("task events", { concurrency: 1 }, () => {
  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE users, teams, memberships, bot_tokens, bots, projects, areas, tasks, idempotency_keys, oauth_clients, oauth_requests, oauth_grants, oauth_grant_teams, oauth_codes, oauth_tokens RESTART IDENTITY CASCADE",
    );
  });

  after(async () => {
    await closeTaskEvents();
    await pool.end();
  });

  test("auth stops a stream the actor cannot open", async () => {
    const fixture = await seed();
    const other = await seed();
    const stranger = await db
      .insert(users)
      .values({ email: `stranger-${crypto.randomUUID()}@example.com`, name: "Stranger" })
      .returning();
    const strangerId = stranger[0]?.id;
    assert.ok(strangerId);

    const anon = await openEvents(null, fixture.team.id);
    assert.equal(anon.status, 401);
    assert.equal(errorCode(anon.json), "unauthorized");

    const badId = await openEvents(fixture.secret, "not-a-uuid");
    assert.equal(badId.status, 400);

    const missing = await openEvents(fixture.secret, crypto.randomUUID());
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing.json), "not_found");

    const crossed = await openEvents(fixture.secret, other.team.id);
    assert.equal(crossed.status, 403);
    assert.equal(errorCode(crossed.json), "forbidden");

    const outsider = await openEvents(null, fixture.team.id, cookieFor(strangerId));
    assert.equal(outsider.status, 403);
    assert.equal(errorCode(outsider.json), "forbidden");
  });

  test("subscribers on one team see the write, and another team does not", async () => {
    const home = await seed();
    const away = await seed();
    const missed = await postTask(home.secret, { teamId: home.team.id, title: "Already there" });
    assert.equal(missed.status, 201);
    const missedId = taskBody(missed.json).id;
    const bot = await openEvents(home.secret, home.team.id);
    const human = await openEvents(null, home.team.id, cookieFor(home.user.id));
    const other = await openEvents(away.secret, away.team.id);
    try {
      assert.equal(bot.status, 200);
      assert.match(bot.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.match(bot.headers.get("cache-control") ?? "", /no-cache/);
      assert.equal(bot.headers.get("x-accel-buffering"), "no");
      await bot.readUntil((text) => text.includes("event: ready"));
      await human.readUntil((text) => text.includes("event: ready"));
      await other.readUntil((text) => text.includes("event: ready"));
      assert.equal(taskEvents(bot.text()).length, 0);

      const created = await postTask(null, { teamId: home.team.id, title: "Buy oat milk" }, undefined, cookieFor(home.user.id));
      assert.equal(created.status, 201);
      const task = taskBody(created.json);
      const awayTask = await postTask(away.secret, { teamId: away.team.id, title: "Away only" });
      assert.equal(awayTask.status, 201);

      await bot.readUntil((text) => taskEvents(text).some((event) => event.taskId === task.id));
      await human.readUntil((text) => taskEvents(text).some((event) => event.taskId === task.id));
      await other.readUntil((text) => taskEvents(text).some((event) => event.taskId === taskBody(awayTask.json).id));

      for (const stream of [bot, human]) {
        const events = taskEvents(stream.text());
        const match = events.find((event) => event.taskId === task.id);
      assert.ok(match);
      assert.ok(match.task);
      assert.equal(match.type, "created");
      assert.equal(match.teamId, home.team.id);
      assert.equal(match.at, match.task.updatedAt);
      assert.equal(match.task.title, "Buy oat milk");
      assert.equal(match.task.id, task.id);
        assert.ok(stream.text().includes(`id: ${task.id}@${match.at}`));
        assert.equal(events.some((event) => event.taskId === taskBody(awayTask.json).id), false);
        assert.equal(events.some((event) => event.taskId === missedId), false);
      }
      assert.equal(taskEvents(other.text()).some((event) => event.taskId === task.id), false);
      assert.match(bot.text(), /retry: 3000/);
    } finally {
      await bot.stop();
      await human.stop();
      await other.stop();
    }
  });

  test("create, replay, update, and complete emit one event each", async () => {
    const fixture = await seed();
    const stream = await openEvents(fixture.secret, fixture.team.id);
    try {
      await stream.readUntil((text) => text.includes("event: ready"));
      const created = await postTask(
        fixture.secret,
        { teamId: fixture.team.id, title: "Bins", source: gmailSource },
        "bins-1",
      );
      assert.equal(created.status, 201);
      const id = taskBody(created.json).id;
      await stream.readUntil((text) => taskEvents(text).some((event) => event.taskId === id && event.type === "created"));
      const createdEvent = taskEvents(stream.text()).find((event) => event.taskId === id && event.type === "created");
      assert.ok(createdEvent?.task);
      assert.deepEqual(createdEvent.task.source, gmailSource);
      assert.equal(createdEvent.task.project, null);
      assert.equal(createdEvent.task.area, null);

      const replay = await postTask(
        fixture.secret,
        { teamId: fixture.team.id, title: "Bins", source: gmailSource },
        "bins-1",
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.replayed, "true");
      await idle(150);
      assert.equal(taskEvents(stream.text()).filter((event) => event.taskId === id).length, 1);

      const project = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/projects`, { name: "Novus switch" });
      const area = await call(fixture.secret, "POST", `/teams/${fixture.team.id}/areas`, { name: "House" });
      assert.equal(project.status, 201);
      assert.equal(area.status, 201);
      const projectId = (project.json as { id: string }).id;
      const areaId = (area.json as { id: string }).id;
      const patched = await call(fixture.secret, "PATCH", `/tasks/${id}`, {
        title: "Bins tonight",
        projectId,
        areaId,
      });
      assert.equal(patched.status, 200);
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "updated" && event.task?.title === "Bins tonight"));
      const updated = taskEvents(stream.text()).find((event) => event.type === "updated");
      assert.ok(updated?.task);
      assert.deepEqual(updated.task.source, gmailSource);
      assert.deepEqual(updated.task.project, { id: projectId, name: "Novus switch" });
      assert.deepEqual(updated.task.area, { id: areaId, name: "House" });

      const done = await call(fixture.secret, "POST", `/tasks/${id}/complete`, { outcome: "Out front" });
      assert.equal(done.status, 200);
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "completed"));
      const completed = taskEvents(stream.text()).find((event) => event.type === "completed");
      assert.ok(completed?.task);
      assert.equal(completed.task.status, "done");
      assert.equal(completed.task.outcome, "Out front");
      assert.deepEqual(completed.task.source, gmailSource);
      assert.equal(completed.at, completed.task.updatedAt);

      const again = await call(fixture.secret, "POST", `/tasks/${id}/complete`, { outcome: "Again" });
      assert.equal(again.status, 409);
      await idle(150);
      assert.deepEqual(
        taskEvents(stream.text()).map((event) => event.type),
        ["created", "updated", "completed"],
      );
    } finally {
      await stream.stop();
    }
  });

  test("another process is fanned in, and this process ignores its own notice", async () => {
    const fixture = await seed();
    const other = await seed();
    const stream = await openEvents(fixture.secret, fixture.team.id);
    try {
      await stream.readUntil((text) => text.includes("event: ready"));
      const created = await postTask(fixture.secret, { teamId: fixture.team.id, title: "Shared" });
      const task = taskBody(created.json);
      await stream.readUntil((text) => taskEvents(text).length === 1);
      await idle(200);
      assert.equal(taskEvents(stream.text()).length, 1);

      await handleRemoteNotification(
        JSON.stringify({
          origin: taskEventOrigin,
          type: "completed",
          teamId: fixture.team.id,
          taskId: task.id,
          at: task.updatedAt,
        }),
      );
      const away = await postTask(other.secret, { teamId: other.team.id, title: "Not ours" });
      await handleRemoteNotification(
        JSON.stringify({
          origin: "other-process",
          type: "updated",
          teamId: other.team.id,
          taskId: taskBody(away.json).id,
          at: taskBody(away.json).updatedAt,
        }),
      );
      await handleRemoteNotification(
        JSON.stringify({
          origin: "other-process",
          type: "updated",
          teamId: fixture.team.id,
          taskId: task.id,
          at: task.updatedAt,
        }),
      );
      await handleRemoteNotification("not-json");
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "updated"));
      await idle(150);
      const events = taskEvents(stream.text());
      assert.deepEqual(
        events.map((event) => event.type),
        ["created", "updated"],
      );
      assert.equal(events[1]?.taskId, task.id);
      assert.equal(events[1]?.task?.title, "Shared");
      assert.equal(events.some((event) => event.taskId === taskBody(away.json).id), false);
    } finally {
      await stream.stop();
    }
  });

  test("a revoked token or a removed member is dropped on the next keepalive", async () => {
    const previous = process.env.SSE_HEARTBEAT_MS;
    process.env.SSE_HEARTBEAT_MS = "300";
    const fixture = await seed();
    const [member] = await db
      .insert(users)
      .values({ email: `member-${crypto.randomUUID()}@example.com`, name: "Member" })
      .returning();
    assert.ok(member);
    await db.insert(memberships).values({ teamId: fixture.team.id, userId: member.id, role: "member" });
    const bot = await openEvents(fixture.secret, fixture.team.id);
    const human = await openEvents(null, fixture.team.id, cookieFor(member.id));
    try {
      await bot.readUntil((text) => text.includes("event: ready"));
      await human.readUntil((text) => text.includes("event: ready"));
      await db.update(botTokens).set({ revokedAt: new Date() }).where(eq(botTokens.id, fixture.tokenId));
      await db
        .delete(memberships)
        .where(and(eq(memberships.teamId, fixture.team.id), eq(memberships.userId, member.id)));
      await bot.readUntil((text) => text.includes('"reason":"access_ended"'), 3000);
      await human.readUntil((text) => text.includes('"reason":"access_ended"'), 3000);
      const next = await openEvents(fixture.secret, fixture.team.id);
      assert.equal(next.status, 401);
    } finally {
      if (previous === undefined) delete process.env.SSE_HEARTBEAT_MS;
      else process.env.SSE_HEARTBEAT_MS = previous;
      await bot.stop();
      await human.stop();
    }
  });

  test("the server ends the stream before the platform idle cap", async () => {
    const previous = process.env.SSE_MAX_MS;
    process.env.SSE_MAX_MS = "400";
    const fixture = await seed();
    const stream = await openEvents(fixture.secret, fixture.team.id);
    try {
      await stream.readUntil((text) => text.includes("event: reconnect"), 3000);
      const reconnect = parseEvents(stream.text()).find((event) => event.event === "reconnect");
      assert.equal(reconnect?.data, '{"reason":"max_duration"}');
    } finally {
      if (previous === undefined) delete process.env.SSE_MAX_MS;
      else process.env.SSE_MAX_MS = previous;
      await stream.stop();
    }
  });

  test("cancel emits cancelled and delete emits deleted", async () => {
    const fixture = await seed();
    const stream = await openEvents(fixture.secret, fixture.team.id);
    try {
      await stream.readUntil((text) => text.includes("event: ready"));
      const created = await postTask(fixture.secret, {
        teamId: fixture.team.id,
        title: "Duplicate milk",
        action: "do_now",
        important: true,
        urgent: true,
      });
      assert.equal(created.status, 201);
      const task = taskBody(created.json);
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "created" && event.taskId === task.id));

      const cancelled = await call(fixture.secret, "POST", `/tasks/${task.id}/cancel`, { outcome: "bought yesterday" });
      assert.equal(cancelled.status, 200);
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "cancelled" && event.taskId === task.id));
      const cancelEvent = taskEvents(stream.text()).find((event) => event.type === "cancelled");
      assert.ok(cancelEvent?.task);
      assert.equal(cancelEvent.task.status, "cancelled");
      assert.equal(cancelEvent.task.outcome, "bought yesterday");
      assert.equal(cancelEvent.at, cancelEvent.task.updatedAt);

      const again = await postTask(fixture.secret, { teamId: fixture.team.id, title: "Second copy" });
      assert.equal(again.status, 201);
      const duplicate = taskBody(again.json);
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "created" && event.taskId === duplicate.id));
      const removed = await call(fixture.secret, "DELETE", `/tasks/${duplicate.id}`);
      assert.equal(removed.status, 200);
      await stream.readUntil((text) => taskEvents(text).some((event) => event.type === "deleted" && event.taskId === duplicate.id));
      const deleted = taskEvents(stream.text()).find((event) => event.type === "deleted" && event.taskId === duplicate.id);
      assert.ok(deleted?.task);
      assert.equal(deleted.task.title, "Second copy");
      assert.ok(Date.parse(deleted.at) >= Date.parse(deleted.task.updatedAt));

      await handleRemoteNotification(
        JSON.stringify({
          origin: taskEventOrigin,
          type: "deleted",
          teamId: fixture.team.id,
          taskId: duplicate.id,
          at: deleted.at,
        }),
      );
      await handleRemoteNotification(
        JSON.stringify({
          origin: "other-process",
          type: "deleted",
          teamId: fixture.team.id,
          taskId: duplicate.id,
          at: deleted.at,
        }),
      );
      await stream.readUntil(
        (text) => taskEvents(text).filter((event) => event.type === "deleted" && event.taskId === duplicate.id).length === 2,
      );
      const remote = taskEvents(stream.text()).filter((event) => event.type === "deleted" && event.taskId === duplicate.id);
      assert.equal(remote[1]?.task, null);
      assert.equal(remote[1]?.at, deleted.at);
    } finally {
      await stream.stop();
    }
  });

  test("MCP points at the SSE URL and does not stream it", async () => {
    const fixture = await seed();
    const listed = await rpc(fixture.secret, "resources/list");
    assert.equal(listed.status, 200);
    const resources = (rpcResult(listed.json) as { resources: { uri: string; name: string }[] }).resources;
    assert.ok(resources.some((resource) => resource.uri === "hearth://task-events" && resource.name === "task-events"));

    const read = await rpc(fixture.secret, "resources/read", { uri: "hearth://task-events" });
    const text = (rpcResult(read.json) as { contents: { text?: string }[] }).contents[0]?.text ?? "";
    assert.match(text, new RegExp(`GET /teams/${fixture.team.id}/events`));
    assert.match(text, /Authorization: Bearer/);
    assert.match(text, /list_tasks/);
    assert.match(text, /cancelled/);
    assert.match(text, /deleted/);
    assert.doesNotMatch(text, /Tasks are not deleted/);

    const anon = await rpc(null, "resources/read", { uri: "hearth://task-events" });
    assert.equal(anon.status, 401);
  });
});

async function seed() {
  const [user] = await db
    .insert(users)
    .values({ email: `james-${crypto.randomUUID()}@example.com`, name: "James" })
    .returning();
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

type Stream = {
  status: number;
  headers: Headers;
  json: unknown;
  text: () => string;
  readUntil: (match: (text: string) => boolean, ms?: number) => Promise<string>;
  stop: () => Promise<void>;
};

async function openEvents(token: string | null, teamId: string, cookie?: string): Promise<Stream> {
  const controller = new AbortController();
  const headers = new Headers({ accept: "text/event-stream" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (cookie) headers.set("cookie", cookie);
  const response = await app.request(`/teams/${teamId}/events`, { headers, signal: controller.signal });
  if (response.status !== 200 || !response.body) {
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: text ? (JSON.parse(text) as unknown) : null,
      text: () => text,
      readUntil: async () => {
        throw new Error("not a stream");
      },
      stop: async () => {
        controller.abort();
      },
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    status: response.status,
    headers: response.headers,
    json: null,
    text: () => buf,
    async readUntil(match, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!match(buf)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timeout\n${buf}`);
        const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout\n${buf}`)), remaining);
          reader.read().then(
            (result) => {
              clearTimeout(timer);
              resolve(result);
            },
            (err: unknown) => {
              clearTimeout(timer);
              reject(err);
            },
          );
        });
        if (next.done) {
          buf += decoder.decode();
          break;
        }
        buf += decoder.decode(next.value, { stream: true });
      }
      if (!match(buf)) throw new Error(`stream ended\n${buf}`);
      return buf;
    },
    async stop() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function postTask(token: string | null, body: Record<string, unknown>, key?: string, cookie?: string) {
  return call(cookie ? null : token, "POST", "/tasks", body, key, cookie);
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

const gmailSource = {
  type: "email",
  href: "https://mail.google.com/mail/u/0/#all/18f2c4e8a1b2c3d4",
  label: "Bins",
  externalId: "18f2c4e8a1b2c3d4",
};

type TaskEventBody = {
  type: string;
  teamId: string;
  taskId: string;
  at: string;
  task: {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
    outcome: string | null;
    source: typeof gmailSource | null;
    project: { id: string; name: string } | null;
    area: { id: string; name: string } | null;
  } | null;
};

function parseEvents(text: string) {
  const events: { event?: string; data?: string; id?: string; retry?: string }[] = [];
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event: string | undefined;
    let id: string | undefined;
    let retry: string | undefined;
    const data: string[] = [];
    let meaningful = false;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      const valueOf = (name: string) => {
        const prefix = `${name}:`;
        if (!line.startsWith(prefix)) return undefined;
        return line.slice(prefix.length).replace(/^ /, "");
      };
      const eventValue = valueOf("event");
      const dataValue = valueOf("data");
      const idValue = valueOf("id");
      const retryValue = valueOf("retry");
      if (eventValue !== undefined) {
        event = eventValue;
        meaningful = true;
      } else if (dataValue !== undefined) {
        data.push(dataValue);
        meaningful = true;
      } else if (idValue !== undefined) {
        id = idValue;
        meaningful = true;
      } else if (retryValue !== undefined) {
        retry = retryValue;
        meaningful = true;
      }
    }
    if (meaningful) events.push({ event, data: data.join("\n"), id, retry });
  }
  return events;
}

function taskEvents(text: string): TaskEventBody[] {
  return parseEvents(text)
    .filter((event) =>
      event.event === "created" ||
      event.event === "updated" ||
      event.event === "completed" ||
      event.event === "cancelled" ||
      event.event === "deleted",
    )
    .map((event) => JSON.parse(event.data ?? "") as TaskEventBody);
}

function taskBody(json: unknown) {
  const task = json as { id: string; updatedAt: string; title: string };
  assert.equal(typeof task.id, "string");
  return task;
}

function errorCode(json: unknown) {
  const code = (json as { error?: { code?: string } }).error?.code;
  assert.equal(typeof code, "string");
  return code;
}

function idle(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
