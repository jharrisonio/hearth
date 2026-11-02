import type { Task } from "@hearth/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";

export function DeleteDialog({
  task,
  onClose,
  onDeleted,
}: {
  task: Task | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  return (
    <Dialog open={task != null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent variant="modal">
        {task ? <DeleteForm key={task.id} task={task} onClose={onClose} onDeleted={onDeleted} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DeleteForm({ task, onClose, onDeleted }: { task: Task; onClose: () => void; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteTask(task.id);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the task.");
      setDeleting(false);
    }
  }

  return (
    <div>
      <DialogTitle className="mb-3">Delete</DialogTitle>
      <DialogDescription className="text-[15px] text-[#d6d6d6]">{task.title}</DialogDescription>
      <p className="mt-6 text-[13px] font-light leading-relaxed text-[#a8a8a8]">
        This removes the task. It does not stay for audit.
      </p>
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="sticky bottom-0 z-[1] mt-12 flex items-center justify-end gap-7 bg-black pt-4">
        <Button type="button" variant="ghost" onClick={onClose} disabled={deleting}>
          Keep
        </Button>
        <Button type="button" variant="solid" onClick={() => void onDelete()} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </div>
  );
}
