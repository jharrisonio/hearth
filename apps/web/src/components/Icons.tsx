import { Settings } from "lucide-react";
import { cn } from "@/lib/cn";

/** 44px hit target. Glyphs sit inside, larger than the old 16px sun. */
export const iconButtonClass =
  "inline-flex size-11 shrink-0 items-center justify-center text-[#bbb] transition-[color,opacity] duration-150 ease-[cubic-bezier(0.2,0.6,0.2,1)] hover:text-white active:opacity-35";

export function GearIcon({ className }: { className?: string }) {
  return <Settings aria-hidden strokeWidth={1.5} className={cn("size-6", className)} />;
}

export function CloseIcon() {
  return (
    <span aria-hidden className="block translate-y-px text-[22px] font-extralight leading-none">
      ✕
    </span>
  );
}
