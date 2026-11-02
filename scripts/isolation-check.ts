import { inMorningQueue } from "../packages/shared/src/index.js";

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
  status: "open" | "done" | "cancelled";
  action: "do_now" | "delegate" | "schedule" | "later";
  important: boolean;
  urgent: boolean;
  waitingOn: string | null;
  calendarEventId: string | null;
  needsCalendar: boolean;
  outcome: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  owner: ActorRef;
  dueAt: string | null;
  createdAt: string;
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
    important: true,
    urgent: true,
  });
  assert(personal.owner.type === "user", "default owner is the signed-in user");
  assert(
    personal.action === "do_now" && personal.important && personal.urgent && personal.needsCalendar === false,
    "create suggests do_now from both flags",
  );
  assert(personal.calendarEventId == null, "create does not invent a calendar event");

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
  expectStatus(await call(naomi, "POST", `/tasks/${personal.id}/cancel`, {}), 403, "naomi cancel personal");
  expectStatus(await call(naomi, "DELETE", `/tasks/${personal.id}`), 403, "naomi delete personal");
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
    action: "do_now",
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
    action: "later",
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
    await call(james, "PATCH", `/tasks/${personal.id}`, { action: "delegate" }),
    400,
    "delegate without waitingOn",
  );
  const waiting = expectStatus(
    await call(james, "PATCH", `/tasks/${personal.id}`, { action: "delegate", waitingOn: "the weekend" }),
    200,
    "set delegate",
  ) as Task;
  assert(waiting.action === "delegate" && waiting.waitingOn === "the weekend", "waitingOn stored");
  assert(waiting.dueAt == null, "update does not invent a follow-up date");
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
  console.log("ok  update rejects status, delegated tasks need waitingOn, complete needs an outcome");

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
    await call(null, "POST", "/tasks", { teamId: jamesPersonal.id, title: `isolation bot ${stamp}`, action: "do_now" }, minted.secret),
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

  await checkActions(james, jamesPersonal.id, stamp);
  console.log("ok  action suggestion, constraints, and morning queue");
  await checkDrop(james, jamesPersonal.id, stamp);
  console.log("ok  cancel keeps an audit row and delete removes the task");
  await checkOrder(james, jamesPersonal.id, stamp);
  console.log("ok  do-immediately order");
  console.log("isolation check passed");
}

async function checkOrder(cookie: string, teamId: string, stamp: string) {
  const due = (day: number) => new Date(Date.UTC(2026, 10, day, 0, 0, 0)).toISOString();
  const make = (title: string, fields: Record<string, unknown>) =>
    createTask(cookie, { teamId, title: `${stamp} ${title}`, ...fields });

  const neitherOlder = await make("neither-older", { action: "do_now", important: false, urgent: false });
  const neitherNewer = await make("neither-newer", { action: "do_now", important: false, urgent: false });
  const urgentOnly = await make("urgent", { action: "do_now", important: false, urgent: true, dueAt: due(1) });
  const importantOnly = await make("important", { action: "do_now", important: true, urgent: false, dueAt: due(15) });
  const bothLater = await make("both-later", { action: "do_now", important: true, urgent: true, dueAt: due(20) });
  const bothSooner = await make("both-sooner", { action: "do_now", important: true, urgent: true, dueAt: due(10) });
  const bothNull = await make("both-null", { action: "do_now", important: true, urgent: true });
  const later = await make("later", { action: "later", important: true, urgent: true });
  const done = await make("done", { action: "do_now", important: true, urgent: true });
  expectStatus(await call(cookie, "POST", `/tasks/${done.id}/complete`, { outcome: "finished during the check" }), 200, "order complete");

  const queue = expectStatus(await call(cookie, "GET", `/tasks/do-immediately?teamId=${teamId}`), 200, "order queue") as {
    tasks: Task[];
  };
  for (const task of queue.tasks) {
    assert(task.status === "open" && inMorningQueue(task), `do-immediately returned ${task.status}/${task.action}`);
  }
  const wanted = [bothSooner, bothLater, bothNull, importantOnly, urgentOnly, neitherNewer, neitherOlder].map((task) => task.id);
  const actual = queue.tasks.map((task) => task.id).filter((id) => wanted.includes(id));
  assert(actual.join() === wanted.join(), `order mismatch\n want ${wanted.join(" ")}\n got  ${actual.join(" ")}`);
  const ids = new Set(queue.tasks.map((task) => task.id));
  assert(!ids.has(later.id) && !ids.has(done.id), "later and done tasks leaked into do-immediately");
}

