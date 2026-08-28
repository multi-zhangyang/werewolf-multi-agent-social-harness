import { memo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { LiveTurn, TurnToolStep } from "./use-room";
import { eventLabel } from "./shared";
import { summarizeToolOutput, type NameResolver } from "./tool-summary";

/**
 * The one cognition vocabulary shared by the live TurnCard and the settled
 * message cards. A tool step reads as a fact line — name, one semantic
 * summary, status — with the sanitized raw JSON one quiet click away,
 * instead of a debug console dumping pretty-printed objects into the feed.
 */

/** One tool step: status glyph, Chinese label, semantic summary, raw detail behind a chevron. */
export const ToolRow = memo(function ToolRow({ tool, resolveName }: {
  tool: TurnToolStep;
  resolveName?: NameResolver;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const running = tool.phase !== "succeeded";
  const summary = summarizeToolOutput(tool.safeOutputSummary, resolveName);
  const expandable = Boolean(tool.safeOutputSummary);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 rounded-md border border-border/50 bg-muted/30">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-xs"
          aria-expanded={expandable ? open : undefined}
        >
          {running
            ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="执行中" />
            : <Check className="size-3 shrink-0 text-muted-foreground/80" aria-label="已完成" />}
          <span className="shrink-0 font-medium">{tool.label ?? eventLabel(tool.toolName)}</span>
          {summary ? <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted-foreground">{summary}</span> : <span className="min-w-0 flex-1" />}
          {expandable ? (
            <ChevronDown className={cn("size-3 shrink-0 text-muted-foreground/70 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          ) : null}
        </button>
      </CollapsibleTrigger>
      {expandable ? (
        <CollapsibleContent>
          <pre className="scroll-fade-y mx-2 mb-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md bg-background/50 p-2 font-mono text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">{tool.safeOutputSummary}</pre>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
});

/** Reasoning body: plain pre-wrap, height-capped with a bottom fade. */
export function ReasoningText({ text, className }: { text: string; className?: string }): ReactNode {
  return (
    <pre className={cn(
      "scroll-fade-y max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 font-sans text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]",
      className
    )}>{text}</pre>
  );
}

/**
 * Settled per-message process: one quiet meta row ("本轮过程 · 思考了 2 秒 · 2 次
 * 行动") that expands into the reasoning body and tool rows. Collapsed state
 * carries the facts so a cluster of messages reads as calm prose, not logs.
 */
export function SettledTurnProcess({ turn, resolveName, className }: {
  turn: LiveTurn;
  resolveName?: NameResolver;
  className?: string;
}): ReactNode {
  const reasoning = turn.reasoning?.text;
  const tools = turn.tools;
  if (!reasoning && !tools.length) return null;
  const meta = [
    reasoning ? `思考了 ${Math.max(1, Math.round((turn.reasoning?.elapsedMs ?? 0) / 1000))} 秒` : null,
    tools.length ? `${tools.length} 次行动` : null
  ].filter(Boolean).join(" · ");
  return (
    <Collapsible className={cn("group/process mt-2 border-t border-border/50 pt-2", className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] tracking-wide text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
        <ChevronDown className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/process:rotate-180" aria-hidden />
        <span className="shrink-0 font-mono">本轮过程</span>
        {meta ? <span className="min-w-0 flex-1 truncate font-sans text-[10px] text-muted-foreground/75">{meta}</span> : <span className="min-w-0 flex-1" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 space-y-1.5">
          {reasoning ? <ReasoningText text={reasoning} /> : null}
          {tools.map((tool) => <ToolRow key={tool.toolCallId} tool={tool} resolveName={resolveName} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
