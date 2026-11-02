import type { Task, TeamSummary } from "@hearth/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { CompleteDialog } from "@/components/CompleteDialog";
import { GearIcon } from "@/components/Icons";
import { TaskDialog } from "@/components/TaskDialog";
import { TaskRow } from "@/components/TaskRow";
import { actionLabel, actionOf, actions, type Action } from "@/lib/action";
import { ApiError, api } from "@/lib/api";

export function Home() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Action>("do");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ teamId: string; task: Task | null } | null>(null);
  const [completing, setCompleting] = useState<Task | null>(null);

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

  const visible = useMemo(
    () => tasks.filter((task) => task.status === "open" && actionOf(task) === filter).sort(compareTasks),
    [tasks, filter],
  );

  if (!user) return null;

  function openCreate() {
    const teamId = defaultTeamId(teams);
    if (!teamId) {
      setError("Open settings to create a household first.");
      return;
    }
    setEditing({ teamId, task: null });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-black text-white">
      <header className="flex items-center justify-between gap-6 px-8 pt-8">
        <Link to={settingsPath(teams)} aria-label="Settings" className="text-white/70 hover:text-white">
          <GearIcon />
        </Link>
        <button type="button" aria-label="New task" onClick={openCreate} className="text-[18px] leading-none text-white/70 hover:text-white">
          +
        </button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="my-auto flex w-full flex-col items-center px-8 py-16 text-center">
          {!loading && error ? (
            <p className="mb-8 max-w-sm text-[13px] text-white/50">
              {error}{" "}
              <button type="button" className="underline underline-offset-4" onClick={() => void reload()}>
                try again
              </button>
            </p>
          ) : null}
          {!loading && !error && visible.length === 0 ? (
            <p className="text-[15px] text-white/35">{emptyCopy(filter)}</p>
          ) : null}
          {visible.length > 0 ? (
            <ul className="flex w-full max-w-xl flex-col items-center gap-6 sm:gap-8">
              {visible.map((task) => (
                <TaskRow key={task.id} task={task} onOpen={() => setEditing({ teamId: task.teamId, task })} />
              ))}
            </ul>
          ) : null}
        </div>
      </main>

      <footer className="px-4 pb-12 sm:pb-16">
        <nav aria-label="Action" className="flex flex-wrap items-center justify-center text-[10px] uppercase tracking-[0.14em] sm:text-[11px] sm:tracking-[0.18em]">
          {actions.map((action, index) => (
            <span key={action} className="inline-flex items-center">
              {index > 0 ? (
                <span className="px-2.5 text-white/25 sm:px-3" aria-hidden>
                  /
                </span>
              ) : null}
              <button
                type="button"
                aria-pressed={filter === action}
                onClick={() => setFilter(action)}
                className={
                  filter === action
                    ? "uppercase text-white underline decoration-white/80 underline-offset-4"
                    : "uppercase text-white/35 hover:text-white"
                }
              >
                {actionLabel[action]}
              </button>
            </span>
          ))}
        </nav>
      </footer>

      {editing ? (
        <TaskDialog
          open
          teamId={editing.teamId}
          teams={teams}
          task={editing.task}
          defaultOwnerId={user.id}
          defaultAction={filter}
          onClose={() => setEditing(null)}
          onSaved={() => void reload()}
          onComplete={(task) => {
            setEditing(null);
            setCompleting(task);
          }}
        />
      ) : null}
      <CompleteDialog task={completing} onClose={() => setCompleting(null)} onSaved={() => void reload()} />
    </div>
  );
}

function settingsPath(teams: TeamSummary[]) {
  const id = defaultTeamId(teams);
  return id ? `/teams/${id}` : "/settings";
}

function defaultTeamId(teams: TeamSummary[]) {
  return teams.find((team) => team.kind === "household")?.id ?? teams[0]?.id ?? "";
}

function compareTasks(a: Task, b: Task) {
  const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.title.localeCompare(b.title);
}

function emptyCopy(action: Action) {
  if (action === "do") return "Nothing to do now.";
  if (action === "delegate") return "Nothing to delegate.";
  if (action === "schedule") return "Nothing to schedule.";
  return "Nothing for later.";
}
