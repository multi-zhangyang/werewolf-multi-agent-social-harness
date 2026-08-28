import { memo, type ReactNode } from "react";
import { Loader2, Wrench } from "lucide-react";
import type { LiveTurn } from "./use-room";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { AgentAvatar, eventLabel, formatTime } from "./shared";

/**
 * One activation of one agent, rendered live: thinking shimmer → reasoning
 * (privileged) → tool steps (privileged) → token-streamed speech. Once the
 * activation settles, the card collapses around whatever it produced.
 */
export const TurnCard = memo(function TurnCard({
  turn,
  name,
  seed,
  canSeeCognition,
  channelLabel
}: {
  turn: LiveTurn;
  name: string;
  seed?: string;
  /** Whether this viewer may see reasoning/tool internals (omniscient / own POV). */
  canSeeCognition: boolean;
  channelLabel?: string;
}): ReactNode {
  const live = !turn.completedAt;
  const statusLine = live
    ? turn.status === "speaking"
      ? "正在发言"
      : turn.status === "acting"
        ? "正在行动"
        : "思考中"
    : turn.status === "error"
      ? "本轮失败"
      : "已完成";

  return (
    <article className={cn(
      "enter-stage group relative flex gap-3 overflow-hidden rounded-xl border bg-card/60 p-3 shadow-[0_1px_2px_oklch(0_0_0/0.18)] transition-colors",
      !live && "sheen",
      live && "live-edge border-foreground/25 bg-gradient-to-b from-foreground/[0.04] to-transparent shadow-[0_0_28px_-10px] shadow-foreground/35"
    )}>
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <span className={cn("relative inline-flex", live && "on-air")}>
          <AgentAvatar name={name} seed={seed} size="lg" />
        </span>
        {live ? <span className="size-1 animate-pulse rounded-full bg-live" aria-hidden /> : null}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{name}</span>
          {live ? (
            <Shimmer className="text-xs text-muted-foreground" duration={1.4}>{`${statusLine}…`}</Shimmer>
          ) : (
            <span className={cn("text-xs", turn.status === "error" ? "text-destructive" : "text-muted-foreground")}>{statusLine}</span>
          )}
          {channelLabel ? <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{channelLabel}</span> : null}
          <time className="ml-auto font-mono text-[10px] text-muted-foreground/85">{formatTime(turn.startedAt)}</time>
        </header>

        {canSeeCognition && turn.reasoning && (live || turn.reasoning.text) ? (
          <Reasoning isStreaming={live && !turn.reasoning.done} duration={Math.round(turn.reasoning.elapsedMs / 1000)} className="mb-0">
            <ReasoningTrigger />
            <ReasoningContent>{turn.reasoning.text}</ReasoningContent>
          </Reasoning>
        ) : null}

        {canSeeCognition && turn.tools.length ? (
          <ul className="space-y-1.5">
            {turn.tools.map((tool) => (
              <li key={tool.toolCallId} className="min-w-0 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-xs">
                <p className="flex items-center gap-1.5">
                  {tool.phase === "succeeded"
                    ? <Wrench className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                    : <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
                  <span className="font-medium">{tool.label ?? eventLabel(tool.toolName)}</span>
                </p>
                {tool.safeOutputSummary ? (
                  <p className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-muted-foreground">{tool.safeOutputSummary}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : !canSeeCognition && turn.tools.length ? (
          <p className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            {live && turn.tools.at(-1)?.phase !== "succeeded"
              ? <Loader2 className="size-3 animate-spin" aria-hidden />
              : <Wrench className="size-3" aria-hidden />}
            {live ? "正在执行绑定行动——细节仅全知视角可见。" : "本轮以绑定行动完成，未产生公开发言。"}
          </p>
        ) : null}

        {live ? (
          turn.sealed ? (
            <p className="flex items-center gap-2 rounded-lg border border-secret/25 bg-secret/5 px-3 py-2 text-xs text-secret/90">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              密封行动进行中——选择在结算前不会公开。
            </p>
          ) : turn.outputText ? (
            <div className="relative break-words text-sm leading-relaxed">
              <MessageResponse isAnimating>{turn.outputText}</MessageResponse>
              <StreamCaret />
            </div>
          ) : null
        ) : turn.outputText ? (
          <div className="break-words text-sm leading-relaxed">
            <MessageResponse>{turn.outputText}</MessageResponse>
          </div>
        ) : null}
      </div>
    </article>
  );
});

function StreamCaret(): ReactNode {
  return <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-live align-middle" aria-hidden />;
}
