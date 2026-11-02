import { actions, suggestAction, type Action, type BotSummary, type BotTokenSummary, type Member, type Task } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel, axesFor } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, hintClass, labelClass } from "@/lib/field";
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
  const suggested = suggestAction(important, urgent);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.team(teamId), api.bots(teamId), api.tokens(teamId)])
      .then(([detailResponse, botList, tokenList]) => {
        if (cancelled) return;
        setMembers(detailResponse.members);
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

  function selectAction(next: Action) {
    setAction(next);
    if (next === "delegate" && !dueAt) {
      const when = new Date();
      when.setDate(when.getDate() + 3);
      setDueAt(toLocalInput(when.toISOString()));
    }
  }

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
      <DialogTitle>{task ? "Task" : "New task"}</DialogTitle>
      <DialogDescription className="sr-only">Important and urgent choose do now, delegate, schedule, or later.</DialogDescription>
      <label className={labelClass}>
        Title
        <input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
      </label>
      <p className={labelClass}>Action</p>
      <div className="flex flex-wrap gap-[22px]" role="group" aria-label="Action">
        {actions.map((item) => {
          const on = item === action;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={on}
              onClick={() => selectAction(item)}
              className={cn(
                "relative py-2.5 text-[10px] font-normal uppercase tracking-[0.32em] transition-colors duration-200",
                on ? "text-white" : "text-[#4a4a4a] hover:text-[#8a8a8a]",
              )}
            >
              {actionLabel[item]}
              {on ? <span className="absolute bottom-1 left-0 right-[0.32em] h-px bg-white" /> : null}
            </button>
          );
        })}
      </div>
      <p className={hintClass}>
        {suggested === action ? (
          "Matches the matrix."
        ) : (
          <>
            Matrix suggests <b className="font-normal text-[#bbb]">{actionLabel[suggested]}</b> — override kept.
          </>
        )}
      </p>
      <div className="mt-[30px] grid grid-cols-2 gap-4">
        <label className="flex items-center gap-2 text-[14px] font-light tracking-normal text-[#ccc] normal-case">
          <input type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} />
          Important
        </label>
        <label className="flex items-center gap-2 text-[14px] font-light tracking-normal text-[#ccc] normal-case">
          <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
          Urgent
        </label>
      </div>
      {action === "delegate" ? (
        <>
          <label className={labelClass}>
            Waiting on
            <input
              className={fieldClass}
              value={waitingOn}
              placeholder="e.g. Naomi, plumber, ATO"
              onChange={(event) => setWaitingOn(event.target.value)}
              required
            />
          </label>
          <label className={labelClass}>
            Follow up
            <input className={fieldClass} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          </label>
          <p className={hintClass}>Defaults to +3 days when delegated.</p>
        </>
      ) : null}
      {action === "schedule" ? (
        <>
          <label className={labelClass}>
            When
            <input className={fieldClass} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          </label>
          <label className={labelClass}>
            Calendar event
            <input className={fieldClass} value={calendarEventId} onChange={(event) => setCalendarEventId(event.target.value)} />
          </label>
          {task?.needsCalendar ? <p className={hintClass}>Needs a calendar.</p> : null}
        </>
      ) : null}
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <label className={labelClass}>
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
        <label className={labelClass}>
          Project
          <input className={fieldClass} value={project} placeholder="e.g. Jean St" onChange={(event) => setProject(event.target.value)} />
        </label>
      </div>
      <label className={labelClass}>
        Detail
        <textarea className={cn(fieldClass, "resize-y")} rows={3} value={detail} onChange={(event) => setDetail(event.target.value)} />
      </label>
      {task?.status === "done" && task.outcome ? <p className="mt-6 text-[13px] text-white/60">Outcome: {task.outcome}</p> : null}
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="mt-16 flex items-center justify-end gap-7">
        <Button type="submit" variant={task ? "ghost" : "solid"} disabled={saving}>
          {saving ? "Saving…" : task ? "Save" : "Add"}
        </Button>
        {task && task.status === "open" ? (
          <Button type="button" variant="solid" onClick={() => onComplete(task)}>
            Complete
          </Button>
        ) : null}
      </div>
    </form>
  );
}
