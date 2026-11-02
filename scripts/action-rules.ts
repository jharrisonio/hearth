/**
 * Offline checks for the Eisenhower action rules and the lane migration.
 *
 *   pnpm action-rules
 *
 * Create suggestion, waitingOn, the morning queue, and the live API are also
 * exercised by `pnpm isolation-check` against a running server.
 */

import { readFileSync } from "node:fs";
import {
  FOLLOW_UP_MS,
  calendarHref,
  createAreaSchema,
  createProjectSchema,
  createTaskSchema,
  delegateRequiresWaitingOn,
  followUpFrom,
  inBotQueue,
  inMorningQueue,
  isHttpUrl,
  isProjectFront,
  listTasksQuerySchema,
  needsCheckIn,
  resolveNeedsCalendar,
  scheduleRequiresDueAt,
  suggestAction,
  updateProjectSchema,
  updateTaskSchema,
  type Action,
} from "../packages/shared/src/index.js";

const teamId = "11111111-1111-4111-8111-111111111111";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkSuggestion() {
  assert(suggestAction(true, true) === "do_now", "IU suggests do_now");
  assert(suggestAction(false, true) === "delegate", "urgent only suggests delegate");
  assert(suggestAction(true, false) === "schedule", "important only suggests schedule");
  assert(suggestAction(false, false) === "later", "neither suggests later");

  const suggested = createTaskSchema.parse({ teamId, title: "Buy oat milk", important: true, urgent: true });
  assert(suggested.action === undefined, "omitted action stays omitted for the server to suggest");
  assert(!createTaskSchema.safeParse({ teamId, title: "Nope", lane: "next" }).success, "create rejects lane");
  assert(!updateTaskSchema.safeParse({ lane: "waiting" }).success, "update rejects lane");
  const override = createTaskSchema.parse({
    teamId,
    title: "Park it",
    important: true,
    urgent: true,
    action: "later" satisfies Action,
  });
  assert(override.action === "later" && override.important === true && override.urgent === true, "action can override the axes");
}

function checkNeedsCalendar() {
  assert(resolveNeedsCalendar("schedule", null, false, null) === true, "schedule without an id needs a calendar");
  assert(resolveNeedsCalendar("schedule", "evt-1", true, null) === false, "a calendar id forces needsCalendar false");
  assert(resolveNeedsCalendar("do_now", "evt-2", true, null) === false, "a calendar id wins on any action");
  assert(resolveNeedsCalendar("do_now", null, true, null) === true, "an explicit needsCalendar is kept off schedule");
  assert(
    resolveNeedsCalendar("do_now", null, undefined, { action: "do_now", needsCalendar: true }) === true,
    "an update keeps an explicit needsCalendar",
  );
  assert(
    resolveNeedsCalendar("later", null, undefined, { action: "schedule", needsCalendar: true }) === false,
    "leaving schedule clears the implied needsCalendar",
  );
  assert(resolveNeedsCalendar("later", null, undefined, null) === false, "create defaults needsCalendar false");
  assert(resolveNeedsCalendar("delegate", null, undefined, null) === false, "delegate does not need a calendar");
  assert(
    resolveNeedsCalendar("schedule", "https://calendar.google.com/calendar/event?eid=abc", true, null) === false,
    "a calendar URL forces needsCalendar false",
  );

  const href = "https://calendar.google.com/calendar/event?eid=abc";
  assert(calendarHref(href) === href, "an http(s) calendar link opens as given");
  assert(
    calendarHref("  evt-1 ") === "https://calendar.google.com/calendar/u/0/r/eventedit/evt-1",
    "an event id opens in Google Calendar",
  );
  assert(calendarHref(null) === null && calendarHref("  ") === null, "a blank calendar has no link");
  const script = calendarHref("javascript:alert(1)");
  assert(script?.startsWith("https://calendar.google.com/"), "a non-http calendar value is not opened as itself");
  assert(!script?.includes("javascript:"), "the event id is encoded");

  assert(scheduleRequiresDueAt("schedule", "evt", null), "a linked schedule needs dueAt");
  assert(scheduleRequiresDueAt("schedule", " https://calendar.google.com/e ", null), "a calendar URL counts as linked");
  assert(!scheduleRequiresDueAt("schedule", "evt", "2026-11-03T00:00:00.000Z"), "a linked schedule with a time is ok");
  assert(!scheduleRequiresDueAt("schedule", null, null), "an unlinked schedule may omit dueAt");
  assert(!scheduleRequiresDueAt("schedule", "  ", null), "a blank calendar is not linked");
  assert(!scheduleRequiresDueAt("do_now", "evt", null), "other actions may carry an id without dueAt");

  const linked = createTaskSchema.parse({ teamId, title: "Book it", action: "schedule", calendarEventId: `  ${href}  ` });
  assert(linked.calendarEventId === href, "a pasted calendar URL is trimmed");
  assert(listTasksQuerySchema.parse({ needsCalendar: true, action: "schedule", status: "open" }).needsCalendar === true, "list can filter needsCalendar");
  assert(!listTasksQuerySchema.safeParse({ needsCalendar: "yes" }).success, "needsCalendar is a boolean");
}

