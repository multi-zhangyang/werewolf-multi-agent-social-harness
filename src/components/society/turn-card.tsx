import { memo, type ReactNode } from "react";
import { Loader2, Wrench } from "lucide-react";
import type { LiveTurn } from "./use-room";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { AgentAvatar, eventLabel } from "./shared";

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
    <article className={cn("group relative flex gap-3 rounded-xl border bg-card/60 p-3 transition-colors", live && "border-foreground/20 shadow-[0_0_24px_-12px] shadow-foreground/30")}>
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <span className={cn("relative inline-flex", live && "on-air")}>
          <AgentAvatar name={name} seed={seed} size="lg" />
        </span>
        {live ? <span className="size-1 animate-pulse rounded-full bg-emerald-400" aria-hidden /> : null}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{name}</span>
          {live ? (
            <Shimmer className="text-xs text-muted-foreground" duration={1.4}>{`${statusLine}…`}</Shimmer>
          ) : (
            <span className={cn("text-xs", turn.status === "error" ? "text-destructive" : "text-muted-foreground")}>{statusLine}</span>
          )}
          {channelLabel ? <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{channelLabel}</span> : null}
          <time className="ml-auto font-mono text-[10px] text-muted-foreground/60">{formatClock(turn.startedAt)}</time>
        </header>

        {canSeeCognition && turn.reasoning && (live || turn.reasoning.text) ? (
          <Reasoning isStreaming={live && !turn.reasoning.done} duration={Math.round(turn.reasoning.elapsedMs / 1000)}>
            <ReasoningTrigger />
            <ReasoningContent>{turn.reasoning.text}</ReasoningContent>
          </Reasoning>
        ) : null}

        {canSeeCognition && turn.tools.length ? (
          <ul className="space-y-1">
            {turn.tools.map((tool) => (
              <li key={tool.toolCallId} className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-xs">
                {tool.phase === "succeeded"
                  ? <Wrench className="size-3 text-muted-foreground" aria-hidden />
                  : <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />}
                <span className="font-medium">{tool.label ?? eventLabel(tool.toolName)}</span>
                {tool.safeOutputSummary ? <span className="truncate text-muted-foreground">· {tool.safeOutputSummary}</span> : null}
              </li>
            ))}
          </ul>
        ) : !canSeeCognition && turn.tools.length ? (
          <p className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
            {live && turn.tools.at(-1)?.phase !== "succeeded"
              ? <Loader2 className="size-3 animate-spin" aria-hidden />
              : <Wrench className="size-3" aria-hidden />}
            {live ? "正在执行绑定行动——细节仅全知视角可见。" : "本轮以绑定行动完成，未产生公开发言。"}
          </p>
        ) : null}

        {live ? (
          turn.sealed ? (
            <p className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/5 px-3 py-2 text-xs text-violet-300/90">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              密封行动进行中——选择在结算前不会公开。
            </p>
          ) : turn.outputText ? (
            <div className="relative text-sm leading-relaxed">
              <MessageResponse isAnimating>{turn.outputText}</MessageResponse>
              <StreamCaret />
            </div>
          ) : null
        ) : turn.outputText ? (
          <div className="text-sm leading-relaxed">
            <MessageResponse>{turn.outputText}</MessageResponse>
          </div>
        ) : null}
      </div>
    </article>
  );
});

function StreamCaret(): ReactNode {
  return <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-emerald-400 align-middle" aria-hidden />;
}

function formatClock(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
