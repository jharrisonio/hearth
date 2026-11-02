import {
  actions,
  isHttpUrl,
  suggestAction,
  type Action,
  type AreaSummary,
  type BotSummary,
  type Member,
  type ProjectSummary,
  type SourceType,
  type Task,
  type TaskLink,
  type TaskSource,
} from "@hearth/shared";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { DeleteDialog } from "@/components/DeleteDialog";
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
  const [ownersLoaded, setOwnersLoaded] = useState(false);
  const [title, setTitle] = useState(task?.title ?? "");
  const [detail, setDetail] = useState(task?.detail ?? "");
  const [action, setAction] = useState<Action>(task?.action ?? defaultAction);
  const [waitingOn, setWaitingOn] = useState(task?.waitingOn ?? "");
  const [calendarEventId, setCalendarEventId] = useState(task?.calendarEventId ?? "");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [projectId, setProjectId] = useState(task?.project?.id ?? "");
  const [areaId, setAreaId] = useState(task?.area?.id ?? "");
  const [sourceType, setSourceType] = useState<SourceType | "">(task?.source?.type ?? "");
  const [sourceHref, setSourceHref] = useState(task?.source?.href ?? "");
  const [sourceLabel, setSourceLabel] = useState(task?.source?.label ?? "");
  const [dueAt, setDueAt] = useState(toLocalInput(task?.dueAt ?? null));
  const [important, setImportant] = useState(seeded.important);
  const [urgent, setUrgent] = useState(seeded.urgent);
  const [owner, setOwner] = useState(task ? ownerKey(task.owner.type, task.owner.id) : ownerKey("user", defaultOwnerId));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busy = saving || cancelling;
  const suggested = suggestAction(important, urgent);
  const ownerChoices = new Set([
    ...members.map((member) => ownerKey("user", member.userId)),
    ...bots.map((bot) => ownerKey("bot", bot.id)),
  ]);
  const keepCurrentOwner = ownersLoaded && task != null && !ownerChoices.has(owner);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.team(teamId), api.bots(teamId), api.projects(teamId), api.areas(teamId)])
      .then(([detailResponse, botList, projectList, areaList]) => {
        if (cancelled) return;
        setMembers(detailResponse.members);
        setBots(botList.bots);
        setProjects(
          withCurrent(projectList.projects, task?.project ?? null, (current) => ({
            id: current.id,
            teamId,
            name: current.name,
            notes: null,
            archivedAt: new Date(0).toISOString(),
            createdAt: current.id,
            updatedAt: current.id,
          })),
        );
        setAreas(
          withCurrent(areaList.areas, task?.area ?? null, (current) => ({
            id: current.id,
            teamId,
            name: current.name,
            archivedAt: new Date(0).toISOString(),
            createdAt: current.id,
            updatedAt: current.id,
          })),
        );
        setOwnersLoaded(true);
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

  async function onCancelTask() {
    if (!task || busy) return;
    setCancelling(true);
    setError(null);
    try {
      await api.cancelTask(task.id, "cancelled");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel the task.");
      setCancelling(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
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
    const source = sourceFromForm();
    if (source === "invalid") return;
    setSaving(true);
    setError(null);
    setConfirmingDelete(false);
    const body = {
      title: title.trim(),
      detail: detail.trim() || null,
      action,
      waitingOn: action === "delegate" ? waitingOn.trim() : null,
      ...(action === "schedule" ? { calendarEventId: calendarEventId.trim() || null } : {}),
      projectId: projectId || null,
      areaId: areaId || null,
      source,
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

  function sourceFromForm(): TaskSource | null | "invalid" {
    const href = sourceHref.trim();
    const label = sourceLabel.trim();
    if (!sourceType && !href && !label) return null;
    if (sourceType !== "email" && sourceType !== "url") {
      setError("Choose email or link for the source.");
      return "invalid";
    }
    if (!isHttpUrl(href)) {
      setError("Source needs an http(s) link.");
      return "invalid";
    }
    const externalId =
      task?.source && task.source.type === sourceType && task.source.href === href ? task.source.externalId : undefined;
    return {
      type: sourceType,
      href,
      ...(label ? { label } : {}),
      ...(externalId ? { externalId } : {}),
    };
  }

  const previewHref = isHttpUrl(sourceHref.trim()) ? sourceHref.trim() : null;

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
          {keepCurrentOwner ? <option value={owner}>Owner</option> : null}
        </select>
      </label>
      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <LinkField
          label="Project"
          hint="A multi-step outcome. Open Projects for the other steps. Future ones stay Later."
          placeholder="e.g. Tara AU returns"
          value={projectId}
          options={projects}
          onChange={setProjectId}
          onCreate={(name) =>
            createLink(name, (next) => api.createProject(teamId, { name: next }), setProjects, setProjectId, setError)
          }
        />
        <LinkField
          label="Area"
          hint="A life or work domain."
          placeholder="e.g. House"
          value={areaId}
          options={areas}
          onChange={setAreaId}
          onCreate={(name) => createLink(name, (next) => api.createArea(teamId, next), setAreas, setAreaId, setError)}
        />
      </div>
      <label className={labelClass}>
        Detail
        <textarea className={cn(fieldClass, "resize-y")} rows={3} value={detail} onChange={(event) => setDetail(event.target.value)} />
      </label>
      <label className={labelClass}>
        Source
        <select
          className={fieldClass}
          value={sourceType}
          onChange={(event) => {
            const next = event.target.value as SourceType | "";
            setSourceType(next);
            if (!next) {
              setSourceHref("");
              setSourceLabel("");
            }
          }}
        >
          <option value="">None</option>
          <option value="email">Email</option>
          <option value="url">Link</option>
        </select>
      </label>
      {sourceType ? (
        <>
          {previewHref ? (
            <a
              href={previewHref}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 inline-block max-w-full truncate text-[15px] font-light normal-case tracking-normal text-[#eee] underline decoration-[#333] underline-offset-[5px] hover:decoration-white"
            >
              {sourceLabel.trim() || (sourceType === "email" ? "Open email" : "Open link")}
            </a>
          ) : null}
          <label className={labelClass}>
            Link
            <input
              className={fieldClass}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder={sourceType === "email" ? "https://mail.google.com/mail/u/0/#all/…" : "https://"}
              value={sourceHref}
              onChange={(event) => setSourceHref(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Label
            <input
              className={fieldClass}
              value={sourceLabel}
              placeholder={sourceType === "email" ? "Subject" : "Name"}
              onChange={(event) => setSourceLabel(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {task && task.status !== "open" && task.outcome ? (
        <p className="mt-6 text-[13px] text-white/60">
          {task.status === "cancelled" ? "Cancelled" : "Outcome"}: {task.outcome}
        </p>
      ) : null}
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="mt-16 flex flex-wrap items-center justify-between gap-x-7 gap-y-4">
        <div className="flex items-center gap-7">
          {task ? (
            <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Delete
            </Button>
          ) : null}
          {task && task.status === "open" ? (
            <Button type="button" variant="ghost" onClick={() => void onCancelTask()} disabled={busy}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-7">
          <Button type="submit" variant={task ? "ghost" : "solid"} disabled={busy}>
            {saving ? "Saving…" : task ? "Save" : "Add"}
          </Button>
          {task && task.status === "open" ? (
            <Button type="button" variant="solid" onClick={() => onComplete(task)} disabled={busy}>
              Complete
            </Button>
          ) : null}
        </div>
      </div>
      <DeleteDialog
        task={confirmingDelete && task ? task : null}
        onClose={() => setConfirmingDelete(false)}
        onDeleted={() => {
          onSaved();
          onClose();
        }}
      />
    </form>
  );
}

function withCurrent<T extends { id: string; name: string }>(
  rows: T[],
  current: TaskLink | null,
  fill: (current: TaskLink) => T,
): T[] {
  if (!current || rows.some((row) => row.id === current.id)) return rows;
  return [...rows, fill(current)];
}

async function createLink<T extends { id: string; name: string }>(
  name: string,
  create: (name: string) => Promise<T>,
  setRows: Dispatch<SetStateAction<T[]>>,
  setId: (id: string) => void,
  setError: (message: string | null) => void,
) {
  try {
    const created = await create(name);
    setRows((rows) => {
      const next = rows.some((row) => row.id === created.id)
        ? rows.map((row) => (row.id === created.id ? created : row))
        : [...rows, created];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    setId(created.id);
    setError(null);
  } catch (err) {
    setError(err instanceof ApiError ? err.message : "Could not add that.");
    throw err;
  }
}

function LinkField({
  label,
  hint,
  placeholder,
  value,
  options,
  onChange,
  onCreate,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  options: { id: string; name: string; archivedAt: string | null }[];
  onChange: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  async function add() {
    const name = draft.trim();
    if (!name) return;
    setAdding(true);
    try {
      await onCreate(name);
      setDraft("");
    } catch {
      // The form already shows the error.
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <label className={labelClass}>
        {label}
        <select className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">None</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
              {option.archivedAt ? " (archived)" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-3">
        <input
          className={fieldClass}
          value={draft}
          placeholder={placeholder}
          aria-label={`New ${label.toLowerCase()}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void add();
            }
          }}
        />
        <Button type="button" onClick={() => void add()} disabled={adding || !draft.trim()}>
          Add
        </Button>
      </div>
      <p className={hintClass}>{hint}</p>
    </div>
  );
}
