import type { Action } from "@hearth/shared";

export const actionLabel: Record<Action, string> = {
  do_now: "Do now",
  delegate: "Delegate",
  schedule: "Schedule",
  later: "Later",
};

export function axesFor(action: Action): { important: boolean; urgent: boolean } {
  if (action === "do_now") return { important: true, urgent: true };
  if (action === "delegate") return { important: false, urgent: true };
  if (action === "schedule") return { important: true, urgent: false };
  return { important: false, urgent: false };
}
