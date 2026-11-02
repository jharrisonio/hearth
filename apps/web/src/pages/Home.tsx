import { actions, type Action, type Task, type TeamSummary } from "@hearth/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { CompleteDialog } from "@/components/CompleteDialog";
import { GearIcon, iconButtonClass } from "@/components/Icons";
import { ProjectsSheet } from "@/components/ProjectsSheet";
import { TaskDialog } from "@/components/TaskDialog";
import { TaskRow } from "@/components/TaskRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, labelClass } from "@/lib/field";
import { LIST_KEY } from "@/lib/list";

export function Home() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listId, setListId] = useState<string | null>(() => sessionStorage.getItem(LIST_KEY));
  const [filter, setFilter] = useState<Action>("do_now");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ teamId: string; task: Task | null } | null>(null);
  const [completing, setCompleting] = useState<Task | null>(null);
  const [pickingList, setPickingList] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectFocus, setProjectFocus] = useState<string | null>(null);
  const [cover, setCover] = useState<"task" | "project">("task");
  const [taskRevision, setTaskRevision] = useState(0);
  const [creatingHousehold, setCreatingHousehold] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [{ teams: nextTeams }, { tasks: nextTasks }] = await Promise.all([api.teams(), api.tasks({ status: "open" })]);
      setTeams(nextTeams);
      setTasks(nextTasks);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your lists.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const current = useMemo(() => {
    return teams.find((team) => team.id === listId) ?? teams.find((team) => team.kind === "household") ?? teams[0] ?? null;
  }, [teams, listId]);

  useEffect(() => {
    if (current) sessionStorage.setItem(LIST_KEY, current.id);
  }, [current]);

  const visible = useMemo(
    () =>
      tasks
        .filter((task) => task.teamId === current?.id && task.status === "open" && task.action === filter)
        .sort(compareTasks),
    [tasks, current?.id, filter],
  );

  if (!user) return null;

  function openCreate() {
    if (!current) {
      setError("Open settings to create a household first.");
      return;
    }
    setCover("task");
    setEditing({ teamId: current.id, task: null });
  }

  function openProject(id: string) {
    setProjectFocus(id);
    setProjectsOpen(true);
    setCover("project");
  }

  function openProjects() {
    setProjectFocus(null);
    setProjectsOpen(true);
    setCover("project");
  }

  function chooseList(id: string) {
    setListId(id);
    setPickingList(false);
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-black text-white">
      <header className="sticky top-0 z-20 shrink-0 bg-black px-5 pt-[env(safe-area-inset-top)]">
        <div className="grid h-16 grid-cols-[44px_minmax(0,1fr)_44px] items-center">
          <Link to={current ? `/teams/${current.id}` : "/settings"} aria-label="Settings" className={iconButtonClass}>
            <GearIcon />
          </Link>
          <div className="flex min-w-0 items-center justify-center">
            <button
              type="button"
              className="min-w-0 truncate pl-[0.42em] text-[10px] font-normal uppercase tracking-[0.42em] text-[#e6e6e6] transition-opacity duration-150 hover:text-white active:opacity-40 disabled:opacity-40"
              onClick={() => setPickingList(true)}
              disabled={!current}
            >
              {current?.name ?? ""}
            </button>
            <span className="shrink-0 px-1.5 text-[#2a2a2a] sm:px-2.5" aria-hidden>
              /
            </span>
            <button
              type="button"
              className="shrink-0 pl-[0.28em] text-[10px] font-normal uppercase tracking-[0.28em] text-[#8a8a8a] transition-colors duration-150 hover:text-white active:opacity-40 disabled:opacity-40"
              onClick={openProjects}
              disabled={!current}
            >
              Projects
            </button>
          </div>
          <button type="button" aria-label="New task" onClick={openCreate} className={iconButtonClass}>
            <span aria-hidden className="block -translate-y-px text-[28px] font-extralight leading-none">
              +
            </span>
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[560px] px-7 pb-16 pt-[7vh] sm:pt-[9vh]">
          {loading ? <p className="text-[10px] font-normal uppercase tracking-[0.4em] text-[#4a4a4a]">Loading</p> : null}
          {!loading && error ? (
            <p className="max-w-sm text-[13px] font-light text-white/60">
              {error}{" "}
              <button type="button" className="underline underline-offset-4" onClick={() => void reload()}>
                try again
              </button>
            </p>
          ) : null}
          {!loading && !error && visible.length === 0 ? (
            <p className="text-[10px] font-normal uppercase tracking-[0.4em] text-[#4a4a4a]">Nothing here</p>
          ) : null}
          {visible.length > 0 ? (
            <ul key={`${current?.id ?? "none"}-${filter}`} className="hearth-fade flex w-full flex-col">
              {visible.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onOpen={() => {
                    if (!current) return;
                    setCover("task");
                    setEditing({ teamId: current.id, task });
                  }}
                  onOpenProject={openProject}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </main>

      <footer className="sticky bottom-0 z-10 shrink-0 bg-black px-3 pb-[calc(26px+env(safe-area-inset-bottom))] pt-6 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-gradient-to-b before:from-transparent before:to-black before:content-['']">
        <nav aria-label="Action" className="relative flex flex-nowrap items-center justify-center">
          {actions.map((action, index) => (
            <span key={action} className="inline-flex items-center">
              {index > 0 ? (
                <span className="px-1.5 text-[#2a2a2a] sm:px-2.5" aria-hidden>
                  /
                </span>
              ) : null}
              <button
                type="button"
                aria-pressed={filter === action}
                onClick={() => setFilter(action)}
                className={cn(
                  "relative px-1 py-3 text-[10px] font-normal uppercase tracking-[0.24em] transition-colors duration-200 sm:tracking-[0.38em]",
                  filter === action ? "text-white" : "text-[#4a4a4a] hover:text-[#8a8a8a]",
                )}
              >
                {actionLabel[action]}
                {filter === action ? (
                  <span className="absolute bottom-1.5 left-1 h-px bg-white right-[calc(0.25rem+0.24em)] sm:right-[calc(0.25rem+0.38em)]" />
                ) : null}
              </button>
            </span>
          ))}
        </nav>
      </footer>

      {current ? (
        <ProjectsSheet
          open={projectsOpen}
          layer={editing && cover === "project" ? "front" : "base"}
          teamId={current.id}
          ownerId={user.id}
          refreshToken={taskRevision}
          initialProjectId={projectFocus}
          onClose={() => {
            setProjectsOpen(false);
            setProjectFocus(null);
          }}
          onClearFocus={() => setProjectFocus(null)}
          onEditTask={(task) => {
            setCover("task");
            setEditing({ teamId: current.id, task });
          }}
        />
      ) : null}
      {editing ? (
        <TaskDialog
          open
          layer={projectsOpen && cover === "task" ? "front" : "base"}
          teamId={editing.teamId}
          task={editing.task}
          defaultOwnerId={user.id}
          defaultAction={filter}
          onOpenProject={openProject}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setTaskRevision((revision) => revision + 1);
            void reload();
          }}
          onComplete={(task) => {
            setEditing(null);
            setCompleting(task);
          }}
        />
      ) : null}
      <CompleteDialog task={completing} onClose={() => setCompleting(null)} onSaved={() => void reload()} />
      <ListPicker
        open={pickingList}
        teams={teams}
        currentId={current?.id ?? null}
        onClose={() => setPickingList(false)}
        onChoose={chooseList}
        onProjects={() => {
          setPickingList(false);
          openProjects();
        }}
        onCreate={() => {
          setPickingList(false);
          setCreatingHousehold(true);
        }}
      />
      <HouseholdDialog
        open={creatingHousehold}
        onClose={() => setCreatingHousehold(false)}
        onCreated={(team) => {
          setListId(team.id);
          void reload();
        }}
      />
    </div>
  );
}