function checkCheckIn() {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);
  const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const open = { status: "open" as const, action: "schedule" as const, dueAt: past };
  assert(needsCheckIn(open, now), "an open schedule in the past is a check-in");
  assert(needsCheckIn({ ...open, dueAt: past.toISOString() }, now), "a string dueAt still counts");
  assert(!needsCheckIn({ ...open, dueAt: now }, now), "due exactly now is not yet a check-in");
  assert(!needsCheckIn({ ...open, dueAt: future }, now), "a future schedule is not a check-in");
  assert(!needsCheckIn({ ...open, dueAt: null }, now), "a schedule with no time is not a check-in");
  assert(!needsCheckIn({ ...open, status: "done" }, now), "a done schedule is not a check-in");
  assert(!needsCheckIn({ ...open, status: "cancelled" }, now), "a cancelled schedule is not a check-in");
  assert(!needsCheckIn({ ...open, action: "do_now" }, now), "do_now is not a schedule check-in");

  const linked = { ...open, needsCalendar: false, createdAt: now };
  const unlinked = { ...linked, needsCalendar: true };
  assert(needsCheckIn(linked, now) && inMorningQueue(linked, now), "overdue linked schedule is in the morning queue");
  assert(needsCheckIn(unlinked, now) && inMorningQueue(unlinked, now), "overdue schedule is a check-in even without a calendar");
  const owned = { ...linked, owner: { type: "bot" as const, id: botId } };
  assert(inBotQueue(owned, botId, now) && needsCheckIn(owned, now), "the owning bot sees an overdue schedule check-in");
  assert(inBotQueue({ ...owned, needsCalendar: true, dueAt: future }, botId, now), "the owning bot sees a schedule that still needs a calendar");
  assert(!inBotQueue({ ...owned, dueAt: future }, botId, now), "a future linked schedule stays out of the bot queue");
}

function checkFollowUp() {
  const from = new Date("2026-11-02T00:00:00.000Z");
  assert(followUpFrom(from).getTime() - from.getTime() === FOLLOW_UP_MS, "follow-up is three days");
}

