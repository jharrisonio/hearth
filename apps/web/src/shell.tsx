import type { Action, Task, TeamSummary } from "@hearth/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "@/auth";
import { TabBar } from "@/components/TabBar";
import { TaskDialog } from "@/components/TaskDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, labelClass } from "@/lib/field";
import { LIST_KEY } from "@/lib/list";

type Editor = { teamId: string; task: Task | null; defaultAction: Action };

type ShellValue = {
  teams: TeamSummary[];
  current: TeamSummary | null;
  teamsLoading: boolean;
  teamsError: string | null;
  chooseList: (id: string) => void;
  openListPicker: () => void;
  openCreateHousehold: () => void;
  openTask: (task: Task | null, defaultAction?: Action) => void;
  taskRevision: number;
};

const ShellContext = createContext<ShellValue | null>(null);

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside the app shell.");
  return value;
}

export function Shell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [listId, setListId] = useState<string | null>(() => sessionStorage.getItem(LIST_KEY));
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [pickingList, setPickingList] = useState(false);
  const [creatingHousehold, setCreatingHousehold] = useState(false);
  const [editing, setEditing] = useState<Editor | null>(null);
  const [taskRevision, setTaskRevision] = useState(0);

  const reloadTeams = useCallback(async () => {
    try {
      const { teams: next } = await api.teams();
      setTeams(next);
      setTeamsError(null);
    } catch (err) {
      setTeamsError(err instanceof ApiError ? err.message : "Could not load your lists.");
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadTeams();
  }, [reloadTeams, location.pathname]);

  useEffect(() => {
    const onFocus = () => void reloadTeams();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadTeams]);

  const current = useMemo(
    () => teams.find((team) => team.id === listId) ?? teams.find((team) => team.kind === "household") ?? teams[0] ?? null,
    [teams, listId],
  );

  useEffect(() => {
    if (current) sessionStorage.setItem(LIST_KEY, current.id);
  }, [current]);

  const chooseList = useCallback((id: string) => {
    sessionStorage.setItem(LIST_KEY, id);
    setListId(id);
  }, []);

  const openTask = useCallback(
    (task: Task | null, defaultAction: Action = "do_now") => {
      const teamId = task?.teamId ?? current?.id;
      if (!teamId) return;
      setEditing({ teamId, task, defaultAction });
    },
    [current?.id],
  );

  const value = useMemo<ShellValue>(
    () => ({
      teams,
      current,
      teamsLoading,
      teamsError,
      chooseList,
      openListPicker: () => setPickingList(true),
      openCreateHousehold: () => setCreatingHousehold(true),
      openTask,
      taskRevision,
    }),
    [teams, current, teamsLoading, teamsError, chooseList, openTask, taskRevision],
  );

  return (
    <ShellContext.Provider value={value}>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-black text-white">
        <div className="min-h-0 flex-1 overflow-hidden [&>*]:h-full">
          <Outlet />
        </div>
        <TabBar settingsTo={current ? `/teams/${current.id}` : "/settings"} />
      </div>
      {user && editing ? (
        <TaskDialog
          open
          teamId={editing.teamId}
          task={editing.task}
          defaultOwnerId={user.id}
          defaultAction={editing.defaultAction}
          onOpenProject={(projectId) => {
            setEditing(null);
            navigate(`/projects/${projectId}`);
          }}
          onClose={() => setEditing(null)}
          onSaved={() => setTaskRevision((revision) => revision + 1)}
        />
      ) : null}
      <ListPicker
        open={pickingList}
        teams={teams}
        currentId={current?.id ?? null}
        onClose={() => setPickingList(false)}
        onChoose={(id) => {
          chooseList(id);
          setPickingList(false);
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
          chooseList(team.id);
          void reloadTeams();
        }}
      />
    </ShellContext.Provider>
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
        <DialogTitle>Lists</DialogTitle>
        <DialogDescription className="sr-only">Choose the list shown on this screen.</DialogDescription>
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
                    on ? "text-white" : "text-[#a8a8a8] hover:text-white",
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
          className="mt-10 text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8] transition-colors duration-150 hover:text-white"
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
