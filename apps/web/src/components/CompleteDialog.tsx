import type { Task } from "@hearth/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { fieldClass, labelClass } from "@/lib/field";

export function CompleteDialog({
  task,
  onClose,
  onSaved,
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={task != null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent variant="modal">
        {task ? <CompleteForm key={task.id} task={task} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CompleteForm({ task, onClose, onSaved }: { task: Task; onClose: () => void; onSaved: () => void }) {
  const [outcome, setOutcome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!outcome.trim()) {
      setError("Write what got done. An outcome is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.completeTask(task.id, outcome.trim());
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not complete the task.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <DialogTitle className="mb-3">Done</DialogTitle>
      <DialogDescription className="text-[15px] text-[#d6d6d6]">{task.title}</DialogDescription>
      <label className={labelClass}>
        Outcome
        <textarea className={fieldClass} rows={3} value={outcome} onChange={(event) => setOutcome(event.target.value)} autoFocus required />
      </label>
      {error ? <p className="mt-4 text-[13px] text-[#c9a35a]">{error}</p> : null}
      <div className="sticky bottom-0 z-[1] mt-12 flex items-center justify-end gap-7 bg-black pt-4">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="solid" disabled={saving}>
          {saving ? "Saving…" : "Mark done"}
        </Button>
      </div>
    </form>
  );
}