function checkMorningQueue() {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);
  const exactly = new Date(now.getTime() - FOLLOW_UP_MS);
  const older = new Date(now.getTime() - FOLLOW_UP_MS - 1);
  const base = {
    status: "open" as const,
    needsCalendar: false,
    dueAt: null as Date | null,
    createdAt: now,
  };

  assert(inMorningQueue({ ...base, action: "do_now", dueAt: future }, now), "do_now is always in the queue");
  assert(!inMorningQueue({ ...base, status: "done", action: "do_now" }, now), "done tasks stay out");
  assert(!inMorningQueue({ ...base, status: "cancelled", action: "do_now" }, now), "cancelled tasks stay out");
  assert(
    inMorningQueue({ ...base, action: "schedule", needsCalendar: true, dueAt: future }, now),
    "schedule that needs a calendar is in",
  );
  assert(
    !inMorningQueue({ ...base, action: "schedule", needsCalendar: false, dueAt: future }, now),
    "scheduled ahead with a calendar id is out",
  );
  assert(
    !inMorningQueue({ ...base, action: "schedule", needsCalendar: false, dueAt: now }, now),
    "schedule due exactly now is not yet in the past",
  );
  assert(inMorningQueue({ ...base, action: "schedule", needsCalendar: false, dueAt: past }, now), "overdue schedule is in");
  assert(inMorningQueue({ ...base, action: "delegate", dueAt: now }, now), "delegate due now is in");
  assert(inMorningQueue({ ...base, action: "delegate", dueAt: past }, now), "overdue delegate is in");
  assert(!inMorningQueue({ ...base, action: "delegate", dueAt: future }, now), "future delegate follow-up is out");
  assert(
    !inMorningQueue({ ...base, action: "delegate", dueAt: null, createdAt: exactly }, now),
    "a delegate created exactly three days ago is not yet older",
  );
  assert(
    inMorningQueue({ ...base, action: "delegate", dueAt: null, createdAt: older }, now),
    "a delegate with no follow-up created more than three days ago is in",
  );
  assert(
    !inMorningQueue({ ...base, action: "later", needsCalendar: true, dueAt: past }, now),
    "later stays out of the morning queue",
  );
  assert(
    !inMorningQueue({ ...base, action: "delegate", dueAt: past, owner: { type: "bot" } }, now),
    "a bot-owned delegate is the bot's work, not a human nudge",
  );
  assert(
    inMorningQueue({ ...base, action: "delegate", dueAt: past, owner: { type: "user" } }, now),
    "an overdue outsider delegate is in",
  );
  assert(
    !inMorningQueue({ ...base, action: "delegate", dueAt: future, owner: { type: "user" } }, now),
    "a future outsider delegate is out",
  );
}

function checkBotQueue() {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);
  const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const open = {
    status: "open" as const,
    needsCalendar: false,
    dueAt: null as Date | null,
    owner: { type: "bot" as const, id: botId },
  };

  assert(inBotQueue({ ...open, action: "delegate", dueAt: future }, botId, now), "an open bot delegate is in, even ahead");
  assert(inBotQueue({ ...open, action: "delegate", dueAt: null }, botId, now), "a bot delegate with no follow-up is in");
  assert(!inBotQueue({ ...open, status: "done", action: "delegate" }, botId, now), "a done bot delegate is out");
  assert(!inBotQueue({ ...open, status: "cancelled", action: "delegate" }, botId, now), "a cancelled bot delegate is out");
  assert(
    !inBotQueue({ ...open, action: "delegate", owner: { type: "bot", id: otherId } }, botId, now),
    "another bot's delegate is out",
  );
  assert(
    !inBotQueue({ ...open, action: "delegate", owner: { type: "user", id: botId } }, botId, now),
    "a user-owned delegate is out of the bot queue",
  );
  assert(
    inBotQueue({ ...open, action: "schedule", needsCalendar: true, dueAt: future }, botId, now),
    "a bot schedule that needs a calendar is in",
  );
  assert(inBotQueue({ ...open, action: "schedule", dueAt: past }, botId, now), "a bot's overdue schedule is in");
  assert(!inBotQueue({ ...open, action: "schedule", dueAt: now }, botId, now), "schedule due exactly now is not yet overdue");
  assert(!inBotQueue({ ...open, action: "schedule", dueAt: future }, botId, now), "a future linked schedule is out");
  assert(!inBotQueue({ ...open, action: "do_now" }, botId, now), "do_now stays on the human morning queue");
  assert(!inBotQueue({ ...open, action: "later", dueAt: past }, botId, now), "later stays out of the bot queue");
}

