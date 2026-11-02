import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { hintClass, labelClass } from "@/lib/field";
import { cn } from "@/lib/cn";

type CatalogOption = { id: string; name: string; archivedAt?: string | null };

type PopoverBox = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

/**
 * Same match rule as the old project typeahead: case-insensitive contains, eight rows,
 * and an add row when the typed name is not already an exact match.
 */
function matchOptions<T extends { name: string }>(options: T[], query: string) {
  const needle = query.trim().toLowerCase();
  const matches = options.filter((option) => !needle || option.name.toLowerCase().includes(needle)).slice(0, 8);
  const exact = needle.length > 0 && options.some((option) => option.name.toLowerCase() === needle);
  return { needle, matches, exact };
}

function measurePopover(anchor: HTMLElement): PopoverBox {
  const view = window.visualViewport;
  const viewTop = view?.offsetTop ?? 0;
  const viewLeft = view?.offsetLeft ?? 0;
  const viewWidth = view?.width ?? window.innerWidth;
  const viewBottom = viewTop + (view?.height ?? window.innerHeight);
  const margin = 8;
  const gap = 6;
  const form = anchor.closest("form");
  const header = form?.querySelector(":scope > header");
  const footer = form?.querySelector(":scope > footer");
  const headerBottom = header?.getBoundingClientRect().bottom ?? viewTop;
  const footerTop = footer?.getBoundingClientRect().top ?? viewBottom;
  const topBound = Math.max(viewTop, headerBottom) + margin;
  const bottomBound = Math.min(viewBottom, footerTop) - margin;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(rect.width, viewWidth - margin * 2);
  const left = Math.min(Math.max(rect.left, viewLeft + margin), viewLeft + viewWidth - width - margin);
  const spaceBelow = bottomBound - rect.bottom - gap;
  const spaceAbove = rect.top - gap - topBound;
  const below = spaceBelow >= spaceAbove;
  if (below) {
    const top = rect.bottom + gap;
    return { left, width, maxHeight: Math.max(0, bottomBound - top), top };
  }
  return {
    left,
    width,
    maxHeight: Math.max(0, spaceAbove),
    bottom: window.innerHeight - (rect.top - gap),
  };
}

function revealAnchor(anchor: HTMLElement) {
  const scroller = anchor.closest(".overflow-y-auto");
  if (!(scroller instanceof HTMLElement)) return;
  const form = anchor.closest("form");
  const header = form?.querySelector(":scope > header");
  const footer = form?.querySelector(":scope > footer");
  const topBound = (header?.getBoundingClientRect().bottom ?? 0) + 12;
  const bottomBound = footer?.getBoundingClientRect().top ?? window.innerHeight;
  const rect = anchor.getBoundingClientRect();
  if (rect.top < topBound || rect.bottom > bottomBound - 180) {
    scroller.scrollTop += rect.top - topBound;
  }
}