function ListPicker({
  open,
  teams,
  currentId,
  onClose,
  onChoose,
  onProjects,
  onCreate,
}: {
  open: boolean;
  teams: TeamSummary[];
  currentId: string | null;
  onClose: () => void;
  onChoose: (id: string) => void;
  onProjects: () => void;
  onCreate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogTitle>Lists</DialogTitle>
        <DialogDescription className="sr-only">Choose the list shown on the main screen.</DialogDescription>
        <ul className="flex flex-col">
          {teams.map((team) => {
            const on = team.id === currentId;
            return (
              <li key={team.id}>
                <button
                  type="button"
                  onClick={() => onChoose(team.id)}
                  className={cn(
                    "py-3.5 text-left text-[24px] font-light transition-colors duration-200",
                    on ? "text-white" : "text-[#555] hover:text-white",
                  )}
                >
                  {on ? <span className="mr-3.5 inline-block h-px w-[18px] bg-white align-middle" /> : null}
                  {team.name}
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="mt-10 py-3.5 text-left text-[24px] font-light text-[#555] transition-colors duration-200 hover:text-white disabled:opacity-40"
          onClick={onProjects}
          disabled={!currentId}
        >
          Projects
        </button>
        <button
          type="button"
          className="mt-8 text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] transition-colors duration-150 hover:text-white"
          onClick={onCreate}
        >
          New household
        </button>
      </DialogContent>
    </Dialog>
  );
}

function HouseholdDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (team: TeamSummary) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.createTeam(name.trim());
      setName("");
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the household.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void onSubmit(event)}>
          <DialogTitle>Household</DialogTitle>
          <DialogDescription>You become the owner. Invite people from settings after they have signed in once.</DialogDescription>
          <label className={labelClass}>
            Name
            <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
          <div className="mt-16 flex items-center justify-end gap-7">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="solid" disabled={saving}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function compareTasks(a: Task, b: Task) {
  const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.title.localeCompare(b.title);
}
