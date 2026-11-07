import { Share } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { iconButtonClass } from "@/components/Icons";
import { copyPageLink, nativeShare, type PageLink } from "@/lib/page-link";
import { cn } from "@/lib/cn";

export function ShareLink({ link, label }: { link: PageLink; label?: string }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']");
    first?.focus();
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function show(next: string | null, url: string | null) {
    setNotice(next);
    setFallback(url);
    setOpen(true);
  }

  async function copy() {
    const outcome = await copyPageLink(link.url, (value) => navigator.clipboard.writeText(value));
    if (outcome === "copied") show("Link copied", null);
    else show("Could not copy. Select the link.", link.url);
  }

  async function share() {
    const outcome = await nativeShare(link, async (data) => {
      if (!navigator.share) throw new Error("Share is not available.");
      await navigator.share(data);
    });
    if (outcome === "cancelled") {
      setOpen(false);
      return;
    }
    if (outcome === "shared") show("Link shared", null);
    else show("Could not share. Select the link.", link.url);
  }

  return (
    <div ref={rootRef} className="relative z-30">
      <button
        ref={triggerRef}
        type="button"
        className={cn(iconButtonClass, label ? "h-11 w-auto min-w-11 px-1 text-[11px] font-normal tracking-[0.16em] text-[#a8a8a8]" : "")}
        aria-label={label ? `Share ${label}` : "Share link"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setNotice(null);
          setFallback(null);
          setOpen((value) => !value);
        }}
      >
        {label ? <span className="truncate">{notice === "Link copied" ? "Copied" : label}</span> : <Share aria-hidden strokeWidth={1.5} className="size-4" />}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Share link"
          className="absolute left-0 top-full z-30 w-[min(18rem,calc(100vw-2.5rem))] border border-[#222] bg-black p-2 text-left"
        >
          <button type="button" role="menuitem" className="flex min-h-11 w-full items-center px-3 text-left text-[14px] font-light text-white hover:bg-[#141414]" onClick={() => void copy()}>
            Copy link
          </button>
          {canShare ? (
            <button type="button" role="menuitem" className="flex min-h-11 w-full items-center px-3 text-left text-[14px] font-light text-white hover:bg-[#141414]" onClick={() => void share()}>
              Share
            </button>
          ) : null}
          {notice ? <p className="px-3 py-2 text-[12px] font-light text-[#a8a8a8]" aria-live="polite">{notice}</p> : null}
          {fallback ? (
            <label className="block px-3 pb-2">
              <span className="sr-only">Link</span>
              <input
                readOnly
                value={fallback}
                className="w-full border border-[#222] bg-black px-2 py-2 text-[12px] font-light text-[#eee] outline-none"
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
