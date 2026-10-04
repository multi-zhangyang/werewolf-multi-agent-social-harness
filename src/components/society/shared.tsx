import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
export function MiniChip({ tone = "neutral", className, title, children }: {
  tone?: "neutral" | "warn" | "secret" | "live";
  className?: string;
  title?: string;
  children: ReactNode;
}): ReactNode {
  const tones = {
    neutral: "border-border bg-card text-muted-foreground",
    warn: "border-warn/40 bg-warn/10 text-warn",
    secret: "border-secret/40 bg-secret/10 text-secret",
    live: "border-live/40 bg-live/10 text-live"
  };
  return <Badge variant="outline" title={title} className={cn("h-auto gap-1 rounded px-1 py-0 text-xs font-normal leading-4", tones[tone], className)}>{children}</Badge>;
}
export function ErrorNote({ children }: { children: ReactNode }): ReactNode {
  return (
    <Alert variant="destructive" className="py-2 text-sm leading-5">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <AlertDescription className="min-w-0">{children}</AlertDescription>
    </Alert>
  );
}