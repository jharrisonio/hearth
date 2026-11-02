import type { Action, BotTokenSummary, Member, Task } from "@hearth/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { fromLocalInput, ownerKey, parseOwnerKey, toLocalInput } from "@/lib/format";

const fieldClass =
  "mt-1 w-full rounded-xl border border-line bg-white/70 px-3 py-2 text-sm outline-none focus:border-teal";

export function TaskDialog({
  open,
  teamId,
  task,
  members,
  tokens,
  defaultOwnerId,
  onClose,
  onSaved,
}: {
  open: boolean;
  teamId: string;
  task: Task | null;
  members: Member[];
  tokens: BotTokenSummary[];
  defaultOwnerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {open ? (
          <TaskForm
            key={task?.id ?? "new"}
            teamId={teamId}
            task={task}
            members={members}
            tokens={tokens}
            defaultOwnerId={defaultOwnerId}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TaskForm({
  teamId,
  task,
  members,
  tokens,
  defaultOwnerId,
  onClose,
  onSaved,
}: {
  teamId: string;
  task: Task | null;
  members: Member[];
  tokens: BotTokenSummary[];
  defaultOwnerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const activeTokens = tokens.filter((token) => token.revokedAt == null || token.id === task?.owner.id);
  const [title, setTitle] = useState(task?.title ?? "");
  const [detail, setDetail] = useState(task?.detail ?? "");
  const [action, setAction] = useState<Action>(task?.action ?? "do_now");
  const [waitingOn, setWaitingOn] = useState(task?.waitingOn ?? "");
  const [calendarEventId, setCalendarEventId] = useState(task?.calendarEventId ?? "");
  const [project, setProject] = useState(task?.project ?? "");
  const [dueAt, setDueAt] = useState(toLocalInput(task?.dueAt ?? null));
  const [important, setImportant] = useState(task?.important ?? false);
  const [urgent, setUrgent] = useState(task?.urgent ?? false);
  const [owner, setOwner] = useState(
    task ? ownerKey(task.owner.type, task.owner.id) : ownerKey("user", defaultOwnerId),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsedOwner = parseOwnerKey(owner);
    if (!title.trim()) {
      setError("A task needs a title.");
      return;
    }
    if (action === "delegate" && !waitingOn.trim()) {
      setError("Say who or what this is waiting on.");
      return;
    }
    if (!parsedOwner) {
      setError("Choose an owner.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      title: title.trim(),
      detail: detail.trim() || null,
      action,
      waitingOn: action === "delegate" ? waitingOn.trim() : null,
      ...(action === "schedule" ? { calendarEventId: calendarEventId.trim() || null } : {}),
      project: project.trim() || null,
      dueAt: action === "delegate" && !task && !dueAt ? undefined : fromLocalInput(dueAt),
      important,
      urgent,
      owner: parsedOwner,
    };
    try {
      if (task) await api.updateTask(task.id, body);
      else await api.createTask({ ...body, teamId });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the task.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
      <DialogDescription>
        {task?.status === "done"
          ? "Done tasks stay done. The outcome is kept."
          : "Important and urgent are separate. The queue sorts them for you."}
      </DialogDescription>
      <label className="mt-4 block text-sm">
        Title
        <input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} required />
      </label>
      <label className="mt-3 block text-sm">
        Detail
        <textarea className={fieldClass} rows={3} value={detail} onChange={(event) => setDetail(event.target.value)} />
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Action
          <select className={fieldClass} value={action} onChange={(event) => setAction(event.target.value as Action)}>
            <option value="do_now">Do now</option>
            <option value="delegate">Delegate</option>
            <option value="schedule">Schedule</option>
            <option value="later">Later</option>
          </select>
        </label>
        <label className="text-sm">
          Owner
          <select className={fieldClass} value={owner} onChange={(event) => setOwner(event.target.value)}>
            {members.map((member) => (
              <option key={member.userId} value={ownerKey("user", member.userId)}>
                {member.name}
              </option>
            ))}
            {activeTokens.map((token) => (
              <option key={token.id} value={ownerKey("bot", token.id)}>
                {token.label}
                {token.revokedAt ? " (revoked)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {action === "delegate" ? (
        <label className="mt-3 block text-sm">
          Waiting on
          <input
            className={fieldClass}
            value={waitingOn}
            onChange={(event) => setWaitingOn(event.target.value)}
            placeholder="Who has this, or what you need back"
            required
          />
        </label>
      ) : null}
      {action === "schedule" ? (
        <div className="mt-3">
          <label className="block text-sm">
            Calendar event id
            <input
              className={fieldClass}
              value={calendarEventId}
              onChange={(event) => setCalendarEventId(event.target.value)}
              placeholder="Leave blank if it is not on the calendar yet"
            />
          </label>
          <p className="mt-1 text-xs text-muted">
            {calendarEventId.trim()
              ? "Linked. It leaves the morning queue until the due date."
              : "Needs a calendar. It stays on the morning queue until an event id is saved."}
          </p>
        </div>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Project
          <input className={fieldClass} value={project} onChange={(event) => setProject(event.target.value)} placeholder="Kitchen, Admin…" />
        </label>
        <label className="text-sm">
          {action === "delegate" ? "Follow-up" : "Due"}
          <input className={fieldClass} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </label>
      </div>
      {action === "delegate" ? (
        <p className="mt-1 text-xs text-muted">
          {task
            ? "This is the follow-up. Clear it and the task returns to the morning queue after three days."
            : "This is the follow-up. Leave it blank to nudge you in three days."}
        </p>
      ) : null}
      <div className="mt-3 flex gap-4 text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} />
          Important
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
          Urgent
        </label>
      </div>
      {task?.status === "done" && task.outcome ? (
        <p className="mt-3 text-sm text-moss">Outcome: {task.outcome}</p>
      ) : null}
      {error ? <p className="mt-3 text-sm text-terracotta">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : task ? "Save" : "Add task"}
        </Button>
      </div>
    </form>
  );
}
