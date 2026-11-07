import type { Task, TaskStatus } from "@hearth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { Chips } from "@/components/Chips";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ApiError, api } from "@/lib/api";
import { archivePath, pageLink } from "@/lib/page-link";
import { useShell } from "@/shell";

type ArchiveFilter = "all" | "done" | "cancelled";

const filters: readonly { value: ArchiveFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

export function Archive() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { current, teamsLoading, teamsError, openListPicker, openTask, taskRevision } = useShell();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const requested = params.get("status");
  const filter: ArchiveFilter = requested === "done" || requested === "cancelled" ? requested : "all";

  const reload = useCallback(async () => {
    const id = ++request.current;
    if (!current) {
      setTasks([]);
      setLoading(false);
      return;
    }
    try {
      const [done, cancelled] = await Promise.all([
        api.tasks({ teamId: current.id, status: "done" }),
        api.tasks({ teamId: current.id, status: "cancelled" }),
      ]);
      if (id !== request.current) return;
      const seen = new Set<string>();
      const next: Task[] = [];
      for (const task of [...done.tasks, ...cancelled.tasks]) {
        if (seen.has(task.id) || (task.status !== "done" && task.status !== "cancelled")) continue;
        seen.add(task.id);
        next.push(task);
      }
      setTasks(next);
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      setError(err instanceof ApiError ? err.message : "Could not load the archive.");
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

  const visible = useMemo(() => {
    const rows = filter === "all" ? tasks : tasks.filter((task) => task.status === filter);
    return rows.slice().sort(newestFirst);
  }, [tasks, filter]);

  if (!user) return null;

  function setFilter(next: ArchiveFilter) {
    const query = new URLSearchParams(params);
    if (next === "all") query.delete("status");
    else query.set("status", next);
    setParams(query, { replace: true });
  }

  const notice = error ?? teamsError;
  const share = pageLink(
    archivePath(current?.id ?? null, filter),
    filter === "all" ? `Archive · ${current?.name ?? "Archive"}` : `Archive · ${current?.name ?? "Archive"} · ${filter === "done" ? "Done" : "Cancelled"}`,
    window.location.origin,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader listName={current?.name ?? ""} onPickList={openListPicker} link={share} />
      <div className="shrink-0 px-7 pb-2">
        <Chips label="Archive" value={filter} options={filters} onChange={setFilter} />
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
                <li key={task.id} className="w-fit max-w-full py-[13px]">
                  <button
                    type="button"
                    onClick={() => openTask(task)}
                    className="group relative block max-w-full text-left"
                  >
                    <span className="block text-[18px] font-light leading-snug tracking-[0.01em] text-[#d6d6d6] transition-colors duration-200 hover:text-white">
                      {task.title}
                    </span>
                    <span className="mt-1 block text-[10px] font-normal uppercase tracking-[0.28em] text-[#a8a8a8]">
                      {statusLabel[task.status]}
                    </span>
                    {task.outcome ? <span className="mt-1 block text-[13px] font-light text-[#a8a8a8]">{task.outcome}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const statusLabel: Record<TaskStatus, string> = {
  open: "Open",
  done: "Done",
  cancelled: "Cancelled",
};

function finishedAt(task: Task) {
  if (task.status === "cancelled") return task.cancelledAt ?? task.updatedAt;
  return task.completedAt ?? task.updatedAt;
}

function newestFirst(a: Task, b: Task) {
  const byTime = finishedAt(b).localeCompare(finishedAt(a));
  if (byTime !== 0) return byTime;
  return a.title.localeCompare(b.title);
}