async function checkActions(cookie: string, teamId: string, stamp: string) {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const make = (title: string, fields: Record<string, unknown>) =>
    createTask(cookie, { teamId, title: `${stamp} ${title}`, ...fields });

  const doNow = await make("filter-do-now", { action: "do_now", dueAt: future });
  const scheduleNeeds = await make("filter-schedule-needs", { action: "schedule", dueAt: future });
  const scheduleFuture = await make("filter-schedule-future", {
    action: "schedule",
    calendarEventId: "evt-future",
    needsCalendar: true,
    dueAt: future,
  });
  const schedulePast = await make("filter-schedule-past", {
    action: "schedule",
    calendarEventId: "evt-past",
    dueAt: past,
  });
  const delegateFuture = await make("filter-delegate-future", { action: "delegate", waitingOn: "Alex", dueAt: future });
  const delegateDue = await make("filter-delegate-due", { action: "delegate", waitingOn: "Sam", dueAt: past });
  const delegateDefault = await make("filter-delegate-default", { action: "delegate", waitingOn: "Pat" });
  const later = await make("filter-later", { action: "later", important: true, urgent: true });
  const override = await make("filter-override", {
    action: "schedule",
    important: false,
    urgent: false,
    calendarEventId: "evt-override",
  });
  const suggestedDelegate = await make("suggest-delegate", { urgent: true, waitingOn: "the council" });
  const suggestedSchedule = await make("suggest-schedule", { important: true, urgent: false });
  const suggestedLater = await make("suggest-later", { important: false, urgent: false });
  const suggestedNow = await make("suggest-now", { important: true, urgent: true });

  assert(scheduleNeeds.action === "schedule" && scheduleNeeds.needsCalendar === true && scheduleNeeds.calendarEventId == null, "schedule without an id needs a calendar");
  assert(scheduleFuture.needsCalendar === false && scheduleFuture.calendarEventId === "evt-future", "calendar id forces needsCalendar false");
  assert(schedulePast.needsCalendar === false, "past schedule with an id is linked");
  assert(override.action === "schedule" && override.important === false && override.urgent === false, "action overrides the matrix");
  assert(override.needsCalendar === false, "overridden schedule with an id does not need a calendar");
  assert(suggestedDelegate.action === "delegate" && suggestedDelegate.important === false && suggestedDelegate.urgent === true, "urgent only suggests delegate");
  assert(suggestedSchedule.action === "schedule" && suggestedSchedule.needsCalendar === true, "important only suggests schedule");
  assert(suggestedLater.action === "later" && suggestedLater.needsCalendar === false, "neither suggests later");
  assert(suggestedNow.action === "do_now" && suggestedNow.needsCalendar === false, "both flags suggest do_now");
  assert(delegateDefault.dueAt != null, "omitted delegate dueAt is filled in");
  const followUpDelta = new Date(delegateDefault.dueAt ?? 0).getTime() - Date.now();
  assert(Math.abs(followUpDelta - 3 * 24 * 60 * 60 * 1000) < 120_000, "delegate follow-up defaults to about three days");

  expectStatus(
    await call(cookie, "POST", "/tasks", { teamId, title: `${stamp} delegate-missing`, action: "delegate" }),
    400,
    "create delegate without waitingOn",
  );
  expectStatus(
    await call(cookie, "POST", "/tasks", { teamId, title: `${stamp} suggest-missing`, urgent: true }),
    400,
    "suggested delegate without waitingOn",
  );
  expectStatus(
    await call(cookie, "POST", "/tasks", { teamId, title: `${stamp} old-lane`, lane: "next" }),
    400,
    "lane body removed",
  );
  expectStatus(await call(cookie, "GET", `/tasks?teamId=${teamId}&lane=next`), 400, "lane query removed");
  expectStatus(await call(cookie, "GET", `/tasks?teamId=${teamId}&action=nope`), 400, "bad action");

  const delegates = expectStatus(await call(cookie, "GET", `/tasks?teamId=${teamId}&action=delegate`), 200, "filter delegate") as {
    tasks: Task[];
  };
  assert(delegates.tasks.every((task) => task.action === "delegate"), "action filter is exact");
  assert(delegates.tasks.some((task) => task.id === delegateDue.id), "action filter includes the delegate");

  const queue = await queueIds(cookie, teamId);
  for (const task of queue.tasks) assert(inMorningQueue(task), `morning queue included ${task.action}`);
  const ids = new Set(queue.tasks.map((task) => task.id));
  assert(ids.has(doNow.id), "do_now is in the morning queue");
  assert(ids.has(scheduleNeeds.id), "schedule that needs a calendar is in the morning queue");
  assert(!ids.has(scheduleFuture.id), "future schedule with a calendar id leaked into the morning queue");
  assert(ids.has(schedulePast.id), "overdue schedule is in the morning queue");
  assert(!ids.has(delegateFuture.id), "future delegate leaked into the morning queue");
  assert(ids.has(delegateDue.id), "due delegate is in the morning queue");
  assert(!ids.has(delegateDefault.id), "fresh delegate follow-up leaked into the morning queue");
  assert(!ids.has(later.id), "later leaked into the morning queue");
  assert(!ids.has(override.id), "linked schedule with no due date leaked into the morning queue");
  assert(!ids.has(suggestedDelegate.id), "suggested delegate with a future follow-up leaked");
  assert(ids.has(suggestedSchedule.id), "suggested schedule is in the morning queue");
  assert(!ids.has(suggestedLater.id), "suggested later leaked into the morning queue");
  assert(ids.has(suggestedNow.id), "suggested do_now is in the morning queue");

  const linked = expectStatus(
    await call(cookie, "PATCH", `/tasks/${scheduleNeeds.id}`, { calendarEventId: "evt-added" }),
    200,
    "link calendar",
  ) as Task;
  assert(linked.action === "schedule" && linked.needsCalendar === false && linked.calendarEventId === "evt-added", "linking a calendar clears needsCalendar");
  const after = await queueIds(cookie, teamId);
  assert(!after.tasks.some((task) => task.id === scheduleNeeds.id), "linked future schedule left the morning queue");
}

