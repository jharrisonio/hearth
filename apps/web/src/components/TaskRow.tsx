import type { Task } from "@hearth/shared";

export function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <li className="w-fit max-w-full">
      <button
        type="button"
        onClick={onOpen}
        className="group relative block max-w-full py-[13px] text-left text-[18px] font-light leading-snug tracking-[0.01em] text-[#d6d6d6] transition-[color,opacity] duration-200 ease-[cubic-bezier(0.2,0.6,0.2,1)] hover:text-white active:opacity-50"
      >
        {task.title}
        <span className="pointer-events-none absolute inset-x-0 bottom-2 h-px origin-left scale-x-0 bg-white transition-transform duration-[250ms] ease-[cubic-bezier(0.2,0.6,0.2,1)] group-hover:scale-x-100" />
      </button>
    </li>
  );
}
