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
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { variant?: "sheet" | "modal"; layer?: "base" | "front" }) {
  const close = (
    <DialogPrimitive.Close
      aria-label="Close"
      className={cn(
        iconButtonClass,
        variant === "sheet" ? (layer === "front" ? "fixed right-2.5 top-2.5 z-[95]" : "fixed right-2.5 top-2.5 z-[60]") : "absolute right-1 top-1",
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
            "hearth-pop fixed left-1/2 top-1/2 z-[110] max-h-[min(640px,calc(100dvh-48px))] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-[#222] bg-black px-9 pb-9 pt-12 text-white",
            className,
          )}
          {...props}
        >
          {children}
          {close}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={cn("fixed inset-0 bg-black", layer === "front" ? "z-[80]" : "z-40")} />
      <DialogPrimitive.Content
        className={cn("hearth-sheet fixed inset-0 overflow-y-auto bg-black text-white", layer === "front" ? "z-[90]" : "z-50", className)}
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
  <DialogPrimitive.Description className={cn("mt-3 text-[13px] font-light text-[#5c5c5c]", className)} {...props} />
);
