export function Flags({ important, urgent }: { important: boolean; urgent: boolean }) {
  if (!important && !urgent) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {important ? (
        <span className="rounded-full border border-terracotta px-2 py-0.5 font-serif text-[0.68rem] uppercase tracking-wide text-terracotta">
          Important
        </span>
      ) : null}
      {urgent ? (
        <span className="rounded-full bg-amber/10 px-2 py-0.5 font-serif text-[0.68rem] uppercase tracking-wide text-amber">
          Urgent
        </span>
      ) : null}
    </span>
  );
}
