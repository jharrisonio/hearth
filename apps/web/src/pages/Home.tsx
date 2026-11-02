import { actions, type Action, type Task, type TeamSummary } from "@hearth/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { CompleteDialog } from "@/components/CompleteDialog";
import { GearIcon } from "@/components/Icons";
import { TaskDialog } from "@/components/TaskDialog";
import { TaskRow } from "@/components/TaskRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { actionLabel } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { fieldClass } from "@/lib/field";

const LIST_KEY = "hearth-list";

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
    setEditing({ teamId: current.id, task: null });
  }

  function chooseList(id: string) {
    setListId(id);
    setPickingList(false);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-black text-white">
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-8 pt-8">
        <Link
          to={current ? `/teams/${current.id}` : "/settings"}
          aria-label="Settings"
          className="text-white/70 hover:text-white"
        >
          <GearIcon />
        </Link>
        <button
          type="button"
          className="truncate text-center text-[15px] hover:underline disabled:opacity-40"
          onClick={() => setPickingList(true)}
          disabled={!current}
        >
          {current?.name ?? ""}
        </button>
        <button
          type="button"
          aria-label="New task"
          onClick={openCreate}
          className="text-[18px] leading-none text-white/70 hover:text-white"
        >
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
                <TaskRow key={task.id} task={task} onOpen={() => current && setEditing({ teamId: current.id, task })} />
              ))}
            </ul>
          ) : null}
        </div>
      </main>

      <footer className="sticky bottom-0 z-10 bg-black px-4 pb-8 pt-6 sm:pb-10">
        <nav
          aria-label="Action"
          className="flex flex-wrap items-center justify-center text-[10px] uppercase tracking-[0.14em] sm:text-[11px] sm:tracking-[0.18em]"
        >
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
      <ListPicker
        open={pickingList}
        teams={teams}
        currentId={current?.id ?? null}
        onClose={() => setPickingList(false)}
        onChoose={chooseList}
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
  onCreate,
}: {
  open: boolean;
  teams: TeamSummary[];
  currentId: string | null;
  onClose: () => void;
  onChoose: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogTitle className="sr-only">Lists</DialogTitle>
        <DialogDescription className="sr-only">Choose the list shown on the main screen.</DialogDescription>
        <ul className="flex flex-col items-center gap-8 pt-8 text-center">
          {teams.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                onClick={() => onChoose(team.id)}
                className={team.id === currentId ? "text-[15px] text-white" : "text-[15px] text-white/40 hover:text-white"}
              >
                {team.name}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="mt-16 block w-full text-center text-[13px] text-white/50 hover:text-white" onClick={onCreate}>
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
          <DialogDescription>You become the owner. Invite people from the list after they have signed in once.</DialogDescription>
          <label className="mt-6 block text-[11px] uppercase tracking-[0.16em] text-white/45">
            Name
            <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          {error ? <p className="mt-4 text-[13px] text-white/70">{error}</p> : null}
          <div className="mt-8 flex justify-end gap-5">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
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

function emptyCopy(action: Action) {
  if (action === "do_now") return "Nothing to do now.";
  if (action === "delegate") return "Nothing to delegate.";
  if (action === "schedule") return "Nothing to schedule.";
  return "Nothing for later.";
}
