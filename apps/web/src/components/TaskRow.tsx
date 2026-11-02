import type { Task } from "@hearth/shared";
import { Flags } from "@/components/Flags";
import { formatDue } from "@/lib/format";

export function TaskRow({
  task,
  ownerLabel,
  teamLabel,
  onEdit,
  onComplete,
  as = "li",
}: {
  task: Task;
  ownerLabel: string;
  teamLabel?: string;
  onEdit: () => void;
  onComplete: () => void;
  as?: "li" | "div";
}) {
  const overdue = task.status === "open" && task.dueAt != null && new Date(task.dueAt).getTime() < Date.now();
  const Tag = as;
  return (
    <Tag className="flex gap-3 border-b border-line py-3 last:border-b-0">
      {task.status === "open" ? (
        <button
          type="button"
          onClick={onComplete}
          aria-label={`Mark “${task.title}” done`}
          className="mt-1 h-5 w-5 shrink-0 rounded-full border border-ink/30 hover:border-teal hover:bg-teal/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal"
        />
      ) : (
        <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-moss text-[0.65rem] text-sheet" aria-hidden>
          ✓
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button type="button" onClick={onEdit} className="text-left font-medium hover:text-teal">
            {task.title}
          </button>
          <Flags important={task.important} urgent={task.urgent} />
        </div>
        {task.detail ? <p className="mt-1 line-clamp-2 text-sm text-muted">{task.detail}</p> : null}
        <p className="mt-1 text-xs text-muted">
          {[
            teamLabel,
            task.project,
            task.dueAt
              ? `${overdue ? "Overdue" : task.action === "delegate" ? "Follow up" : "Due"} ${formatDue(task.dueAt)}`
              : null,
            task.action === "delegate" && task.waitingOn ? `Waiting on ${task.waitingOn}` : null,
            task.action === "schedule" && task.needsCalendar ? "Needs a calendar" : null,
            task.action === "schedule" && task.calendarEventId ? "On the calendar" : null,
            ownerLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {task.status === "done" && task.outcome ? (
          <p className="mt-1 text-sm text-moss">Outcome: {task.outcome}</p>
        ) : null}
      </div>
    </Tag>
  );
}
