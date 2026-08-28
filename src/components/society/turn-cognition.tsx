import { memo, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ClockIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { LiveTurn, TurnToolStep } from "./use-room";
import { eventLabel } from "./shared";
import { summarizeToolOutput, type NameResolver } from "./tool-summary";

/**
 * The cognition vocabulary, following the AI Elements component anatomy:
 * a tool step is a collapsible whose header (wrench + name + status badge,
 * plus our spectator semantic summary) is the trigger and whose body holds
 * the 参数/结果 sections with syntax-highlighted JSON; reasoning reuses the
 * official Reasoning block (auto shimmer while streaming, duration after).
 * The live TurnCard and the settled message cards both speak it.
 */

const SPEECH_TOOLS: ReadonlySet<string> = new Set(["communicate", "message"]);

/** Compact status badge mirroring the official ToolHeader states. */
function StatusBadge({ phase }: { phase: TurnToolStep["phase"] }): ReactNode {
  const config = phase === "succeeded"
    ? { label: "已完成", icon: <CheckIcon className="size-2.5" aria-hidden /> }
    : phase === "failed"
      ? { label: "失败", icon: <XCircleIcon className="size-2.5" aria-hidden /> }
      : { label: "执行中", icon: <ClockIcon className="size-2.5 animate-pulse" aria-hidden /> };
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4.5 shrink-0 gap-1 rounded-full px-1.5 text-[10px] font-normal",
        phase === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border/70 bg-card/60 text-muted-foreground"
      )}
    >
      {config.icon}{config.label}
    </Badge>
  );
}

/** One tool step: AI Elements Tool anatomy at stream compactness. */
export const ToolStep = memo(function ToolStep({ tool, resolveName }: {
  tool: TurnToolStep;
  resolveName?: NameResolver;
}): ReactNode {
  const summary = summarizeToolOutput(tool.safeOutputSummary, resolveName);
  // The speech tools' input is the utterance itself — already on stage below;
  // 参数 would only echo it. Binding actions' inputs are the real decision.
  const input = tool.safeInputSummary && !SPEECH_TOOLS.has(tool.toolName) ? tool.safeInputSummary : undefined;
  return (
    <Collapsible className="min-w-0 rounded-md border border-border/50 bg-muted/30">
      <CollapsibleTrigger className="group/step flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-xs">
        <WrenchIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-medium">{tool.label ?? eventLabel(tool.toolName)}</span>
        <StatusBadge phase={tool.phase} />
        {summary ? <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted-foreground">{summary}</span> : <span className="min-w-0 flex-1" />}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-data-[state=open]/step:rotate-180" aria-hidden />
      </CollapsibleTrigger>
      {input || tool.safeOutputSummary ? (
        <CollapsibleContent className="space-y-2 px-2 pb-2">
          {input ? (
            <section className="min-w-0">
              <h4 className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground/80">参数</h4>
              <CodeBlock code={input} language="json" className="text-[11px] [&_pre]:max-h-40 [&_pre]:overflow-y-auto [&_pre]:p-2.5 [&_pre]:text-[11px] [&_pre]:leading-4" />
            </section>
          ) : null}
          {tool.safeOutputSummary ? (
            <section className="min-w-0">
              <h4 className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground/80">{tool.phase === "failed" ? "错误" : "结果"}</h4>
              <CodeBlock code={tool.safeOutputSummary} language="json" className="text-[11px] [&_pre]:max-h-40 [&_pre]:overflow-y-auto [&_pre]:p-2.5 [&_pre]:text-[11px] [&_pre]:leading-4" />
            </section>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
});

/**
 * Settled per-message process: one quiet meta row ("本轮过程 · N 次行动")
 * expanding into the official Reasoning block (🧠 思考了 N 秒 + Streamdown
 * body) and the tool steps. Collapsed state carries the facts so a cluster
 * of messages reads as calm prose, not logs.
 */
export function SettledTurnProcess({ turn, resolveName, className }: {
  turn: LiveTurn;
  resolveName?: NameResolver;
  className?: string;
}): ReactNode {
  const reasoning = turn.reasoning?.text;
  const tools = turn.tools;
  if (!reasoning && !tools.length) return null;
  const meta = tools.length ? `${tools.length} 次行动` : "";
  return (
    <Collapsible className={cn("group/process mt-2 border-t border-border/50 pt-2", className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] tracking-wide text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
        <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/process:rotate-180" aria-hidden />
        <span className="shrink-0 font-mono">本轮过程</span>
        {meta ? <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/75">{meta}</span> : <span className="min-w-0 flex-1" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-2">
          {reasoning ? (
            <Reasoning isStreaming={false} defaultOpen={false} duration={Math.max(1, Math.round((turn.reasoning?.elapsedMs ?? 0) / 1000))} className="mb-0">
              <ReasoningTrigger />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}
          {tools.map((tool) => <ToolStep key={tool.toolCallId} tool={tool} resolveName={resolveName} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