function checkDelegateWaiting() {
  assert(!delegateRequiresWaitingOn("do_now", { type: "user" }), "do_now never needs waitingOn");
  assert(delegateRequiresWaitingOn("delegate", { type: "user" }), "a user delegate needs waitingOn");
  assert(delegateRequiresWaitingOn("delegate", undefined), "a missing owner still needs waitingOn");
  assert(delegateRequiresWaitingOn("delegate", null), "a null owner still needs waitingOn");
  assert(!delegateRequiresWaitingOn("delegate", { type: "bot" }), "a bot delegate may omit waitingOn");
  assert(!delegateRequiresWaitingOn("later", { type: "bot" }), "later does not need waitingOn");

  const sqlText = readFileSync(new URL("../apps/api/drizzle/0009_bot_delegate.sql", import.meta.url), "utf8");
  assert(sqlText.includes(`"owner_type" = 'bot'`), "bot owners may store a delegate with no waitingOn");
  assert(sqlText.includes("tasks_delegate_waiting_chk"), "delegate check keeps its name");
  assert(
    sqlText.includes(`"waiting_on" IS NOT NULL AND length(btrim("waiting_on")) > 0`),
    "a human-owned delegate still needs waitingOn",
  );
  const journal = readFileSync(new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url), "utf8");
  assert(journal.includes("0009_bot_delegate"), "journal lists the bot delegate migration");
}

function checkSource() {
  const href = "https://mail.google.com/mail/u/0/#all/18f2c4e8a1b2c3d4";
  assert(isHttpUrl(href), "a Gmail deep link is an http(s) URL");
  assert(!isHttpUrl("javascript:alert(1)"), "a script URL is not a source link");
  assert(!isHttpUrl("ftp://example.com/file"), "ftp is not a source link");

  const gmail = { type: "email" as const, href, label: "Re: oat milk", externalId: "18f2c4e8a1b2c3d4" };
  const parsed = createTaskSchema.parse({ teamId, title: "Buy oat milk", source: gmail });
  assert(parsed.source?.type === "email" && parsed.source.href === href, "create accepts an email source");
  assert(parsed.source?.label === "Re: oat milk" && parsed.source.externalId === gmail.externalId, "label and externalId round-trip");
  const trimmed = createTaskSchema.parse({
    teamId,
    title: "Buy oat milk",
    source: { type: "email", href: `  ${href}  `, label: "  Re: oat milk  " },
  });
  assert(trimmed.source?.href === href && trimmed.source.label === "Re: oat milk", "source trims href and label");
  assert(createTaskSchema.parse({ teamId, title: "Buy oat milk" }).source === undefined, "omitted source stays omitted");
  assert(updateTaskSchema.parse({ source: null }).source === null, "null clears source");
  const page = createTaskSchema.parse({ teamId, title: "Read", source: { type: "url", href: "https://example.com/notes" } });
  assert(page.source?.type === "url" && page.source.externalId === undefined, "a url source can be just type and href");
  assert(
    !createTaskSchema.safeParse({ teamId, title: "x", source: { type: "email", href: "javascript:alert(1)" } }).success,
    "javascript href rejected",
  );
  assert(
    !createTaskSchema.safeParse({ teamId, title: "x", source: { type: "file", href: "https://example.com" } }).success,
    "unknown source type rejected",
  );
  assert(
    !createTaskSchema.safeParse({ teamId, title: "x", source: { type: "url", href: "https://example.com", note: "nope" } }).success,
    "extra source keys rejected",
  );
  assert(!createTaskSchema.safeParse({ teamId, title: "x", source: href }).success, "source is not a string");
  assert(
    !createTaskSchema.safeParse({ teamId, title: "x", source: { type: "url", href: "https://example.com", label: "   " } }).success,
    "a blank label is rejected",
  );

  const sqlText = readFileSync(new URL("../apps/api/drizzle/0004_source.sql", import.meta.url), "utf8");
  assert(sqlText.includes('"source" jsonb'), "source column is jsonb");
  assert(sqlText.includes("tasks_source_chk"), "source check constraint is named");
  const journal = readFileSync(new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url), "utf8");
  assert(journal.includes("0004_source"), "journal lists the source migration");
}

