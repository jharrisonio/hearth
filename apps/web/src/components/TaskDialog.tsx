import {
  actions,
  delegateRequiresWaitingOn,
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
  type UpdateTaskInput,
} from "@hearth/shared";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
  layer = "base",
  teamId,
  task,
  defaultOwnerId,
  defaultAction,
  onOpenProject,
  onClose,
  onSaved,
  onComplete,
}: {
  open: boolean;
  layer?: "base" | "front";
  teamId: string;
  task: Task | null;
  defaultOwnerId: string;
  defaultAction: Action;
  onOpenProject: (projectId: string) => void;
  onClose: () => void;
  onSaved: () => void;
  onComplete: (task: Task) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent pinned layer={layer}>
        {open ? (
          <TaskForm
            key={task?.id ?? "new"}
            teamId={task?.teamId ?? teamId}
            task={task}
            defaultOwnerId={defaultOwnerId}
            defaultAction={defaultAction}
            onOpenProject={onOpenProject}
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
  onOpenProject,
  onClose,
  onSaved,
  onComplete,
}: {
  teamId: string;
  task: Task | null;
  defaultOwnerId: string;
  defaultAction: Action;
  onOpenProject: (projectId: string) => void;
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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [cancelling, setCancelling] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const suggested = suggestAction(important, urgent);
  const parsedOwner = parseOwnerKey(owner);
  const waitingRequired = delegateRequiresWaitingOn(action, parsedOwner);
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
            area: null,
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

  const draft = readDraft({
    title,
    detail,
    action,
    waitingOn,
    calendarEventId,
    projectId,
    areaId,
    sourceType,
    sourceHref,
    sourceLabel,
    dueAt,
    important,
    urgent,
    owner,
    existingSource: task?.source ?? null,
  });
  const savedRef = useRef<Draft | null>(null);
  if (savedRef.current === null) savedRef.current = draft;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const taskIdRef = useRef(task?.id ?? null);
  taskIdRef.current = task?.id ?? null;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const skipFlushRef = useRef(false);
  const didSaveRef = useRef(false);
  const mountedRef = useRef(true);
  const chainRef = useRef(Promise.resolve(true));
  const commitRef = useRef<() => Promise<boolean>>(async () => true);

  function selectAction(next: Action) {
    setAction(next);
    if (next === "delegate" && !dueAt) {
      const when = new Date();
      when.setDate(when.getDate() + 3);
      setDueAt(toLocalInput(when.toISOString()));
    }
  }

  async function runSave(): Promise<boolean> {
    const id = taskIdRef.current;
    const saved = savedRef.current;
    if (!id || !saved || skipFlushRef.current) return true;
    const sent = draftRef.current;
    const look = lookAt(saved, sent);
    if (look.blocked || !look.patch) {
      if (mountedRef.current) {
        setSaveState(look.blocked || look.notice || !didSaveRef.current ? "idle" : "saved");
        setError(look.notice);
      }
      return true;
    }
    if (mountedRef.current) {
      setSaveState("saving");
      if (!look.notice) setError(null);
    }
    try {
      await api.updateTask(id, look.patch, !mountedRef.current);
    } catch (err) {
      if (mountedRef.current) {
        setSaveState("idle");
        setError(err instanceof ApiError ? err.message : "Could not save the task.");
      }
      return false;
    }
    savedRef.current = applyDraft(saved, sent, look.patch);
    didSaveRef.current = true;
    onSavedRef.current();
    const next = lookAt(savedRef.current, draftRef.current);
    if (next.patch && !next.blocked && !skipFlushRef.current) return runSave();
    if (mountedRef.current) {
      setSaveState(next.blocked || next.notice ? "idle" : "saved");
      setError(next.notice);
    }
    return true;
  }

  commitRef.current = () => {
    const run = chainRef.current.then(runSave);
    chainRef.current = run.then(
      () => true,
      () => false,
    );
    return run;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void commitRef.current();
    };
  }, []);

  useEffect(() => {
    if (!task) return;
    const flush = () => void commitRef.current();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [task]);

  useEffect(() => {
    if (!task) return;
    const look = lookAt(savedRef.current ?? draftRef.current, draftRef.current);
    if (look.blocked) {
      setSaveState("idle");
      setError(look.notice);
      return;
    }
    if (!look.patch && !look.notice) {
      setSaveState(didSaveRef.current ? "saved" : "idle");
      setError(null);
      return;
    }
    if (look.patch) {
      setSaveState("saving");
      if (!look.notice) setError(null);
    } else {
      setSaveState(didSaveRef.current ? "saved" : "idle");
    }
    const timer = window.setTimeout(() => void commitRef.current(), 500);
    return () => window.clearTimeout(timer);
  }, [
    task,
    title,
    detail,
    action,
    waitingOn,
    calendarEventId,
    projectId,
    areaId,
    sourceType,
    sourceHref,
    sourceLabel,
    dueAt,
    important,
    urgent,
    owner,
  ]);

  async function onCancelTask() {
    if (!task || cancelling) return;
    setCancelling(true);
    setError(null);
    const savedOk = await commitRef.current();
    if (!savedOk) {
      setCancelling(false);
      return;
    }
    try {
      await api.cancelTask(task.id, "cancelled");
      skipFlushRef.current = true;
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel the task.");
      setCancelling(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (task) {
      await commitRef.current();
      return;
    }
    if (saving || cancelling) return;
    if (!draft.title || !draft.owner) {
      setError(draft.title ? "Choose an owner." : "A task needs a title.");
      return;
    }
    if (delegateRequiresWaitingOn(draft.action, draft.owner) && !draft.waitingOn) {
      setError("Say who or what this is waiting on.");
      return;
    }
    if (!draft.sourceReady) {
      setError(draft.sourceNotice ?? "Source needs an http(s) link.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      title: draft.title,
      detail: draft.detail,
      action: draft.action,
      waitingOn: draft.waitingOn,
      ...(draft.action === "schedule" ? { calendarEventId: draft.calendarEventId } : {}),
      projectId: draft.projectId,
      areaId: draft.areaId,
      source: draft.source,
      dueAt: draft.action === "delegate" && !dueAt ? undefined : draft.dueAt,
      important: draft.important,
      urgent: draft.urgent,
      owner: draft.owner,
    };
    try {
      await api.createTask({ ...body, teamId });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the task.");
    } finally {
      setSaving(false);
    }
  }

  const previewHref = isHttpUrl(sourceHref.trim()) ? sourceHref.trim() : null;
  const saveLabel = saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : "";

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void onSubmit(event)}>
      <header className="shrink-0 px-7 pt-[env(safe-area-inset-top)]">
        <div className="flex h-16 items-center">
          <DialogTitle className="mb-0">{task ? "Task" : "New task"}</DialogTitle>
        </div>
      </header>
      <DialogDescription className="sr-only">Important and urgent choose do now, delegate, schedule, or later.</DialogDescription>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-8 pt-4">
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
              required={waitingRequired}
            />
          </label>
          {waitingRequired ? null : <p className={hintClass}>Optional. The bot is the one who acts.</p>}
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
        <ProjectField
          value={projectId}
          options={projects}
          onChange={setProjectId}
          onOpen={onOpenProject}
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
      </div>
      <footer className="relative z-10 shrink-0 bg-black px-7 pb-[calc(26px+env(safe-area-inset-bottom))] pt-6 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-gradient-to-b before:from-transparent before:to-black before:content-['']">
        {error ? <p className="mb-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
        {task && saveLabel ? (
          <p className="mb-4 text-center text-[10px] font-normal uppercase tracking-[0.32em] text-[#5c5c5c]" aria-live="polite">
            {saveLabel}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-x-7 gap-y-4">
          <div className="flex items-center gap-7">
            {task ? (
              <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={cancelling}>
                Delete
              </Button>
            ) : null}
            {task && task.status === "open" ? (
              <Button type="button" variant="ghost" onClick={() => void onCancelTask()} disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-7">
            {task ? null : (
              <Button type="submit" variant="solid" disabled={saving}>
                {saving ? "Saving…" : "Add"}
              </Button>
            )}
            {task && task.status === "open" ? (
              <Button
                type="button"
                variant="solid"
                onClick={() => {
                  void (async () => {
                    const ok = await commitRef.current();
                    onComplete(ok && title.trim() ? { ...task, title: title.trim() } : task);
                  })();
                }}
                disabled={cancelling}
              >
                Complete
              </Button>
            ) : null}
          </div>
        </div>
      </footer>
      <DeleteDialog
        task={confirmingDelete && task ? task : null}
        onClose={() => setConfirmingDelete(false)}
        onDeleted={() => {
          skipFlushRef.current = true;
          onSaved();
          onClose();
        }}
      />
    </form>
  );
}

const SAVE_FIELDS = ["title", "detail", "action", "waitingOn", "calendarEventId", "projectId", "areaId", "source", "dueAt", "important", "urgent", "owner"] as const;

type Draft = {
  title: string;
  detail: string | null;
  action: Action;
  waitingOn: string | null;
  calendarEventId: string | null;
  projectId: string | null;
  areaId: string | null;
  source: TaskSource | null;
  sourceReady: boolean;
  sourceNotice: string | null;
  dueAt: string | null;
  important: boolean;
  urgent: boolean;
  owner: { type: "user" | "bot"; id: string } | null;
};

function readDraft(input: {
  title: string;
  detail: string;
  action: Action;
  waitingOn: string;
  calendarEventId: string;
  projectId: string;
  areaId: string;
  sourceType: SourceType | "";
  sourceHref: string;
  sourceLabel: string;
  dueAt: string;
  important: boolean;
  urgent: boolean;
  owner: string;
  existingSource: TaskSource | null;
}): Draft {
  const href = input.sourceHref.trim();
  const label = input.sourceLabel.trim();
  let source: TaskSource | null = null;
  let sourceReady = true;
  let sourceNotice: string | null = null;
  if (input.sourceType || href || label) {
    if (input.sourceType !== "email" && input.sourceType !== "url") {
      sourceReady = false;
      sourceNotice = "Choose email or link for the source.";
    } else if (!isHttpUrl(href)) {
      sourceReady = false;
      sourceNotice = "Source needs an http(s) link.";
    } else {
      const externalId =
        input.existingSource && input.existingSource.type === input.sourceType && input.existingSource.href === href
          ? input.existingSource.externalId
          : undefined;
      source = {
        type: input.sourceType,
        href,
        ...(label ? { label } : {}),
        ...(externalId ? { externalId } : {}),
      };
    }
  }
  return {
    title: input.title.trim(),
    detail: input.detail.trim() || null,
    action: input.action,
    waitingOn: input.action === "delegate" ? input.waitingOn.trim() || null : null,
    calendarEventId: input.calendarEventId.trim() || null,
    projectId: input.projectId || null,
    areaId: input.areaId || null,
    source,
    sourceReady,
    sourceNotice,
    dueAt: fromLocalInput(input.dueAt),
    important: input.important,
    urgent: input.urgent,
    owner: parseOwnerKey(input.owner),
  };
}

function lookAt(saved: Draft, current: Draft): { patch: UpdateTaskInput | null; notice: string | null; blocked: boolean } {
  if (!current.title) return { patch: null, notice: "A task needs a title.", blocked: true };
  if (!current.owner) return { patch: null, notice: "Choose an owner.", blocked: true };
  const delegateBlocked = delegateRequiresWaitingOn(current.action, current.owner) && !current.waitingOn;
  const delegateDirty = current.action !== saved.action || current.waitingOn !== saved.waitingOn;
  const ownerHeld =
    delegateBlocked &&
    current.owner != null &&
    (saved.owner?.type !== current.owner.type || saved.owner?.id !== current.owner.id);
  let notice: string | null = null;
  if (delegateBlocked && (delegateDirty || ownerHeld)) notice = "Say who or what this is waiting on.";
  else if (!current.sourceReady && current.sourceNotice) notice = current.sourceNotice;
  return { patch: diffDraft(saved, current), notice, blocked: false };
}

function diffDraft(saved: Draft, current: Draft): UpdateTaskInput | null {
  const patch: UpdateTaskInput = {};
  if (current.title !== saved.title) patch.title = current.title;
  if (current.detail !== saved.detail) patch.detail = current.detail;
  if (current.important !== saved.important) patch.important = current.important;
  if (current.urgent !== saved.urgent) patch.urgent = current.urgent;
  if (current.projectId !== saved.projectId) patch.projectId = current.projectId;
  if (current.areaId !== saved.areaId) patch.areaId = current.areaId;
  if (current.dueAt !== saved.dueAt) patch.dueAt = current.dueAt;
  const ownerChanged = Boolean(
    current.owner && (!saved.owner || current.owner.type !== saved.owner.type || current.owner.id !== saved.owner.id),
  );
  const delegateBlocked = delegateRequiresWaitingOn(current.action, current.owner) && !current.waitingOn;
  if (ownerChanged && current.owner && !(delegateBlocked && current.owner.type !== "bot")) {
    patch.owner = current.owner;
  }
  if (!delegateBlocked && (current.action !== saved.action || current.waitingOn !== saved.waitingOn)) {
    patch.action = current.action;
    patch.waitingOn = current.waitingOn;
  }
  const persistedAction = patch.action ?? (delegateBlocked ? saved.action : current.action);
  if (persistedAction === "schedule" && current.calendarEventId !== saved.calendarEventId) {
    patch.calendarEventId = current.calendarEventId;
  }
  if (current.sourceReady && sourceKey(current.source) !== sourceKey(saved.source)) patch.source = current.source;
  return SAVE_FIELDS.some((key) => key in patch) ? patch : null;
}

function applyDraft(saved: Draft, sent: Draft, patch: UpdateTaskInput): Draft {
  return {
    ...saved,
    title: patch.title !== undefined ? sent.title : saved.title,
    detail: patch.detail !== undefined ? sent.detail : saved.detail,
    important: patch.important !== undefined ? sent.important : saved.important,
    urgent: patch.urgent !== undefined ? sent.urgent : saved.urgent,
    projectId: patch.projectId !== undefined ? sent.projectId : saved.projectId,
    areaId: patch.areaId !== undefined ? sent.areaId : saved.areaId,
    dueAt: patch.dueAt !== undefined ? sent.dueAt : saved.dueAt,
    owner: patch.owner !== undefined ? sent.owner : saved.owner,
    action: patch.action !== undefined ? sent.action : saved.action,
    waitingOn: patch.waitingOn !== undefined ? sent.waitingOn : saved.waitingOn,
    calendarEventId: patch.calendarEventId !== undefined ? sent.calendarEventId : saved.calendarEventId,
    source: patch.source !== undefined ? sent.source : saved.source,
    sourceReady: true,
    sourceNotice: null,
  };
}

function sourceKey(source: TaskSource | null) {
  if (!source) return "";
  return JSON.stringify({
    type: source.type,
    href: source.href,
    label: source.label ?? null,
    externalId: source.externalId ?? null,
  });
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

function ProjectField({
  value,
  options,
  onChange,
  onOpen,
  onCreate,
}: {
  value: string;
  options: ProjectSummary[];
  onChange: (id: string) => void;
  onOpen: (projectId: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const selected = options.find((option) => option.id === value) ?? null;
  const needle = query.trim().toLowerCase();
  const matches = options
    .filter((option) => !needle || option.name.toLowerCase().includes(needle))
    .slice(0, 8);
  const exact = needle.length > 0 && options.some((option) => option.name.toLowerCase() === needle);

  async function add() {
    const name = query.trim();
    if (!name || exact) return;
    setAdding(true);
    try {
      await onCreate(name);
      setQuery("");
      setOpen(false);
    } catch {
      // The form already shows the error.
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <span className={labelClass}>Project</span>
      {selected ? (
        <div className="flex items-baseline justify-between gap-4">
          <button
            type="button"
            onClick={() => onOpen(selected.id)}
            className="min-w-0 truncate text-left text-[15px] font-light text-[#eee] underline decoration-[#333] underline-offset-[5px] transition-colors duration-150 hover:decoration-white"
          >
            {selected.name}
          </button>
          <button
            type="button"
            onClick={() => onChange("")}
            className="shrink-0 text-[10px] font-normal uppercase tracking-[0.28em] text-[#8a8a8a] hover:text-white"
          >
            Clear
          </button>
        </div>
      ) : null}
      <input
        className={fieldClass}
        value={query}
        placeholder={selected ? "Change project" : "Search projects"}
        aria-label="Search projects"
        aria-autocomplete="list"
        aria-expanded={open}
        role="combobox"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (matches.length === 1 && matches[0]) {
              onChange(matches[0].id);
              setQuery("");
              setOpen(false);
              return;
            }
            void add();
          }
          if (event.key === "Escape") setOpen(false);
        }}
      />
      {open ? (
        <ul className="mt-1 border-b border-[#1c1c1c]" role="listbox">
          {matches.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                className="block w-full py-2.5 text-left text-[15px] font-light text-[#ccc] transition-colors duration-150 hover:text-white"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.id);
                  setQuery("");
                  setOpen(false);
                }}
              >
                {option.name}
                {option.archivedAt ? <span className="ml-3 text-[10px] uppercase tracking-[0.28em] text-[#555]">Archived</span> : null}
              </button>
            </li>
          ))}
          {needle && !exact ? (
            <li>
              <button
                type="button"
                className="block w-full py-2.5 text-left text-[15px] font-light text-[#8a8a8a] transition-colors duration-150 hover:text-white"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void add()}
                disabled={adding}
              >
                {adding ? "Adding…" : `Add ${query.trim()}`}
              </button>
            </li>
          ) : null}
          {matches.length === 0 && !needle ? <li className="py-2.5 text-[13px] text-[#666]">No projects yet.</li> : null}
        </ul>
      ) : null}
      <p className={hintClass}>Search by name. The name opens that project.</p>
    </div>
  );
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
