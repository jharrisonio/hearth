import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { CloseIcon, iconButtonClass } from "@/components/Icons";
import { cn } from "@/lib/cn";
import { pageTitleClass } from "@/lib/field";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  variant = "sheet",
  layer = "base",
  pinned = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  variant?: "sheet" | "modal";
  layer?: "base" | "front";
  pinned?: boolean;
}) {
  const front = layer === "front";
  const close = (
    <DialogPrimitive.Close
      aria-label="Close"
      className={cn(
        iconButtonClass,
        variant === "sheet"
          ? cn(
              "fixed right-2.5",
              pinned ? "top-[calc(env(safe-area-inset-top)+0.625rem)]" : "top-2.5",
              front ? "z-[95]" : "z-[60]",
            )
          : "absolute right-1 top-1 z-10",
      )}
    >
      <CloseIcon />
    </DialogPrimitive.Close>
  );

  if (variant === "modal") {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="hearth-pop fixed inset-0 z-[100] bg-black/80 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            "hearth-pop fixed left-1/2 top-1/2 z-[110] flex max-h-[min(640px,calc(100dvh-48px))] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border border-[#222] bg-black text-white",
            className,
          )}
          {...props}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-9 pb-9 pt-12">{children}</div>
          {close}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }

  if (pinned) {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn("fixed inset-0 bg-black", front ? "z-[80]" : "z-40")} />
        <DialogPrimitive.Content
          className={cn(
            "hearth-sheet fixed inset-0 flex h-dvh flex-col bg-black text-white",
            front ? "z-[90]" : "z-50",
            className,
          )}
          {...props}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-[560px] flex-1 flex-col overflow-hidden">{children}</div>
          {close}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={cn("fixed inset-0 bg-black", front ? "z-[80]" : "z-40")} />
      <DialogPrimitive.Content
        className={cn("hearth-sheet fixed inset-0 overflow-y-auto bg-black text-white", front ? "z-[90]" : "z-50", className)}
        {...props}
      >
        <div className="mx-auto min-h-dvh w-full max-w-[560px] px-7 pb-20 pt-[92px]">{children}</div>
        {close}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DialogTitle = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title className={cn(pageTitleClass, className)} {...props} />
);

export const DialogDescription = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description className={cn("mt-3 text-[13px] font-light text-[#a8a8a8]", className)} {...props} />
);
