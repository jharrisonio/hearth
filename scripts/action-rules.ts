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
  createTaskSchema,
  followUpFrom,
  inMorningQueue,
  resolveNeedsCalendar,
  suggestAction,
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
}

try {
  checkSuggestion();
  checkNeedsCalendar();
  checkFollowUp();
  checkMorningQueue();
  checkMigrationSql();
  console.log("action rules passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
