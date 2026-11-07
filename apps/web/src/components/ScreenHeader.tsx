import type { ReactNode } from "react";
import { ShareLink } from "@/components/ShareLink";
import type { PageLink } from "@/lib/page-link";

export function ScreenHeader({
  listName,
  onPickList,
  trailing,
  link,
}: {
  listName: string;
  onPickList: () => void;
  trailing?: ReactNode;
  link?: PageLink;
}) {
  return (
    <header className="sticky top-0 z-20 shrink-0 bg-black px-5 pt-[env(safe-area-inset-top)]">
      <div className="grid h-16 grid-cols-[44px_minmax(0,1fr)_44px] items-center">
        <span className="flex justify-start">{link ? <ShareLink link={link} /> : null}</span>
        <button
          type="button"
          className="min-w-0 truncate pl-[0.42em] text-[10px] font-normal uppercase tracking-[0.42em] text-[#e6e6e6] transition-opacity duration-150 hover:text-white active:opacity-40 disabled:opacity-40"
          onClick={onPickList}
          disabled={!listName}
        >
          {listName}
        </button>
        <span className="flex justify-end">{trailing}</span>
      </div>
    </header>
  );
}
