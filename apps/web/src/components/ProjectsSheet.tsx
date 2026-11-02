import { isProjectFront, type Action, type ProjectSummary, type Task } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, hintClass, labelClass, subheadClass } from "@/lib/field";

const frontOrder: Record<Action, number> = { do_now: 0, delegate: 1, schedule: 2, later: 3 };

export function ProjectsSheet({
  open,
  teamId,
  ownerId,
  refreshToken,
  onClose,
  onEditTask,
}: {
  open: boolean;
  teamId: string;
  ownerId: string;
  refreshToken: number;
  onClose: () => void;
  onEditTask: (task: Task) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {open ? (
          <ProjectsBody
            key={teamId}
            teamId={teamId}
            ownerId={ownerId}
            refreshToken={refreshToken}
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
  onEditTask,
}: {
  teamId: string;
  ownerId: string;
  refreshToken: number;
  onEditTask: (task: Task) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
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
        if (!cancelled) setProjects(list.projects);
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
          if (archived.archivedAt && !showArchived) setProjectId(null);
        }}
        onEditTask={onEditTask}
      />
    );
  }

  const visible = showArchived ? projects : projects.filter((item) => !item.archivedAt);

  return (
    <>
      <DialogTitle>Projects</DialogTitle>
      <DialogDescription>Multi-step outcomes. Open one for next actions and later steps.</DialogDescription>
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
              {item.archivedAt ? <span className="ml-3 text-[10px] uppercase tracking-[0.28em] text-[#555]">Archived</span> : null}
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
          {showArchived ? "Hide archived" : "Archived"}
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
      <DialogDescription>Name the outcome. Notes are the plan. Add the steps on the next screen.</DialogDescription>
      <label className={labelClass}>
        Name
        <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
      </label>
      <label className={labelClass}>
        Notes
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<"later" | "next" | null>(null);

  useEffect(() => {
    setName(project.name);
    setNotes(project.notes ?? "");
  }, [project.id, project.name, project.notes]);

  useEffect(() => {
    let cancelled = false;
    void api
      .tasks({ teamId, projectId: project.id, status: "open" })
      .then((list) => {
        if (!cancelled) setTasks(list.tasks);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load steps.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, project.id, refreshToken]);

  const fronts = tasks.filter((task) => isProjectFront(task.action)).sort(byFront);
  const later = tasks.filter((task) => !isProjectFront(task.action)).sort((a, b) => a.title.localeCompare(b.title));
  const dirty = name.trim() !== project.name || (notes.trim() || null) !== (project.notes ?? null);

  async function saveProject(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.updateProject(teamId, project.id, { name: name.trim(), notes: notes.trim() || null });
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
    try {
      for (const [index, title] of titles.entries()) {
        const active = mode === "next" && index === 0;
        await api.createTask({
          teamId,
          title,
          projectId: project.id,
          action: active ? "do_now" : "later",
          important: active,
          urgent: active,
          owner: { type: "user", id: ownerId },
        });
      }
      setDraft("");
      const list = await api.tasks({ teamId, projectId: project.id, status: "open" });
      setTasks(list.tasks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that step.");
      const list = await api.tasks({ teamId, projectId: project.id, status: "open" }).catch(() => null);
      if (list) setTasks(list.tasks);
    } finally {
      setAdding(null);
    }
  }

  async function setArchived(archived: boolean) {
    setError(null);
    try {
      const saved = await api.updateProject(teamId, project.id, { archived });
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
      <DialogTitle>Project</DialogTitle>
      <form onSubmit={(event) => void saveProject(event)}>
        <label className={labelClass}>
          Name
          <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className={labelClass}>
          Notes
          <textarea
            className={cn(fieldClass, "resize-y")}
            rows={4}
            value={notes}
            placeholder="Purpose, outcome, sequence"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <p className={hintClass}>The plan lives here. Steps are the tasks below.</p>
        {dirty ? (
          <div className="mt-6 flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </form>

      <h2 className={subheadClass}>Active</h2>
      <p className={hintClass}>Next actions. Several can be in play. Do now, delegate, and schedule.</p>
      <StepList tasks={fronts} empty="No next action" onOpen={onEditTask} showAction />

      <h2 className={subheadClass}>Later</h2>
      <p className={hintClass}>Future or dependent steps. They stay off the morning list until you open one and change the action.</p>
      <StepList tasks={later} empty="No later steps" onOpen={onEditTask} />

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
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="mt-16">
        <button
          type="button"
          className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
          onClick={() => void setArchived(!project.archivedAt)}
        >
          {project.archivedAt ? "Restore" : "Archive"}
        </button>
      </div>
    </>
  );
}

function StepList({
  tasks,
  empty,
  onOpen,
  showAction = false,
}: {
  tasks: Task[];
  empty: string;
  onOpen: (task: Task) => void;
  showAction?: boolean;
}) {
  if (tasks.length === 0) return <p className="py-3 text-[13px] text-[#666]">{empty}</p>;
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id} className="w-fit max-w-full">
          <button
            type="button"
            onClick={() => onOpen(task)}
            className="group relative block max-w-full py-3 text-left"
          >
            <span className="block text-[18px] font-light leading-snug text-[#d6d6d6] transition-colors duration-200 group-hover:text-white">
              {task.title}
            </span>
            {showAction ? (
              <span className="mt-1 block text-[10px] font-normal uppercase tracking-[0.28em] text-[#5c5c5c]">
                {actionLabel[task.action]}
                {task.action === "delegate" && task.waitingOn ? ` · ${task.waitingOn}` : ""}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function byName(a: ProjectSummary, b: ProjectSummary) {
  return a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt);
}

function byFront(a: Task, b: Task) {
  const diff = frontOrder[a.action] - frontOrder[b.action];
  if (diff !== 0) return diff;
  return a.title.localeCompare(b.title);
}
