import { memo, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { LiveTurn, TurnToolStep } from "./use-room";
import { eventLabel } from "./shared";
import { summarizeToolFailure, summarizeToolOutput, type NameResolver } from "./tool-summary";

/**
 * The cognition vocabulary, following the AI Elements component anatomy:
 * a tool step uses the official AI Elements Tool anatomy, while reasoning
 * reuses the official Reasoning block (auto shimmer while streaming,
 * duration after). Product-specific semantics stay in the title/output.
 * The live TurnCard and the settled message cards both speak it.
 */

const SPEECH_TOOLS: ReadonlySet<string> = new Set(["prepare_message", "communicate", "message"]);

/** One tool step: AI Elements Tool anatomy at stream compactness. */
export const ToolStep = memo(function ToolStep({ tool, resolveName }: {
  tool: TurnToolStep;
  resolveName?: NameResolver;
}): ReactNode {
  const summary = summarizeToolOutput(tool.safeOutputSummary, resolveName);
  // The speech tools' input is the utterance itself — already on stage below;
  // 参数 would only echo it. Binding actions' inputs are the real decision.
  const input = tool.safeInputSummary && !SPEECH_TOOLS.has(tool.toolName) ? tool.safeInputSummary : undefined;
  const state = tool.phase === "succeeded"
    ? "output-available" as const
    : tool.phase === "failed"
      ? "output-error" as const
      : "input-available" as const;
  const output = parseSerialized(tool.safeOutputSummary);
  const errorText = tool.phase === "failed" ? summarizeToolFailure(tool.safeOutputSummary) : undefined;
  return (
    <Tool className="mb-0 min-w-0">
      <ToolHeader
        type="dynamic-tool"
        toolName={tool.toolName}
        state={state}
        title={`${tool.label ?? eventLabel(tool.toolName)}${summary ? ` · ${summary}` : ""}`}
        className="gap-2 px-2 py-1.5"
      />
      {input || tool.safeOutputSummary ? (
        <ToolContent className="flex flex-col gap-2 px-2 pt-0 pb-2">
          {input ? <ToolInput input={parseSerialized(input)} /> : null}
          <ToolOutput
            output={tool.phase === "failed" ? undefined : output}
            errorText={errorText}
          />
        </ToolContent>
      ) : null}
    </Tool>
  );
});

function parseSerialized(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

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
    <Collapsible className={cn("group/process mb-3 border-b border-border/50 pb-2", className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs tracking-wide text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
        <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/process:rotate-180" aria-hidden />
        <span className="shrink-0 font-mono">本轮过程</span>
        {meta ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/75">{meta}</span> : <span className="min-w-0 flex-1" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-2">
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
