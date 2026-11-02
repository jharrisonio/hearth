import type { BotTokenSummary, Lane, Member, Task } from "@hearth/shared";
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
  const [lane, setLane] = useState<Lane>(task?.lane ?? "next");
  const [waitingOn, setWaitingOn] = useState(task?.waitingOn ?? "");
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
    if (lane === "waiting" && !waitingOn.trim()) {
      setError("Say what this is waiting on.");
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
      lane,
      waitingOn: lane === "waiting" ? waitingOn.trim() : null,
      project: project.trim() || null,
      dueAt: fromLocalInput(dueAt),
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
          Lane
          <select className={fieldClass} value={lane} onChange={(event) => setLane(event.target.value as Lane)}>
            <option value="next">Next</option>
            <option value="waiting">Waiting</option>
            <option value="someday">Someday</option>
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
      {lane === "waiting" ? (
        <label className="mt-3 block text-sm">
          Waiting on
          <input className={fieldClass} value={waitingOn} onChange={(event) => setWaitingOn(event.target.value)} required />
        </label>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Project
          <input className={fieldClass} value={project} onChange={(event) => setProject(event.target.value)} placeholder="Kitchen, Admin…" />
        </label>
        <label className="text-sm">
          Due
          <input className={fieldClass} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </label>
      </div>
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
