import type { Task } from "@hearth/shared";

export function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="px-2 py-2 text-[15px] font-normal leading-snug text-white underline-offset-4 hover:underline"
      >
        {task.title}
      </button>
    </li>
  );
}
