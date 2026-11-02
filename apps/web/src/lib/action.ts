import { needsCheckIn, type Action, type TaskStatus } from "@hearth/shared";

export const actionLabel: Record<Action, string> = {
  do_now: "Do now",
  delegate: "Delegate",
  schedule: "Schedule",
  later: "Later",
};

/** List cue for an open schedule task. A missing calendar wins the first slot; a past dueAt adds check-in. */
export function scheduleListCue(task: {
  status: TaskStatus;
  action: Action;
  needsCalendar: boolean;
  dueAt: string | null;
}): string | null {
  if (task.status !== "open" || task.action !== "schedule") return null;
  const parts: string[] = [];
  if (task.needsCalendar) parts.push("Needs a calendar");
  if (needsCheckIn(task)) parts.push("Check in");
  return parts.length ? parts.join(" · ") : null;
}

export function axesFor(action: Action): { important: boolean; urgent: boolean } {
  if (action === "do_now") return { important: true, urgent: true };
  if (action === "delegate") return { important: false, urgent: true };
  if (action === "schedule") return { important: true, urgent: false };
  return { important: false, urgent: false };
}
