import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center text-[10px] font-normal uppercase tracking-[0.32em] transition-[color,opacity] duration-150 ease-[cubic-bezier(0.2,0.6,0.2,1)] active:opacity-35 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "py-3 text-[#8a8a8a] hover:text-white",
        solid: "bg-white px-[26px] py-3.5 text-black! hover:opacity-85",
        secondary: "py-3 text-[#8a8a8a] hover:text-white",
        ghost: "py-3 text-[#8a8a8a] hover:text-white",
        danger: "py-3 text-[#8a8a8a] hover:text-white",
      },
      size: {
        default: "",
        sm: "",
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
