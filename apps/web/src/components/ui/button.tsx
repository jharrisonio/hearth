import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 text-[13px] transition disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "text-white underline-offset-4 hover:underline",
        secondary: "text-white/50 hover:text-white",
        ghost: "text-white/50 hover:text-white",
        danger: "text-white/50 hover:text-white",
      },
      size: {
        default: "py-1",
        sm: "py-1 text-[12px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
