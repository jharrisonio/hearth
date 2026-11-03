import { cn } from "@/lib/cn";

export function Chips<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-stretch gap-1.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-9 min-w-0 flex-1 whitespace-nowrap border px-1 text-center text-[10px] font-normal uppercase tracking-[0.08em] transition-colors duration-200 disabled:opacity-40",
              on ? "border-white text-white" : "border-[#2a2a2a] text-[#a8a8a8] hover:border-[#555] hover:text-white",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
