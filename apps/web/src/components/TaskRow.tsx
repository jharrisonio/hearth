import type { Task } from "@hearth/shared";

export function TaskRow({
  task,
  onOpen,
  onOpenProject,
}: {
  task: Task;
  onOpen: () => void;
  onOpenProject?: (projectId: string) => void;
}) {
  const project = task.project;
  return (
    <li className="w-fit max-w-full py-[13px]">
      <button
        type="button"
        onClick={onOpen}
        className="group relative block max-w-full text-left text-[18px] font-light leading-snug tracking-[0.01em] text-[#d6d6d6] transition-[color,opacity] duration-200 ease-[cubic-bezier(0.2,0.6,0.2,1)] hover:text-white active:opacity-50"
      >
        {task.title}
        <span className="pointer-events-none absolute inset-x-0 bottom-1 h-px origin-left scale-x-0 bg-white transition-transform duration-[250ms] ease-[cubic-bezier(0.2,0.6,0.2,1)] group-hover:scale-x-100" />
      </button>
      {project || task.area ? (
        <p className="mt-1 text-[10px] font-normal uppercase tracking-[0.28em] text-[#5c5c5c]">
          {project ? (
            onOpenProject ? (
              <button
                type="button"
                onClick={() => onOpenProject(project.id)}
                className="transition-colors duration-150 hover:text-white"
              >
                {project.name}
              </button>
            ) : (
              project.name
            )
          ) : null}
          {project && task.area ? " · " : null}
          {task.area?.name}
        </p>
      ) : null}
    </li>
  );
}
