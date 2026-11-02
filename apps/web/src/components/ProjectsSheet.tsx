import { isProjectFront, type AreaSummary, type ProjectSummary, type Task } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, hintClass, labelClass, subheadClass } from "@/lib/field";


export function ProjectsSheet({
  open,
  layer = "base",
  teamId,
  ownerId,
  refreshToken,
  initialProjectId = null,
  onClose,
  onClearFocus,
  onEditTask,
}: {
  open: boolean;
  layer?: "base" | "front";
  teamId: string;
  ownerId: string;
  refreshToken: number;
  initialProjectId?: string | null;
  onClose: () => void;
  onClearFocus: () => void;
  onEditTask: (task: Task) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent layer={layer}>
        {open ? (
          <ProjectsBody
            key={teamId}
            teamId={teamId}
            ownerId={ownerId}
            refreshToken={refreshToken}
            initialProjectId={initialProjectId}
            onClearFocus={onClearFocus}
            onEditTask={onEditTask}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ProjectsBody({
  teamId,
  ownerId,
  refreshToken,
  initialProjectId,
  onClearFocus,
  onEditTask,
}: {
  teamId: string;
  ownerId: string;
  refreshToken: number;
  initialProjectId: string | null;
  onClearFocus: () => void;
  onEditTask: (task: Task) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProjects(includeArchived = showArchived) {
    const list = await api.projects(teamId, includeArchived);
    setProjects(list.projects);
    return list.projects;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .projects(teamId, false)
      .then((list) => {
        if (cancelled) return;
        setProjects((current) => {
          const extras = current.filter((item) => item.archivedAt && !list.projects.some((row) => row.id === item.id));
          return [...list.projects, ...extras].sort(byName);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load projects.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  useEffect(() => {
    if (!initialProjectId) return;
    setProjectId(initialProjectId);
    setCreating(false);
    let cancelled = false;
    void api
      .projects(teamId, true)
      .then((list) => {
        if (cancelled) return;
        const target = list.projects.find((item) => item.id === initialProjectId);
        if (!target) {
          setError("That project is not on this list.");
          return;
        }
        setProjects((rows) => {
          const next = rows.some((row) => row.id === target.id)
            ? rows.map((row) => (row.id === target.id ? target : row))
            : [...rows, target];
          return next.sort(byName);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load that project.");
      });
    return () => {
      cancelled = true;
    };
  }, [initialProjectId, teamId]);

  const project = projects.find((item) => item.id === projectId) ?? null;

  if (creating) {
    return (
      <CreateProject
        teamId={teamId}
        onCancel={() => {
          setCreating(false);
          setError(null);
        }}
        onCreated={(created) => {
          setProjects((rows) => [...rows.filter((row) => row.id !== created.id), created].sort(byName));
          setCreating(false);
          setProjectId(created.id);
          setError(null);
        }}
      />
    );
  }

  if (project) {
    return (
      <ProjectDetail
        teamId={teamId}
        ownerId={ownerId}
        project={project}
        refreshToken={refreshToken}
        onBack={() => {
          onClearFocus();
          setProjectId(null);
          setError(null);
        }}
        onSaved={(next) => {
          setProjects((rows) => rows.map((row) => (row.id === next.id ? next : row)).sort(byName));
        }}
        onArchived={(archived) => {
          setProjects((rows) =>
            showArchived ? rows.map((row) => (row.id === archived.id ? archived : row)) : rows.filter((row) => row.id !== archived.id),
          );
          if (archived.archivedAt && !showArchived) {
            onClearFocus();
            setProjectId(null);
          }
        }}
        onEditTask={onEditTask}
      />
    );
  }

  if (projectId) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            onClearFocus();
            setProjectId(null);
            setError(null);
          }}
          className="mb-8 text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
        >
          All projects
        </button>
        <DialogTitle>Project</DialogTitle>
        {loading || !error ? <p className="text-[10px] uppercase tracking-[0.4em] text-[#4a4a4a]">Loading</p> : null}
        {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      </>
    );
  }

  const visible = showArchived ? projects : projects.filter((item) => !item.archivedAt);

  return (
    <>
      <DialogTitle>Projects</DialogTitle>
      <DialogDescription>Open outcomes. Completed projects stay off this list.</DialogDescription>
      {loading ? <p className="text-[10px] uppercase tracking-[0.4em] text-[#4a4a4a]">Loading</p> : null}
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      {!loading && visible.length === 0 ? <p className="mt-10 text-[13px] text-[#666]">No projects yet.</p> : null}
      <ul className="mt-6 flex flex-col">
        {visible.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => {
                setProjectId(item.id);
                setError(null);
              }}
              className={cn(
                "py-3.5 text-left text-[24px] font-light transition-colors duration-200 hover:text-white",
                item.archivedAt ? "text-[#555]" : "text-[#d6d6d6]",
              )}
            >
              {item.name}
              {item.archivedAt ? <span className="ml-3 text-[10px] uppercase tracking-[0.28em] text-[#555]">Completed</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-16 flex items-center justify-between gap-6">
        <button
          type="button"
          className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] transition-colors duration-150 hover:text-white"
          onClick={() => {
            const next = !showArchived;
            setShowArchived(next);
            setError(null);
            void loadProjects(next).catch((err: unknown) => {
              setError(err instanceof ApiError ? err.message : "Could not load projects.");
            });
          }}
        >
          {showArchived ? "Hide completed" : "Completed"}
        </button>
        <button
          type="button"
          className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] transition-colors duration-150 hover:text-white"
          onClick={() => {
            setCreating(true);
            setError(null);
          }}
        >
          New project
        </button>
      </div>
    </>
  );
}

function CreateProject({
  teamId,
  onCancel,
  onCreated,
}: {
  teamId: string;
  onCancel: () => void;
  onCreated: (project: ProjectSummary) => void;
}) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const plan = notes.trim();
      const created = await api.createProject(teamId, { name: name.trim(), ...(plan ? { notes: plan } : {}) });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <button
        type="button"
        onClick={onCancel}
        className="mb-8 text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
      >
        All projects
      </button>
      <DialogTitle>New project</DialogTitle>
      <DialogDescription>Name the outcome. Support notes are the plan. Add the steps on the next screen.</DialogDescription>
      <label className={labelClass}>
        Outcome
        <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
      </label>
      <label className={labelClass}>
        Support
        <textarea className={cn(fieldClass, "resize-y")} rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="mt-16 flex items-center justify-end gap-7">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="solid" disabled={saving}>
          {saving ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function ProjectDetail({
  teamId,
  ownerId,
  project,
  refreshToken,
  onBack,
  onSaved,
  onArchived,
  onEditTask,
}: {
  teamId: string;
  ownerId: string;
  project: ProjectSummary;
  refreshToken: number;
  onBack: () => void;
  onSaved: (project: ProjectSummary) => void;
  onArchived: (project: ProjectSummary) => void;
  onEditTask: (task: Task) => void;
}) {
  const [name, setName] = useState(project.name);
  const [notes, setNotes] = useState(project.notes ?? "");
  const [areaId, setAreaId] = useState(project.area?.id ?? "");
  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<"later" | "next" | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    setName(project.name);
    setNotes(project.notes ?? "");
    setAreaId(project.area?.id ?? "");
  }, [project.id, project.name, project.notes, project.area?.id]);

  useEffect(() => {
    let cancelled = false;
    void api
      .areas(teamId)
      .then((list) => {
        if (cancelled) return;
        const rows = list.areas;
        if (project.area && !rows.some((area) => area.id === project.area?.id)) {
          setAreas([
            ...rows,
            {
              id: project.area.id,
              teamId,
              name: project.area.name,
              archivedAt: new Date(0).toISOString(),
              createdAt: project.area.id,
              updatedAt: project.area.id,
            },
          ]);
          return;
        }
        setAreas(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load areas.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, project.area?.id, project.area?.name]);

  async function loadTasks() {
    const list = await api.tasks({ teamId, projectId: project.id });
    setTasks(list.tasks);
    return list.tasks;
  }

  useEffect(() => {
    let cancelled = false;
    void loadTasks()
      .then((list) => {
        if (cancelled) return;
        setTasks(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load steps.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, project.id, refreshToken]);

  const open = tasks.filter((task) => task.status === "open");
  const fronts = open.filter((task) => isProjectFront(task.action)).sort(byStep);
  const later = open.filter((task) => !isProjectFront(task.action)).sort(byStep);
  const done = tasks.filter((task) => task.status === "done").sort((a, b) => byWhen(a, b, "completedAt"));
  const cancelled = tasks.filter((task) => task.status === "cancelled").sort((a, b) => byWhen(a, b, "cancelledAt"));
  const dirty =
    name.trim() !== project.name ||
    (notes.trim() || null) !== (project.notes ?? null) ||
    (areaId || null) !== (project.area?.id ?? null);

  async function saveProject(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.updateProject(teamId, project.id, {
        name: name.trim(),
        notes: notes.trim() || null,
        areaId: areaId || null,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the project.");
    } finally {
      setSaving(false);
    }
  }

  async function addSteps(mode: "later" | "next") {
    const titles = draft
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (titles.length === 0) return;
    if (titles.some((title) => title.length > 200)) {
      setError("Each step title needs to be 200 characters or fewer.");
      return;
    }
    setAdding(mode);
    setError(null);
    const area = areaId || null;
    try {
      let activeAt = nextOrder(fronts);
      let laterAt = nextOrder(later);
      for (const [index, title] of titles.entries()) {
        const active = mode === "next" && index === 0;
        await api.createTask({
          teamId,
          title,
          projectId: project.id,
          areaId: area,
          action: active ? "do_now" : "later",
          important: active,
          urgent: active,
          sortOrder: active ? activeAt : laterAt,
          owner: { type: "user", id: ownerId },
        });
        if (active) activeAt += 1;
        else laterAt += 1;
      }
      setDraft("");
      await loadTasks();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that step.");
      await loadTasks().catch(() => undefined);
    } finally {
      setAdding(null);
    }
  }

  async function reorder(list: Task[], index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (moving || nextIndex < 0 || nextIndex >= list.length) return;
    const next = list.slice();
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(nextIndex, 0, item);
    setMoving(true);
    setError(null);
    try {
      await Promise.all(
        next.flatMap((task, order) => (task.sortOrder === order ? [] : [api.updateTask(task.id, { sortOrder: order })])),
      );
      await loadTasks();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reorder that step.");
      await loadTasks().catch(() => undefined);
    } finally {
      setMoving(false);
    }
  }

  async function moveAction(task: Task, destination: "active" | "later") {
    if (moving) return;
    setMoving(true);
    setError(null);
    try {
      await api.updateTask(task.id, {
        action: destination === "active" ? "do_now" : "later",
        sortOrder: nextOrder(destination === "active" ? fronts : later),
      });
      await loadTasks();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move that step.");
    } finally {
      setMoving(false);
    }
  }

  async function completeProject() {
    setError(null);
    try {
      const saved = await api.updateProject(teamId, project.id, { archived: !project.archivedAt });
      onSaved(saved);
      onArchived(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the project.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="mb-8 text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
      >
        All projects
      </button>
      <DialogTitle>{project.archivedAt ? "Completed" : "Project"}</DialogTitle>
      <form onSubmit={(event) => void saveProject(event)}>
        <label className={labelClass}>
          Outcome
          <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className={labelClass}>
          Area
          <select className={fieldClass} value={areaId} onChange={(event) => setAreaId(event.target.value)}>
            <option value="">None</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
                {area.archivedAt ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>

        <h2 className={subheadClass}>Active</h2>
        <p className={hintClass}>Next actions, in order. Several can be in play. Do now, delegate, and schedule.</p>
        <StepList
          tasks={fronts}
          empty="No next action"
          moving={moving}
          onOpen={onEditTask}
          onMove={reorder}
          parkLabel="Later"
          onPark={(task) => void moveAction(task, "later")}
          showAction
        />

        <h2 className={subheadClass}>Later</h2>
        <p className={hintClass}>Future steps, in order. Do now brings one onto the active list.</p>
        <StepList
          tasks={later}
          empty="No later steps"
          moving={moving}
          onOpen={onEditTask}
          onMove={reorder}
          parkLabel="Do now"
          onPark={(task) => void moveAction(task, "active")}
        />

        <label className={labelClass}>
          Support
          <textarea
            className={cn(fieldClass, "resize-y")}
            rows={4}
            value={notes}
            placeholder="Purpose, sequence, constraints"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <p className={hintClass}>Notes for this project. Not a step.</p>
        {dirty ? (
          <div className="mt-6 flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </form>

      <label className={labelClass}>
        Add steps
        <textarea
          className={cn(fieldClass, "resize-y")}
          rows={3}
          value={draft}
          placeholder={"One step per line"}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <p className={hintClass}>
        Next action marks the first line Do now and leaves the rest Later. Later keeps every line off the morning list.
      </p>
      <div className="mt-6 flex items-center justify-end gap-7">
        <Button type="button" onClick={() => void addSteps("later")} disabled={adding !== null || !draft.trim()}>
          {adding === "later" ? "Adding…" : "Later"}
        </Button>
        <Button type="button" variant="solid" onClick={() => void addSteps("next")} disabled={adding !== null || !draft.trim()}>
          {adding === "next" ? "Adding…" : "Next action"}
        </Button>
      </div>

      <h2 className={subheadClass}>Done</h2>
      <HistoryList tasks={done} empty="Nothing done" onOpen={onEditTask} />
      <h2 className={subheadClass}>Cancelled</h2>
      <HistoryList tasks={cancelled} empty="Nothing cancelled" onOpen={onEditTask} />

      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="mt-16">
        <button
          type="button"
          className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
          onClick={() => void completeProject()}
        >
          {project.archivedAt ? "Restore" : "Complete"}
        </button>
        {project.archivedAt ? null : (
          <p className={hintClass}>Hides the project from the open list. Open tasks have to be finished or cancelled first.</p>
        )}
      </div>
    </>
  );
}

function StepList({
  tasks,
  empty,
  moving,
  onOpen,
  onMove,
  parkLabel,
  onPark,
  showAction = false,
}: {
  tasks: Task[];
  empty: string;
  moving: boolean;
  onOpen: (task: Task) => void;
  onMove: (list: Task[], index: number, direction: -1 | 1) => void;
  parkLabel: string;
  onPark: (task: Task) => void;
  showAction?: boolean;
}) {
  if (tasks.length === 0) return <p className="py-3 text-[13px] text-[#666]">{empty}</p>;
  return (
    <ul>
      {tasks.map((task, index) => (
        <li key={task.id} className="border-b border-[#1c1c1c] py-3">
          <button type="button" onClick={() => onOpen(task)} className="block max-w-full text-left">
            <span className="block text-[18px] font-light leading-snug text-[#d6d6d6] transition-colors duration-200 hover:text-white">
              {task.title}
            </span>
            {showAction ? (
              <span className="mt-1 block text-[10px] font-normal uppercase tracking-[0.28em] text-[#5c5c5c]">
                {actionLabel[task.action]}
                {task.action === "delegate" && task.waitingOn ? ` · ${task.waitingOn}` : ""}
              </span>
            ) : null}
          </button>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            <StepControl disabled={moving || index === 0} onClick={() => onMove(tasks, index, -1)}>
              Up
            </StepControl>
            <StepControl disabled={moving || index === tasks.length - 1} onClick={() => onMove(tasks, index, 1)}>
              Down
            </StepControl>
            <StepControl disabled={moving} onClick={() => onPark(task)}>
              {parkLabel}
            </StepControl>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HistoryList({ tasks, empty, onOpen }: { tasks: Task[]; empty: string; onOpen: (task: Task) => void }) {
  if (tasks.length === 0) return <p className="py-3 text-[13px] text-[#666]">{empty}</p>;
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id} className="border-b border-[#1c1c1c] py-3">
          <button type="button" onClick={() => onOpen(task)} className="block max-w-full text-left">
            <span className="block text-[18px] font-light leading-snug text-[#8a8a8a] transition-colors duration-200 hover:text-white">
              {task.title}
            </span>
            {task.outcome ? <span className="mt-1 block text-[13px] font-light text-[#5c5c5c]">{task.outcome}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function StepControl({
  children,
  disabled,
  onClick,
}: {
  children: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="text-[10px] font-normal uppercase tracking-[0.28em] text-[#8a8a8a] transition-colors duration-150 hover:text-white disabled:text-[#333]"
    >
      {children}
    </button>
  );
}

function byName(a: ProjectSummary, b: ProjectSummary) {
  return a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt);
}

function byStep(a: Task, b: Task) {
  const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  const created = a.createdAt.localeCompare(b.createdAt);
  if (created !== 0) return created;
  return a.title.localeCompare(b.title);
}

function byWhen(a: Task, b: Task, field: "completedAt" | "cancelledAt") {
  return (b[field] ?? "").localeCompare(a[field] ?? "") || a.title.localeCompare(b.title);
}

function nextOrder(tasks: Task[]) {
  return tasks.reduce((max, task) => Math.max(max, task.sortOrder ?? -1), -1) + 1;
}
