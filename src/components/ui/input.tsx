import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full rounded-lg border border-white/[0.08] bg-card/[0.02] px-4 py-2 text-sm text-foreground shadow-[inset_0_1px_2px_oklch(0_0_0/0.2)] transition-colors placeholder:text-muted-foreground/70 focus-visible:border-white/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Input }