import {
  calendarHref,
  delegateRequiresWaitingOn,
  isHttpUrl,
  needsCheckIn,
  scheduleRequiresDueAt,
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
import { CatalogPicker } from "@/components/CatalogPicker";
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
      <DialogContent
        pinned
        layer={layer}
        onPointerDownOutside={keepCatalogOpen}
        onFocusOutside={keepCatalogOpen}
        onInteractOutside={keepCatalogOpen}
      >
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
    const axes = axesFor(next);
    setAction(next);
    setImportant(axes.important);
    setUrgent(axes.urgent);
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
    if (scheduleRequiresDueAt(draft.action, draft.calendarEventId, draft.dueAt)) {
      setError("Set when. That time is the check-in.");
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
  const calendarLink = action === "schedule" ? calendarHref(calendarEventId) : null;
  const showCheckIn =
    task?.status === "open" &&
    action === "schedule" &&
    needsCheckIn({ status: "open", action, dueAt: fromLocalInput(dueAt) });
  const saveLabel = saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : "";

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void onSubmit(event)}>
      <header className="shrink-0 px-7 pt-[env(safe-area-inset-top)]">
        <div className="flex h-16 items-center">
          <DialogTitle className="mb-0">{task ? "Task" : "New task"}</DialogTitle>
        </div>
      </header>
      <DialogDescription className="sr-only">
        Set the action on the matrix. Important and urgent are the axis titles.
      </DialogDescription>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-8 pt-4">
      <label className={labelClass}>
        Title
        <input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
      </label>
      <ActionMatrix action={action} onSelect={selectAction} />
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
            Calendar
            <input
              className={fieldClass}
              value={calendarEventId}
              placeholder="Google Calendar link or event id"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setCalendarEventId(event.target.value)}
            />
          </label>
          {calendarLink ? (
            <a
              href={calendarLink}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 inline-block max-w-full truncate text-[15px] font-light normal-case tracking-normal text-[#eee] underline decoration-[#333] underline-offset-[5px] hover:decoration-white"
            >
              Open calendar
            </a>
          ) : (
            <p className={hintClass}>Needs a calendar.</p>
          )}
          {showCheckIn ? <p className={hintClass}>Check in. Complete, cancel, or set a new time.</p> : null}
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
      <CatalogPicker
        label="Project"
        emptyLabel="No project"
        placeholder="Search projects"
        emptyList="No projects yet."
        value={projectId}
        options={projects}
        onChange={setProjectId}
        onOpen={onOpenProject}
        onCreate={(name) =>
          createLink(name, (next) => api.createProject(teamId, { name: next }), setProjects, setProjectId, setError)
        }
      />
      <CatalogPicker
        label="Area"
        emptyLabel="No area"
        placeholder="Search areas"
        emptyList="No areas yet."
        hint="A life or work domain."
        value={areaId}
        options={areas}
        onChange={setAreaId}
        onCreate={(name) => createLink(name, (next) => api.createArea(teamId, next), setAreas, setAreaId, setError)}
      />
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
        <p className="mt-6 text-[13px] text-[#a8a8a8]">
          {task.status === "cancelled" ? "Cancelled" : "Outcome"}: {task.outcome}
        </p>
      ) : null}
      </div>
      <footer className="relative z-10 shrink-0 bg-black px-7 pb-[calc(26px+env(safe-area-inset-bottom))] pt-6 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-gradient-to-b before:from-transparent before:to-black before:content-['']">
        {error ? <p className="mb-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
        {task && saveLabel ? (
          <p className="mb-4 text-center text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8]" aria-live="polite">
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
  else if (scheduleRequiresDueAt(current.action, current.calendarEventId, current.dueAt)) {
    notice = "Set when. That time is the check-in.";
  }
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
  const ownerChanged = Boolean(
    current.owner && (!saved.owner || current.owner.type !== saved.owner.type || current.owner.id !== saved.owner.id),
  );
  const delegateBlocked = delegateRequiresWaitingOn(current.action, current.owner) && !current.waitingOn;
  const nextAction = delegateBlocked ? saved.action : current.action;
  const nextCalendar = nextAction === "schedule" ? current.calendarEventId : saved.calendarEventId;
  const holdCalendar = scheduleRequiresDueAt(nextAction, nextCalendar, current.dueAt);
  if (ownerChanged && current.owner && !(delegateBlocked && current.owner.type !== "bot")) {
    patch.owner = current.owner;
  }
  if (!delegateBlocked && !holdCalendar && (current.action !== saved.action || current.waitingOn !== saved.waitingOn)) {
    patch.action = current.action;
    patch.waitingOn = current.waitingOn;
  }
  if (!holdCalendar && current.dueAt !== saved.dueAt) patch.dueAt = current.dueAt;
  if (!holdCalendar && nextAction === "schedule" && current.calendarEventId !== saved.calendarEventId) {
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

const matrixRows: readonly (readonly Action[])[] = [
  ["do_now", "schedule"],
  ["delegate", "later"],
];

const matrixCue: Record<Action, string> = {
  do_now: "Important and urgent",
  delegate: "Urgent",
  schedule: "Important",
  later: "Neither",
};

function ActionMatrix({ action, onSelect }: { action: Action; onSelect: (next: Action) => void }) {
  return (
    <div>
      <p className={labelClass}>Action</p>
      <div role="group" aria-label="Action" className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5">
        <div />
        <div className="grid grid-cols-2">
          <p className="pb-2 text-center text-[9.5px] font-normal uppercase tracking-[0.28em] text-[#a8a8a8]">Urgent</p>
          <div />
        </div>
        <div className="flex h-[5.25rem] items-center justify-center self-start">
          <span className="whitespace-nowrap text-[8px] font-normal uppercase leading-none tracking-[0.12em] text-[#a8a8a8] [writing-mode:vertical-rl] rotate-180">
            Important
          </span>
        </div>
        <div className="grid grid-cols-2 gap-px border border-[#3a3a3a] bg-[#3a3a3a]">
          {matrixRows.flat().map((item) => {
            const on = item === action;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={on}
                aria-label={`${actionLabel[item]}. ${matrixCue[item]}`}
                onClick={() => onSelect(item)}
                className={cn(
                  "flex min-h-[5.25rem] items-center justify-center px-2 py-4 text-center text-[10px] font-normal uppercase tracking-[0.16em] transition-colors duration-200 sm:tracking-[0.26em]",
                  on ? "bg-white text-black!" : "bg-black text-[#a8a8a8] hover:text-white",
                )}
              >
                {actionLabel[item]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function keepCatalogOpen(event: { target: EventTarget | null; preventDefault: () => void }) {
  if (event.target instanceof Element && event.target.closest("[data-catalog-popover]")) event.preventDefault();
}
