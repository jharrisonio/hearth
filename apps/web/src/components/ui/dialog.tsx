import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { CloseIcon } from "@/components/Icons";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black" />
      <DialogPrimitive.Content
        className={cn("fixed inset-0 z-50 overflow-y-auto bg-black text-white", className)}
        {...props}
      >
        <div className="mx-auto min-h-dvh w-full max-w-md px-8 pb-24 pt-24">{children}</div>
        <DialogPrimitive.Close aria-label="Close" className="fixed right-8 top-8 z-[60] text-white/70 hover:text-white">
          <CloseIcon />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DialogTitle = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title className={cn("text-[11px] font-normal uppercase tracking-[0.18em] text-white/50", className)} {...props} />
);

export const DialogDescription = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description className={cn("mt-3 text-[13px] text-white/50", className)} {...props} />
);
