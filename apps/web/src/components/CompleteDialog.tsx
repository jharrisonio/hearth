import type { Task } from "@hearth/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";

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
      <DialogContent>
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
      <DialogTitle>Mark done</DialogTitle>
      <DialogDescription>{task.title}</DialogDescription>
      <label className="mt-4 block text-sm">
        What was the outcome?
        <textarea
          className="mt-1 w-full rounded-xl border border-line bg-white/70 px-3 py-2 text-sm outline-none focus:border-teal"
          rows={4}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          autoFocus
          required
        />
      </label>
      {error ? <p className="mt-3 text-sm text-terracotta">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Mark done"}
        </Button>
      </div>
    </form>
  );
}
