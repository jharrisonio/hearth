import type { BotTokenSummary, Lane, Member, Task, TeamSummary } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel, actionOf, axesFor, type Action } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { fieldClass } from "@/lib/field";
import { fromLocalInput, ownerKey, parseOwnerKey, toLocalInput } from "@/lib/format";

export function TaskDialog({
  open,
  teamId,
  teams,
  task,
  defaultOwnerId,
  defaultAction,
  onClose,
  onSaved,
  onComplete,
}: {
  open: boolean;
  teamId: string;
  teams: TeamSummary[];
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
            teams={teams}
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
  teamId: initialTeamId,
  teams,
  task,
  defaultOwnerId,
  defaultAction,
  onClose,
  onSaved,
  onComplete,
}: {
  teamId: string;
  teams: TeamSummary[];
  task: Task | null;
  defaultOwnerId: string;
  defaultAction: Action;
  onClose: () => void;
  onSaved: () => void;
  onComplete: (task: Task) => void;
}) {
  const seeded = task ? { important: task.important, urgent: task.urgent } : axesFor(defaultAction);
  const [teamId, setTeamId] = useState(initialTeamId);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<BotTokenSummary[]>([]);
  const [title, setTitle] = useState(task?.title ?? "");
  const [detail, setDetail] = useState(task?.detail ?? "");
  const [lane, setLane] = useState<Lane>(task?.lane ?? "next");
  const [waitingOn, setWaitingOn] = useState(task?.waitingOn ?? "");
  const [project, setProject] = useState(task?.project ?? "");
  const [dueAt, setDueAt] = useState(toLocalInput(task?.dueAt ?? null));
  const [important, setImportant] = useState(seeded.important);
  const [urgent, setUrgent] = useState(seeded.urgent);
  const [owner, setOwner] = useState(task ? ownerKey(task.owner.type, task.owner.id) : ownerKey("user", defaultOwnerId));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const action = actionOf({ important, urgent });
  const activeTokens = tokens.filter((token) => token.revokedAt == null || token.id === task?.owner.id);
  const teamName = teams.find((item) => item.id === teamId)?.name;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.team(teamId), api.tokens(teamId)])
      .then(([detail, tokenList]) => {
        if (cancelled) return;
        setMembers(detail.members);
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

  const label = "text-[11px] uppercase tracking-[0.16em] text-white/45";

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <DialogTitle>{task ? "Edit" : "New"}</DialogTitle>
      <DialogDescription className="sr-only">
        Important and urgent choose do now, delegate, schedule, or later.
      </DialogDescription>
      {!task && teams.length > 1 ? (
        <label className={`mt-6 block ${label}`}>
          List
          <select
            className={fieldClass}
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setOwner(ownerKey("user", defaultOwnerId));
            }}
          >
            {teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ) : teamName ? (
        <p className="mt-4 text-[13px] text-white/40">{teamName}</p>
      ) : null}
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
      <p className="mt-3 text-[11px] uppercase tracking-[0.18em] text-white/70">{actionLabel[action]}</p>
      <label className={`mt-6 block ${label}`}>
        Due
        <input className={fieldClass} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
      </label>
      <label className={`mt-6 block ${label}`}>
        Lane
        <select className={fieldClass} value={lane} onChange={(event) => setLane(event.target.value as Lane)}>
          <option value="next">Next</option>
          <option value="waiting">Waiting</option>
          <option value="someday">Someday</option>
        </select>
      </label>
      {lane === "waiting" ? (
        <label className={`mt-6 block ${label}`}>
          Waiting on
          <input className={fieldClass} value={waitingOn} onChange={(event) => setWaitingOn(event.target.value)} required />
        </label>
      ) : null}
      <label className={`mt-6 block ${label}`}>
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
