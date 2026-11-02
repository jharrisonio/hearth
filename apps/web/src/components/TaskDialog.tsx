import type { Action, BotSummary, BotTokenSummary, Member, Task } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel, axesFor } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { fieldClass } from "@/lib/field";
import { fromLocalInput, ownerKey, parseOwnerKey, toLocalInput } from "@/lib/format";

export function TaskDialog({
  open,
  teamId,
  task,
  defaultOwnerId,
  defaultAction,
  onClose,
  onSaved,
  onComplete,
}: {
  open: boolean;
  teamId: string;
  task: Task | null;
  defaultOwnerId: string;
  defaultAction: Action;
  onClose: () => void;
  onSaved: () => void;
  onComplete: (task: Task) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {open ? (
          <TaskForm
            key={task?.id ?? "new"}
            teamId={task?.teamId ?? teamId}
            task={task}
            defaultOwnerId={defaultOwnerId}
            defaultAction={defaultAction}
            onClose={onClose}
            onSaved={onSaved}
            onComplete={onComplete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TaskForm({
  teamId,
  task,
  defaultOwnerId,
  defaultAction,
  onClose,
  onSaved,
  onComplete,
}: {
  teamId: string;
  task: Task | null;
  defaultOwnerId: string;
  defaultAction: Action;
  onClose: () => void;
  onSaved: () => void;
  onComplete: (task: Task) => void;
}) {
  const seeded = task ? { important: task.important, urgent: task.urgent } : axesFor(defaultAction);
  const [members, setMembers] = useState<Member[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [tokens, setTokens] = useState<BotTokenSummary[]>([]);
  const [title, setTitle] = useState(task?.title ?? "");
  const [detail, setDetail] = useState(task?.detail ?? "");
  const [action, setAction] = useState<Action>(task?.action ?? defaultAction);
  const [waitingOn, setWaitingOn] = useState(task?.waitingOn ?? "");
  const [calendarEventId, setCalendarEventId] = useState(task?.calendarEventId ?? "");
  const [project, setProject] = useState(task?.project ?? "");
  const [dueAt, setDueAt] = useState(toLocalInput(task?.dueAt ?? null));
  const [important, setImportant] = useState(seeded.important);
  const [urgent, setUrgent] = useState(seeded.urgent);
  const [owner, setOwner] = useState(task ? ownerKey(task.owner.type, task.owner.id) : ownerKey("user", defaultOwnerId));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activeTokens = tokens.filter((token) => token.revokedAt == null || token.id === task?.owner.id);
  const knownBots = new Set([...bots.map((bot) => bot.id), ...activeTokens.map((token) => token.id)]);
  const unknownBot = task?.owner.type === "bot" && !knownBots.has(task.owner.id) ? task.owner.id : null;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.team(teamId), api.bots(teamId), api.tokens(teamId)])
      .then(([detail, botList, tokenList]) => {
        if (cancelled) return;
        setMembers(detail.members);
        setBots(botList.bots);
        setTokens(tokenList.tokens);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load this list.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

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

  const label = "text-[11px] uppercase tracking-[0.16em] text-white/45";

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <DialogTitle>{task ? "Edit" : "New"}</DialogTitle>
      <DialogDescription className="sr-only">
        Important and urgent choose do now, delegate, schedule, or later.
      </DialogDescription>
      <label className="mt-6 block text-[11px] uppercase tracking-[0.16em] text-white/45">
        Title
        <input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
      </label>
      <div className="mt-6 flex gap-6 text-[13px]">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="accent-white" checked={important} onChange={(event) => setImportant(event.target.checked)} />
          Important
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="accent-white" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
          Urgent
        </label>
      </div>
      <label className={`mt-6 block ${label}`}>
        Action
        <select className={fieldClass} value={action} onChange={(event) => setAction(event.target.value as Action)}>
          <option value="do_now">Do now</option>
          <option value="delegate">Delegate</option>
          <option value="schedule">Schedule</option>
          <option value="later">Later</option>
        </select>
      </label>
      <p className="mt-3 text-[11px] uppercase tracking-[0.18em] text-white/70">{actionLabel[action]}</p>
      {action === "delegate" ? (
        <label className={`mt-6 block ${label}`}>
          Waiting on
          <input className={fieldClass} value={waitingOn} onChange={(event) => setWaitingOn(event.target.value)} required />
        </label>
      ) : null}
      {action === "schedule" ? (
        <label className={`mt-6 block ${label}`}>
          Calendar event id
          <input className={fieldClass} value={calendarEventId} onChange={(event) => setCalendarEventId(event.target.value)} />
        </label>
      ) : null}
      <label className={`mt-6 block ${label}`}>
        {action === "delegate" ? "Follow-up" : "Due"}
        <input className={fieldClass} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
      </label>
      <label className={`mt-6 block ${label}`}>
        Owner
        <select className={fieldClass} value={owner} onChange={(event) => setOwner(event.target.value)}>
          {members.map((member) => (
            <option key={member.userId} value={ownerKey("user", member.userId)}>
              {member.name}
            </option>
          ))}
          {bots.map((bot) => (
            <option key={bot.id} value={ownerKey("bot", bot.id)}>
              {bot.name}
            </option>
          ))}
          {activeTokens.map((token) => (
            <option key={token.id} value={ownerKey("bot", token.id)}>
              {token.label}
              {token.revokedAt ? " (revoked)" : ""}
            </option>
          ))}
          {unknownBot ? <option value={ownerKey("bot", unknownBot)}>Unregistered bot</option> : null}
        </select>
      </label>
      <label className={`mt-6 block ${label}`}>
        Project
        <input className={fieldClass} value={project} onChange={(event) => setProject(event.target.value)} />
      </label>
      <label className={`mt-6 block ${label}`}>
        Detail
        <textarea className={fieldClass} rows={2} value={detail} onChange={(event) => setDetail(event.target.value)} />
      </label>
      {task?.status === "done" && task.outcome ? <p className="mt-6 text-[13px] text-white/60">Outcome: {task.outcome}</p> : null}
      {error ? <p className="mt-4 text-[13px] text-white/70">{error}</p> : null}
      <div className="sticky bottom-0 mt-8 flex items-center justify-between gap-4 bg-black py-4">
        {task && task.status === "open" ? (
          <button type="button" className="text-[13px] text-white/50 hover:text-white" onClick={() => onComplete(task)}>
            Mark done
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-5">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : task ? "Save" : "Add"}
          </Button>
        </div>
      </div>
    </form>
  );
}
