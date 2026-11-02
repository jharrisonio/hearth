import type { Action, BotTokenSummary, Member, Task, TeamSummary } from "@hearth/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { CompleteDialog } from "@/components/CompleteDialog";
import { TaskDialog } from "@/components/TaskDialog";
import { TaskRow } from "@/components/TaskRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { greeting } from "@/lib/format";

type View = Action | "done";

type Bundle = {
  team: TeamSummary;
  members: Member[];
  tokens: BotTokenSummary[];
  tasks: Task[];
  view: View;
};

const views: { id: View; label: string }[] = [
  { id: "do_now", label: "Do now" },
  { id: "delegate", label: "Delegate" },
  { id: "schedule", label: "Schedule" },
  { id: "later", label: "Later" },
  { id: "done", label: "Done" },
];

export function Home() {
  const { user, signOut } = useAuth();
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [immediate, setImmediate] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ teamId: string; task: Task | null } | null>(null);
  const [completing, setCompleting] = useState<Task | null>(null);
  const [creatingHousehold, setCreatingHousehold] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const { teams } = await api.teams();
      const [nextBundles, queue] = await Promise.all([
        Promise.all(teams.map((team) => loadBundle(team))),
        api.doImmediately(),
      ]);
      setBundles((current) =>
        nextBundles.map((bundle) => ({
          ...bundle,
          view: current.find((item) => item.team.id === bundle.team.id)?.view ?? "do_now",
        })),
      );
      setImmediate(queue.tasks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your lists.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const names = useMemo(() => ownerNames(bundles), [bundles]);
  const teamName = useMemo(() => new Map(bundles.map((bundle) => [bundle.team.id, bundle.team.name])), [bundles]);

  if (!user) return null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ink/15 pb-5">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted">Household lists</p>
          <h1 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl">Hearth</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Button variant="secondary" size="sm" onClick={() => setCreatingHousehold(true)}>
            New household
          </Button>
          <div className="text-right">
            <p>{user.name}</p>
            <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <p className="mt-6 font-serif text-2xl">{greeting(user.name)}</p>
      {error ? (
        <p className="mt-4 rounded-2xl border border-terracotta/30 bg-terracotta/5 px-4 py-3 text-sm text-terracotta">
          {error}{" "}
          <button type="button" className="underline" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      ) : null}

      <section className="mt-6 rounded-3xl border border-ink/10 bg-sheet px-4 py-4 sm:px-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-2xl">Do immediately</h2>
          <button type="button" className="text-xs text-muted hover:underline" onClick={() => void reload()}>
            Refresh
          </button>
        </div>
        <p className="text-sm text-muted">
          Do now, scheduled tasks that still need a calendar or are overdue, and delegated follow-ups that are due.
          Important and urgent come first.
        </p>
        {loading ? <p className="mt-4 text-sm text-muted">Loading your lists…</p> : null}
        {!loading && immediate.length === 0 ? (
          <p className="mt-4 text-sm text-muted">Nothing to do immediately.</p>
        ) : null}
        <ol className="mt-2">
          {immediate.map((task, index) => (
            <li key={task.id} className="flex gap-3">
              <span className="mt-3 w-5 font-serif text-muted">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <TaskRow
                  as="div"
                  task={task}
                  teamLabel={teamName.get(task.teamId)}
                  ownerLabel={names.get(ownerMapKey(task)) ?? "Someone"}
                  onEdit={() => setEditing({ teamId: task.teamId, task })}
                  onComplete={() => setCompleting(task)}
                />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {bundles.map((bundle) => (
          <TeamSheet
            key={bundle.team.id}
            bundle={bundle}
            names={names}
            onView={(view) =>
              setBundles((current) => current.map((item) => (item.team.id === bundle.team.id ? { ...item, view } : item)))
            }
            onCreate={() => setEditing({ teamId: bundle.team.id, task: null })}
            onEdit={(task) => setEditing({ teamId: bundle.team.id, task })}
            onComplete={setCompleting}
          />
        ))}
      </div>

      {editing ? (
        <TaskDialog
          open
          teamId={editing.teamId}
          task={editing.task}
          members={bundles.find((bundle) => bundle.team.id === editing.teamId)?.members ?? []}
          tokens={bundles.find((bundle) => bundle.team.id === editing.teamId)?.tokens ?? []}
          defaultOwnerId={user.id}
          onClose={() => setEditing(null)}
          onSaved={() => void reload()}
        />
      ) : null}
      <CompleteDialog task={completing} onClose={() => setCompleting(null)} onSaved={() => void reload()} />
      <HouseholdDialog
        open={creatingHousehold}
        onClose={() => setCreatingHousehold(false)}
        onCreated={() => void reload()}
      />
    </main>
  );
}

function TeamSheet({
  bundle,
  names,
  onView,
  onCreate,
  onEdit,
  onComplete,
}: {
  bundle: Bundle;
  names: Map<string, string>;
  onView: (view: View) => void;
  onCreate: () => void;
  onEdit: (task: Task) => void;
  onComplete: (task: Task) => void;
}) {
  const visible = bundle.tasks.filter((task) =>
    bundle.view === "done" ? task.status === "done" : task.status === "open" && task.action === bundle.view,
  );
  return (
    <section className="rounded-3xl border border-line bg-sheet/90 px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-muted">
            {bundle.team.kind === "personal" ? "Personal" : "Household"} · {bundle.team.role === "owner" ? "Owner" : "Member"}
          </p>
          <h2 className="font-serif text-2xl">{bundle.team.name}</h2>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onCreate}>
            Add
          </Button>
          <Link
            to={`/teams/${bundle.team.id}`}
            className="inline-flex h-8 items-center rounded-full border border-ink/15 px-3 text-xs hover:border-ink/30"
          >
            Settings
          </Link>
        </div>
      </div>
      <div className="mt-3 flex gap-1 overflow-x-auto" role="tablist" aria-label={`${bundle.team.name} actions`}>
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={bundle.view === view.id}
            onClick={() => onView(view.id)}
            className={
              bundle.view === view.id
                ? "shrink-0 whitespace-nowrap rounded-full bg-ink px-3 py-1 text-xs text-sheet"
                : "shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs text-muted hover:bg-ink/5"
            }
          >
            {view.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? <p className="mt-4 text-sm text-muted">{emptyCopy(bundle.view)}</p> : null}
      <ul>
        {visible.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            ownerLabel={names.get(ownerMapKey(task)) ?? "Someone"}
            onEdit={() => onEdit(task)}
            onComplete={() => onComplete(task)}
          />
        ))}
      </ul>
    </section>
  );
}

function HouseholdDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
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
      await api.createTeam(name.trim());
      setName("");
      onCreated();
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
          <DialogTitle>New household</DialogTitle>
          <DialogDescription>You become the owner. Invite people from settings after they have signed in once.</DialogDescription>
          <label className="mt-4 block text-sm">
            Name
            <input
              className="mt-1 w-full rounded-xl border border-line bg-white/70 px-3 py-2 outline-none focus:border-teal"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Harrison household"
              required
            />
          </label>
          {error ? <p className="mt-3 text-sm text-terracotta">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
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

async function loadBundle(team: TeamSummary): Promise<Bundle> {
  const [detail, tokens, tasks] = await Promise.all([api.team(team.id), api.tokens(team.id), api.tasks({ teamId: team.id })]);
  return { team: detail.team, members: detail.members, tokens: tokens.tokens, tasks: tasks.tasks, view: "do_now" };
}

function ownerNames(bundles: Bundle[]) {
  const names = new Map<string, string>();
  for (const bundle of bundles) {
    for (const member of bundle.members) names.set(`user:${member.userId}`, member.name);
    for (const token of bundle.tokens) names.set(`bot:${token.id}`, token.label);
  }
  return names;
}

function ownerMapKey(task: Task) {
  return `${task.owner.type}:${task.owner.id}`;
}

function emptyCopy(view: View) {
  if (view === "do_now") return "Do now is clear. Add a task, or leave it that way.";
  if (view === "delegate") return "Nothing is delegated.";
  if (view === "schedule") return "Nothing to schedule.";
  if (view === "later") return "Later is clear.";
  return "Nothing finished yet.";
}
