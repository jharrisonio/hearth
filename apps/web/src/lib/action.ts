/** Eisenhower quadrant. Derived from important × urgent, never stored. */
export const actions = ["do", "delegate", "schedule", "later"] as const;
export type Action = (typeof actions)[number];

export const actionLabel: Record<Action, string> = {
  do: "Do now",
  delegate: "Delegate",
  schedule: "Schedule",
  later: "Later",
};

export function isAction(value: string | null | undefined): value is Action {
  return value === "do" || value === "delegate" || value === "schedule" || value === "later";
}

export function actionOf(task: { important: boolean; urgent: boolean }): Action {
  if (task.important && task.urgent) return "do";
  if (task.urgent) return "delegate";
  if (task.important) return "schedule";
  return "later";
}

export function axesFor(action: Action): { important: boolean; urgent: boolean } {
  if (action === "do") return { important: true, urgent: true };
  if (action === "delegate") return { important: false, urgent: true };
  if (action === "schedule") return { important: true, urgent: false };
  return { important: false, urgent: false };
}