async function checkDrop(cookie: string, teamId: string, stamp: string) {
  const live = await createTask(cookie, {
    teamId,
    title: `${stamp} cancel-me`,
    action: "do_now",
    important: true,
    urgent: true,
  });
  const cancelled = expectStatus(await call(cookie, "POST", `/tasks/${live.id}/cancel`, {}), 200, "cancel") as Task;
  assert(cancelled.status === "cancelled" && cancelled.outcome === "cancelled" && cancelled.cancelledAt, "cancel fields");
  assert(cancelled.completedAt == null, "cancel does not set completedAt");
  const open = expectStatus(await call(cookie, "GET", `/tasks?teamId=${teamId}&status=open`), 200, "open after cancel") as {
    tasks: Task[];
  };
  assert(!open.tasks.some((task) => task.id === live.id), "cancelled task stayed on the open list");
  const queue = await queueIds(cookie, teamId);
  assert(!queue.tasks.some((task) => task.id === live.id), "cancelled task stayed in the morning queue");
  const audit = expectStatus(
    await call(cookie, "GET", `/tasks?teamId=${teamId}&status=cancelled`),
    200,
    "cancelled list",
  ) as { tasks: Task[] };
  assert(audit.tasks.some((task) => task.id === live.id), "cancelled task is missing from the audit list");
  expectStatus(await call(cookie, "POST", `/tasks/${live.id}/cancel`, { outcome: "again" }), 409, "cancel twice");
  expectStatus(await call(cookie, "POST", `/tasks/${live.id}/complete`, { outcome: "nope" }), 409, "complete cancelled");

  const dupe = await createTask(cookie, { teamId, title: `${stamp} delete-me`, action: "later" });
  const removed = expectStatus(await call(cookie, "DELETE", `/tasks/${dupe.id}`), 200, "delete") as {
    id: string;
    deleted: boolean;
  };
  assert(removed.deleted === true && removed.id === dupe.id, "delete response");
  const after = expectStatus(await call(cookie, "GET", `/tasks?teamId=${teamId}`), 200, "list after delete") as {
    tasks: Task[];
  };
  assert(!after.tasks.some((task) => task.id === dupe.id), "deleted task is still listed");
  expectStatus(await call(cookie, "DELETE", `/tasks/${dupe.id}`), 404, "delete twice");
}

async function queueIds(cookie: string, teamId: string) {
  return expectStatus(await call(cookie, "GET", `/tasks/do-immediately?teamId=${teamId}`), 200, "morning queue") as {
    tasks: Task[];
  };
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
      if (probe.status !== 200 && probe.status !== 409 && probe.status !== 404) {
        console.error(`cleanup ${task.id} returned ${probe.status}`);
      }
    } catch (error) {
      console.error(`cleanup ${task.id} failed`, error);
    }
  }
}
