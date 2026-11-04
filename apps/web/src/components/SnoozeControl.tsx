import { SNOOZE_TIME_ZONE, snoozePreset, snoozeWallTime, isSnoozed, type SnoozePreset } from "@hearth/shared";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, hintClass } from "@/lib/field";

const choices: readonly { preset: SnoozePreset; label: string }[] = [
  { preset: "later_today", label: "Later today" },
  { preset: "tomorrow", label: "Tomorrow" },
  { preset: "three_days", label: "3 days" },
  { preset: "next_week", label: "Next week" },
];

export function SnoozeControl({
  taskId,
  snoozedUntil,
  onChanged,
}: {
  taskId: string;
  snoozedUntil: string | null;
  onChanged: (snoozedUntil: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = isSnoozed({ snoozedUntil });

  async function snooze(until: Date) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.snoozeTask(taskId, until.toISOString());
      onChanged(next.snoozedUntil);
      setOpen(false);
      setCustom(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not snooze the task.");
    } finally {
      setBusy(false);
    }
  }

  async function unsnooze() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.unsnoozeTask(taskId);
      onChanged(next.snoozedUntil);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not unsnooze the task.");
    } finally {
      setBusy(false);
    }
  }

  if (active && snoozedUntil) {
    return (
      <div className="mt-8 border-b border-[#161616] py-3">
        <p className="text-[15px] font-light text-[#eee]">Snoozed until {formatVancouver(snoozedUntil)}</p>
        <button
          type="button"
          className="mt-3 text-[10px] font-normal uppercase tracking-[0.28em] text-[#a8a8a8] hover:text-white disabled:opacity-40"
          onClick={() => void unsnooze()}
          disabled={busy}
        >
          Unsnooze
        </button>
        {error ? <p className="mt-3 text-[13px] text-[#c9a35a]">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-2 border-b border-[#161616]">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-3 py-2.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="w-24 shrink-0 text-[13px] font-light text-[#8a8a8a]">Snooze</span>
        <span className="text-[15px] font-light text-[#6f6f6f]">Later today, tomorrow, 3 days…</span>
      </button>
      {open ? (
        <div className="flex flex-col pb-4">
          {choices.map((choice) => {
            const when = snoozePreset(choice.preset);
            return (
              <button
                key={choice.preset}
                type="button"
                className="flex min-h-11 items-baseline justify-between gap-4 py-2 text-left text-[15px] font-light text-[#eee] hover:text-white disabled:opacity-40"
                disabled={busy}
                onClick={() => void snooze(when)}
              >
                <span>{choice.label}</span>
                <span className="text-[13px] text-[#8a8a8a]">{formatVancouver(when.toISOString())}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={cn(
              "flex min-h-11 items-center py-2 text-left text-[15px] font-light",
              custom ? "text-white" : "text-[#a8a8a8] hover:text-white",
            )}
            aria-pressed={custom}
            onClick={() => setCustom((value) => !value)}
          >
            Custom
          </button>
          {custom ? (
            <div>
              <input
                className={fieldClass}
                type="datetime-local"
                value={customValue}
                aria-label="Custom snooze time"
                onChange={(event) => setCustomValue(event.target.value)}
              />
              <p className={hintClass}>Vancouver time.</p>
              <button
                type="button"
                className="mt-3 text-[10px] font-normal uppercase tracking-[0.28em] text-[#a8a8a8] hover:text-white disabled:opacity-40"
                disabled={busy || !customValue}
                onClick={() => {
                  const until = snoozeWallTime(customValue);
                  if (!until) {
                    setError("Choose a date and time.");
                    return;
                  }
                  void snooze(until);
                }}
              >
                Set
              </button>
            </div>
          ) : null}
          {error ? <p className="mt-3 text-[13px] text-[#c9a35a]">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
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