function checkMigrationSql() {
  const sqlText = readFileSync(new URL("../apps/api/drizzle/0001_action.sql", import.meta.url), "utf8");
  const compact = sqlText.replace(/\s+/g, " ");
  assert(compact.includes(`WHEN 'next' THEN 'do_now'::"task_action"`), "next maps to do_now");
  assert(compact.includes(`WHEN 'waiting' THEN 'delegate'::"task_action"`), "waiting maps to delegate");
  assert(compact.includes(`WHEN 'someday' THEN 'later'::"task_action"`), "someday maps to later");
  assert(
    compact.includes(`WHEN "lane" = 'waiting' AND "due_at" IS NULL THEN "created_at" + interval '3 days'`),
    "waiting with no due date gets created_at + 3 days",
  );
  assert(compact.includes(`ELSE "due_at"`), "an existing due date is preserved");
  assert(compact.includes(`"needs_calendar" = false`), "migrated rows do not start as needing a calendar");
  assert(
    !/"calendar_event_id"\s*=\s*(?!NULL\b)/.test(compact),
    "migration must not invent calendar event ids",
  );
  const journal = readFileSync(new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url), "utf8");
  assert(journal.includes("0001_action"), "journal lists the action migration");
  assert(journal.includes("0005_projects"), "journal lists the projects migration");
  assert(journal.includes("0006_cancel"), "journal lists the cancel migration");
  assert(journal.includes("0007_project_notes"), "journal lists the project notes migration");
  assert(journal.includes("0008_project_detail"), "journal lists the project detail migration");
  const detailSql = readFileSync(new URL("../apps/api/drizzle/0008_project_detail.sql", import.meta.url), "utf8");
  assert(detailSql.includes('ADD COLUMN "area_id"'), "projects gain an area");
  assert(detailSql.includes('ADD COLUMN "sort_order"'), "tasks gain a step order");
  assert(updateProjectSchema.parse({ areaId: null }).areaId === null, "project area can be cleared");
  assert(updateTaskSchema.parse({ sortOrder: 2 }).sortOrder === 2, "step order is a number");
  assert(!updateTaskSchema.safeParse({ sortOrder: -1 }).success, "step order cannot be negative");
  const notesSql = readFileSync(new URL("../apps/api/drizzle/0007_project_notes.sql", import.meta.url), "utf8");
  assert(notesSql.includes('ADD COLUMN "notes" text'), "projects gain a notes column");
  assert(notesSql.includes("char_length(\"notes\") <= 5000"), "project notes are capped");
  assert(createProjectSchema.parse({ name: "Tara", notes: "  plan  " }).notes === "plan", "project notes are trimmed");
  assert(updateProjectSchema.parse({ notes: null }).notes === null, "project notes can be cleared");
  assert(!createAreaSchema.safeParse({ name: "House", notes: "nope" }).success, "areas do not take notes");
  assert(isProjectFront("do_now") && isProjectFront("delegate") && isProjectFront("schedule"), "three actions are fronts");
  assert(!isProjectFront("later"), "later is support, not a front");
  const projectsSql = readFileSync(new URL("../apps/api/drizzle/0005_projects.sql", import.meta.url), "utf8");
  assert(projectsSql.includes('DROP COLUMN "project"'), "free-text project column is dropped");
  assert(projectsSql.includes("('house')") && projectsSql.includes("('finance')"), "area names are not migrated into projects");
  assert(!createTaskSchema.safeParse({ teamId, title: "Nope", project: "Kitchen" }).success, "create rejects the free-text project");
  assert(!updateTaskSchema.safeParse({ project: "Kitchen" }).success, "update rejects the free-text project");
  assert(!listTasksQuerySchema.safeParse({ project: "Kitchen" }).success, "list rejects the free-text project filter");
  const linked = createTaskSchema.parse({
    teamId,
    title: "Tara AU returns",
    projectId: "22222222-2222-4222-8222-222222222222",
    areaId: null,
  });
  assert(linked.projectId === "22222222-2222-4222-8222-222222222222" && linked.areaId === null, "tasks link by id");
}

try {
  checkSuggestion();
  checkNeedsCalendar();
  checkCheckIn();
  checkFollowUp();
  checkMorningQueue();
  checkBotQueue();
  checkDelegateWaiting();
  checkSource();
  checkMigrationSql();
  console.log("action rules passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
