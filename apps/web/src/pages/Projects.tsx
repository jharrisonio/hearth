import { useAuth } from "@/auth";
import { ProjectsScreen } from "@/components/ProjectsSheet";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useShell } from "@/shell";

export function Projects() {
  const { user } = useAuth();
  const { current, teamsLoading, teamsError, openListPicker, openTask, taskRevision } = useShell();

  if (!user) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader listName={current?.name ?? ""} onPickList={openListPicker} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[560px] px-7 pb-16 pt-6">
          {teamsLoading ? <p className="text-[10px] font-normal uppercase tracking-[0.4em] text-[#a8a8a8]">Loading</p> : null}
          {!teamsLoading && teamsError ? <p className="max-w-sm text-[13px] font-light text-[#a8a8a8]">{teamsError}</p> : null}
          {!teamsLoading && !teamsError && !current ? (
            <p className="text-[10px] font-normal uppercase tracking-[0.4em] text-[#a8a8a8]">No list yet</p>
          ) : null}
          {current ? (
            <ProjectsScreen
              key={current.id}
              teamId={current.id}
              ownerId={user.id}
              refreshToken={taskRevision}
              onEditTask={(task) => openTask(task)}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
