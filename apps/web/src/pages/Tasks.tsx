import { actions, isBackFromSnooze, isSnoozed, SNOOZE_TIME_ZONE, type Action, type Task } from "@hearth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { Chips } from "@/components/Chips";
import { iconButtonClass } from "@/components/Icons";
import { ScreenHeader } from "@/components/ScreenHeader";
import { TaskRow } from "@/components/TaskRow";
import { actionLabel } from "@/lib/action";
import { ApiError, api } from "@/lib/api";
import { useShell } from "@/shell";

const actionOptions = actions.map((action) => ({ value: action, label: actionLabel[action] }));

export function Tasks() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { current, teamsLoading, teamsError, openListPicker, openTask, taskRevision } = useShell();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const requested = params.get("action");
  const filter: Action = (actions as readonly string[]).includes(requested ?? "") ? (requested as Action) : "do_now";

  const reload = useCallback(async () => {
    const id = ++request.current;
    if (!current) {
      setTasks([]);
      setLoading(false);
      return;
    }
    try {
      const { tasks: next } = await api.tasks({ teamId: current.id, status: "open", includeSnoozed: true });
      if (id !== request.current) return;
      setTasks(next);
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      setError(err instanceof ApiError ? err.message : "Could not load your lists.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [current]);

  useEffect(() => {
    setTasks([]);
    setLoading(true);
  }, [current?.id]);

  useEffect(() => {
    void reload();
  }, [reload, taskRevision]);

  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const visible = useMemo(
    () => tasks.filter((task) => task.status === "open" && task.action === filter && !isSnoozed(task)).sort(compareTasks),
    [tasks, filter],
  );
  const snoozed = useMemo(
    () => tasks.filter((task) => task.status === "open" && isSnoozed(task)).sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "")),
    [tasks],
  );

  if (!user) return null;

  function setFilter(action: Action) {
    const next = new URLSearchParams(params);
    if (action === "do_now") next.delete("action");
    else next.set("action", action);
    setParams(next, { replace: true });
  }

  const notice = error ?? teamsError;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        listName={current?.name ?? ""}
        onPickList={openListPicker}
        trailing={
          <button
            type="button"
            aria-label="New task"
            onClick={() => openTask(null, filter)}
            disabled={!current}
            className={iconButtonClass}
          >
            <span aria-hidden className="block -translate-y-px text-[28px] font-extralight leading-none">
              +
            </span>
          </button>
        }
      />
      <div className="shrink-0 px-7 pb-2">
        <Chips label="Action" value={filter} options={actionOptions} onChange={setFilter} />
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[560px] px-7 pb-16 pt-8">
          {loading || teamsLoading ? <p className="text-[10px] font-normal uppercase tracking-[0.4em] text-[#a8a8a8]">Loading</p> : null}
          {!loading && !teamsLoading && notice ? (
            <p className="max-w-sm text-[13px] font-light text-[#a8a8a8]">
              {notice}{" "}
              <button type="button" className="underline underline-offset-4" onClick={() => void reload()}>
                try again
              </button>
            </p>
          ) : null}
          {!loading && !teamsLoading && !notice && visible.length === 0 ? (
            <p className="text-[10px] font-normal uppercase tracking-[0.4em] text-[#a8a8a8]">Nothing here</p>
          ) : null}
          {visible.length > 0 ? (
            <ul key={`${current?.id ?? "none"}-${filter}`} className="hearth-fade flex w-full flex-col">
              {visible.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onOpen={() => openTask(task, filter)}
                  onOpenProject={(projectId) => navigate(`/projects/${projectId}`)}
                />
              ))}
            </ul>
          ) : null}
          {snoozed.length > 0 ? (
            <section className="mt-12">
              <button
                type="button"
                className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8] hover:text-white"
                aria-expanded={snoozeOpen}
                onClick={() => setSnoozeOpen((open) => !open)}
              >
                Snoozed · {snoozed.length}
              </button>
              {snoozeOpen ? (
                <ul className="hearth-fade mt-4 flex flex-col">
                  {snoozed.map((task) => (
                    <li key={task.id} className="w-fit max-w-full py-[13px]">
                      <button
                        type="button"
                        onClick={() => openTask(task, filter)}
                        className="block max-w-full text-left"
                      >
                        <span className="block text-[18px] font-light leading-snug text-[#d6d6d6] hover:text-white">{task.title}</span>
                        <span className="mt-1 block text-[13px] font-light text-[#a8a8a8]">
                          Until {task.snoozedUntil ? formatVancouver(task.snoozedUntil) : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function compareTasks(a: Task, b: Task) {
  const aw = isBackFromSnooze(a) ? 0 : 1;
  const bw = isBackFromSnooze(b) ? 0 : 1;
  if (aw !== bw) return aw - bw;
  const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.title.localeCompare(b.title);
}

function formatVancouver(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SNOOZE_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