export function CatalogPicker({
  label,
  emptyLabel,
  placeholder,
  emptyList,
  value,
  options,
  onChange,
  onCreate,
  onOpen,
  hint,
}: {
  label: string;
  emptyLabel: string;
  placeholder: string;
  emptyList: string;
  value: string;
  options: CatalogOption[];
  onChange: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onOpen?: (id: string) => void;
  hint?: string;
}) {
  const labelId = useId();
  const listId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<PopoverBox | null>(null);
  const selected = options.find((option) => option.id === value) ?? null;
  const { needle, matches, exact } = matchOptions(options, query);

  function close(restoreFocus = true) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(id: string) {
    onChange(id);
    close(false);
    triggerRef.current?.focus();
  }

  async function add() {
    const name = query.trim();
    if (!name || exact || adding) return;
    setAdding(true);
    try {
      await onCreate(name);
      setQuery("");
      setOpen(false);
    } catch {
      // The form already shows the error.
    } finally {
      setAdding(false);
    }
  }

  useLayoutEffect(() => {
    if (!open || !rowRef.current) return;
    const anchor = rowRef.current;
    revealAnchor(anchor);
    const form = anchor.closest("form");
    setHost(form instanceof HTMLElement ? form : document.body);
    setBox(measurePopover(anchor));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const anchor = rowRef.current;
    if (!anchor) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setBox(measurePopover(anchor));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("keydown", onKey, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("keydown", onKey, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open]);

  return (
    <div>
      <span id={labelId} className={labelClass}>
        {label}
      </span>
      <div ref={rowRef} className="flex items-center border-b border-[#262626]">
        <button
          ref={triggerRef}
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center py-2.5 text-left"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={selected ? `${label}: ${selected.name}` : `${label}: ${emptyLabel}`}
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
        >
          <span className={cn("truncate text-[15px] font-light", selected ? "text-[#eee]" : "text-[#a8a8a8]")}>
            {selected ? selected.name : emptyLabel}
          </span>
          {selected?.archivedAt ? (
            <span className="ml-3 shrink-0 text-[10px] font-normal uppercase tracking-[0.28em] text-[#a8a8a8]">Archived</span>
          ) : null}
        </button>
        {selected && onOpen ? (
          <button
            type="button"
            aria-label={`Open ${selected.name}`}
            className="inline-flex size-11 shrink-0 items-center justify-center text-[#a8a8a8] transition-colors duration-150 hover:text-white active:opacity-35"
            onClick={() => onOpen(selected.id)}
          >
            <ChevronRight aria-hidden strokeWidth={1.5} className="size-4" />
          </button>
        ) : null}
      </div>
      {hint ? <p className={hintClass}>{hint}</p> : null}
      {open && host && box
        ? createPortal(
            <>
              <div
                data-catalog-popover
                className="fixed inset-0 z-20"
                onPointerDown={(event) => {
                  event.preventDefault();
                  close();
                }}
              />
              <div
                data-catalog-popover
                role="dialog"
                aria-label={label}
                id={listId}
                style={{
                  left: box.left,
                  width: box.width,
                  maxHeight: box.maxHeight,
                  top: box.top,
                  bottom: box.bottom,
                }}
                className="fixed z-30 flex flex-col overflow-hidden border border-[#333] bg-black"
              >
                <input
                  ref={searchRef}
                  className="w-full shrink-0 appearance-none border-0 border-b border-[#262626] bg-transparent px-4 py-3 text-[15px] font-light text-[#eee] outline-none placeholder:text-[#a8a8a8]"
                  value={query}
                  placeholder={placeholder}
                  aria-label={placeholder}
                  aria-autocomplete="list"
                  aria-expanded={open}
                  aria-controls={listId}
                  role="combobox"
                  autoComplete="off"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (matches.length === 1 && matches[0]) {
                        choose(matches[0].id);
                        return;
                      }
                      void add();
                    }
                  }}
                />
                <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="listbox" aria-label={label}>
                  {value ? (
                    <li>
                      <button
                        type="button"
                        className="block min-h-11 w-full px-4 py-3 text-left text-[15px] font-light text-[#a8a8a8] transition-colors duration-150 hover:text-white"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose("")}
                      >
                        Clear
                      </button>
                    </li>
                  ) : null}
                  {matches.map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={option.id === value}
                        className={cn(
                          "block min-h-11 w-full px-4 py-3 text-left text-[15px] font-light transition-colors duration-150 hover:text-white",
                          option.id === value ? "text-white" : "text-[#ccc]",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(option.id)}
                      >
                        {option.name}
                        {option.archivedAt ? (
                          <span className="ml-3 text-[10px] uppercase tracking-[0.28em] text-[#a8a8a8]">Archived</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                  {needle && !exact ? (
                    <li>
                      <button
                        type="button"
                        className="block min-h-11 w-full px-4 py-3 text-left text-[15px] font-light text-[#a8a8a8] transition-colors duration-150 hover:text-white disabled:opacity-40"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void add()}
                        disabled={adding}
                      >
                        {adding ? "Adding…" : `Add ${query.trim()}`}
                      </button>
                    </li>
                  ) : null}
                  {matches.length === 0 && !needle ? <li className="px-4 py-3 text-[13px] text-[#a8a8a8]">{emptyList}</li> : null}
                </ul>
              </div>
            </>,
            host,
          )
        : null}
    </div>
  );
}
