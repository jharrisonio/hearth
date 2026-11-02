export {};

/**
 * Proves personal/household isolation plus the task operations in the v1 brief.
 * Talks to a running API. Defaults to the docker-compose API port.
 *
 *   API_URL=http://127.0.0.1:43124 pnpm isolation-check
 */

const API = process.env.API_URL ?? "http://127.0.0.1:43124";

type ActorRef = { type: "user" | "bot"; id: string };
type Task = {
  id: string;
  teamId: string;
  title: string;
  status: "open" | "done";
  lane: "next" | "waiting" | "someday";
  important: boolean;
  urgent: boolean;
  waitingOn: string | null;
  outcome: string | null;
  completedAt: string | null;
  owner: ActorRef;
  dueAt: string | null;
};
type Team = { id: string; name: string; kind: "personal" | "household"; role: string };

const created: { cookie: string; id: string }[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API not healthy at ${API} (${last})`);
}

async function login(email: string) {
  const response = await fetch(`${API}/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`login ${email} failed ${response.status} ${text}`);
  const cookies = response.headers.getSetCookie();
  assert(cookies.length > 0, `login ${email} did not set a session cookie`);
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function call(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, json };
}

function expectStatus(result: { status: number; json: unknown }, status: number, label: string) {
  if (result.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${result.status} ${JSON.stringify(result.json)}`);
  }
  return result.json;
}

async function createTask(cookie: string, body: Record<string, unknown>) {
  const json = expectStatus(await call(cookie, "POST", "/tasks", body), 201, `create ${String(body.title)}`) as Task;
  created.push({ cookie, id: json.id });
  return json;
}

async function main() {
  await waitForHealth();
  const stamp = Date.now().toString(36);
  const james = await login("james@example.com");
  const naomi = await login("naomi@example.com");
  console.log("ok  dev sign-in for James and Naomi");

  const jamesTeams = expectStatus(await call(james, "GET", "/teams"), 200, "james teams") as { teams: Team[] };
  const naomiTeams = expectStatus(await call(naomi, "GET", "/teams"), 200, "naomi teams") as { teams: Team[] };
  const jamesPersonal = one(jamesTeams.teams.filter((team) => team.kind === "personal"), "James personal team");
  const naomiPersonal = one(naomiTeams.teams.filter((team) => team.kind === "personal"), "Naomi personal team");
  const household = one(
    jamesTeams.teams.filter((team) => team.name === "Harrison household"),
    "Harrison household",
  );
  assert(jamesPersonal.id !== naomiPersonal.id, "personal teams must differ");
  assert(
    naomiTeams.teams.some((team) => team.id === household.id),
    "Naomi should be on the household",
  );
  assert(
    !naomiTeams.teams.some((team) => team.id === jamesPersonal.id),
    "Naomi's team list must not include James's personal team",
  );

  const secretTitle = `isolation personal ${stamp}`;
  const personal = await createTask(james, {
    teamId: jamesPersonal.id,
    title: secretTitle,
    lane: "next",
    important: true,
    urgent: true,
  });
  assert(personal.owner.type === "user", "default owner is the signed-in user");
  assert(personal.lane === "next" && personal.important && personal.urgent, "create defaults and flags");

  expectStatus(await call(naomi, "GET", `/tasks?teamId=${jamesPersonal.id}`), 403, "naomi list personal");
  expectStatus(
    await call(naomi, "PATCH", `/tasks/${personal.id}`, { title: "should not stick" }),
    403,
    "naomi patch personal",
  );
  expectStatus(
    await call(naomi, "POST", `/tasks/${personal.id}/complete`, { outcome: "nope" }),
    403,
    "naomi complete personal",
  );
  const naomiQueue = expectStatus(await call(naomi, "GET", "/tasks/do-immediately"), 200, "naomi queue") as {
    tasks: Task[];
  };
  assert(
    !naomiQueue.tasks.some((task) => task.id === personal.id || task.teamId === jamesPersonal.id),
    "Naomi's do-immediately includes James's personal work",
  );
  console.log("ok  Naomi cannot read or change James's personal tasks");

  const shared = await createTask(james, {
    teamId: household.id,
    title: `isolation household ${stamp}`,
    lane: "next",
  });
  const naomiHousehold = expectStatus(await call(naomi, "GET", `/tasks?teamId=${household.id}`), 200, "naomi household") as {
    tasks: Task[];
  };
  assert(
    naomiHousehold.tasks.some((task) => task.id === shared.id),
    "Naomi should see the household task James created",
  );
  const naomiWrote = await createTask(naomi, {
    teamId: household.id,
    title: `isolation naomi household ${stamp}`,
    lane: "someday",
  });
  const jamesSees = expectStatus(await call(james, "GET", `/tasks?teamId=${household.id}`), 200, "james household") as {
    tasks: Task[];
  };
  assert(jamesSees.tasks.some((task) => task.id === naomiWrote.id), "James should see Naomi's household task");
  console.log("ok  household tasks are shared both ways");

  expectStatus(
    await call(james, "PATCH", `/tasks/${personal.id}`, { title: "renamed", status: "done" }),
    400,
    "patch status",
  );
  expectStatus(
    await call(james, "PATCH", `/tasks/${personal.id}`, { lane: "waiting" }),
    400,
    "waiting without waitingOn",
  );
  const waiting = expectStatus(
    await call(james, "PATCH", `/tasks/${personal.id}`, { lane: "waiting", waitingOn: "the weekend" }),
    200,
    "set waiting",
  ) as Task;
  assert(waiting.lane === "waiting" && waiting.waitingOn === "the weekend", "waitingOn stored");
  expectStatus(await call(james, "POST", `/tasks/${shared.id}/complete`, {}), 400, "complete without outcome");
  expectStatus(await call(james, "POST", `/tasks/${shared.id}/complete`, { outcome: "   " }), 400, "blank outcome");
  const done = expectStatus(
    await call(james, "POST", `/tasks/${shared.id}/complete`, { outcome: "Oat milk is in the fridge" }),
    200,
    "complete",
  ) as Task;
  assert(done.status === "done" && done.outcome === "Oat milk is in the fridge" && done.completedAt, "completion fields");
  expectStatus(
    await call(james, "POST", `/tasks/${shared.id}/complete`, { outcome: "again" }),
    409,
    "complete twice",
  );
  console.log("ok  update rejects status, waitingOn is required, complete needs an outcome");

  expectStatus(await call(naomi, "POST", `/teams/${household.id}/tokens`, { label: "nope" }), 403, "member mint");
  expectStatus(
    await call(james, "POST", `/teams/${jamesPersonal.id}/members`, { email: "naomi@example.com" }),
    400,
    "personal invite",
  );

  const minted = expectStatus(
    await call(james, "POST", `/teams/${jamesPersonal.id}/tokens`, { label: `iso-${stamp}` }),
    201,
    "mint personal token",
  ) as { secret: string; token: { id: string; prefix: string } };
  assert(minted.secret.startsWith("hth_"), "token prefix");
  const listed = expectStatus(await call(james, "GET", `/teams/${jamesPersonal.id}/tokens`), 200, "list tokens") as {
    tokens: { id: string; secret?: string }[];
  };
  assert(
    listed.tokens.some((token) => token.id === minted.token.id) && listed.tokens.every((token) => token.secret == null),
    "token list must not repeat the secret",
  );

  const botTask = expectStatus(
    await call(null, "POST", "/tasks", { teamId: jamesPersonal.id, title: `isolation bot ${stamp}`, lane: "next" }, minted.secret),
    201,
    "bot create",
  ) as Task;
  created.push({ cookie: james, id: botTask.id });
  assert(botTask.owner.type === "bot" && botTask.owner.id === minted.token.id, "bot owner defaults to the token");
  const botList = expectStatus(
    await call(null, "GET", `/tasks?teamId=${jamesPersonal.id}`, undefined, minted.secret),
    200,
    "bot list personal",
  ) as { tasks: Task[] };
  assert(botList.tasks.some((task) => task.id === personal.id), "bot should see the personal task");
  expectStatus(await call(null, "GET", `/tasks?teamId=${household.id}`, undefined, minted.secret), 403, "personal bot household");
  expectStatus(
    await call(null, "GET", "/tasks/do-immediately", undefined, minted.secret),
    200,
    "bot queue",
  );
  const botDone = expectStatus(
    await call(null, "POST", `/tasks/${botTask.id}/complete`, { outcome: "Bot filed it" }, minted.secret),
    200,
    "bot complete",
  ) as Task;
  assert(botDone.status === "done" && botDone.outcome === "Bot filed it", "bot completion");

  const householdToken = expectStatus(
    await call(james, "POST", `/teams/${household.id}/tokens`, { label: `house-${stamp}` }),
    201,
    "mint household token",
  ) as { secret: string; token: { id: string } };
  expectStatus(
    await call(null, "GET", `/tasks?teamId=${jamesPersonal.id}`, undefined, householdToken.secret),
    403,
    "household bot personal",
  );
  const householdBotList = expectStatus(
    await call(null, "GET", `/tasks?teamId=${household.id}`, undefined, householdToken.secret),
    200,
    "household bot list",
  ) as { tasks: Task[] };
  assert(householdBotList.tasks.some((task) => task.id === shared.id), "household bot sees household tasks");
  console.log("ok  bot tokens stay inside one team, and revocation is next");

  expectStatus(await call(james, "DELETE", `/teams/${jamesPersonal.id}/tokens/${minted.token.id}`), 200, "revoke");
  expectStatus(await call(null, "GET", `/tasks?teamId=${jamesPersonal.id}`, undefined, minted.secret), 401, "revoked token");
  expectStatus(
    await call(james, "DELETE", `/teams/${household.id}/tokens/${householdToken.token.id}`),
    200,
    "revoke household",
  );
  console.log("ok  revoked token is rejected");

  await checkOrder(james, jamesPersonal.id, stamp);
  console.log("ok  do-immediately order");
  console.log("isolation check passed");
}

async function checkOrder(cookie: string, teamId: string, stamp: string) {
  const due = (day: number) => new Date(Date.UTC(2026, 10, day, 0, 0, 0)).toISOString();
  const make = (title: string, fields: Record<string, unknown>) =>
    createTask(cookie, { teamId, title: `${stamp} ${title}`, project: `isolation-${stamp}`, ...fields });

  const neitherOlder = await make("neither-older", { lane: "next", important: false, urgent: false });
  const neitherNewer = await make("neither-newer", { lane: "next", important: false, urgent: false });
  const urgentOnly = await make("urgent", { lane: "next", important: false, urgent: true, dueAt: due(1) });
  const importantOnly = await make("important", { lane: "next", important: true, urgent: false, dueAt: due(15) });
  const bothLater = await make("both-later", { lane: "next", important: true, urgent: true, dueAt: due(20) });
  const bothSooner = await make("both-sooner", { lane: "next", important: true, urgent: true, dueAt: due(10) });
  const bothNull = await make("both-null", { lane: "next", important: true, urgent: true });
  const someday = await make("someday", { lane: "someday", important: true, urgent: true });
  const done = await make("done", { lane: "next", important: true, urgent: true });
  expectStatus(await call(cookie, "POST", `/tasks/${done.id}/complete`, { outcome: "finished during the check" }), 200, "order complete");

  const queue = expectStatus(await call(cookie, "GET", `/tasks/do-immediately?teamId=${teamId}`), 200, "order queue") as {
    tasks: Task[];
  };
  for (const task of queue.tasks) {
    assert(task.status === "open" && task.lane === "next", `do-immediately returned ${task.status}/${task.lane}`);
  }
  const wanted = [bothSooner, bothLater, bothNull, importantOnly, urgentOnly, neitherNewer, neitherOlder].map((task) => task.id);
  const actual = queue.tasks.map((task) => task.id).filter((id) => wanted.includes(id));
  assert(actual.join() === wanted.join(), `order mismatch\n want ${wanted.join(" ")}\n got  ${actual.join(" ")}`);
  const ids = new Set(queue.tasks.map((task) => task.id));
  assert(!ids.has(someday.id) && !ids.has(done.id), "someday and done tasks leaked into do-immediately");
}

function one<T>(items: T[], label: string): T {
  const first = items[0];
  if (!first || items.length !== 1) throw new Error(`expected exactly one ${label}, found ${items.length}`);
  return first;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (const task of created) {
    try {
      const probe = await call(task.cookie, "POST", `/tasks/${task.id}/complete`, {
        outcome: "isolation check cleanup",
      });
      if (probe.status !== 200 && probe.status !== 409) {
        console.error(`cleanup ${task.id} returned ${probe.status}`);
      }
    } catch (error) {
      console.error(`cleanup ${task.id} failed`, error);
    }
  }
}
