import { memo, type ReactNode } from "react";
import { Wrench } from "lucide-react";
import type { LiveTurn } from "./use-room";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { AgentAvatar, formatTime } from "./shared";
import { ToolStep } from "./turn-cognition";
import type { NameResolver } from "./tool-summary";

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
  channelLabel,
  resolveName
}: {
  turn: LiveTurn;
  name: string;
  seed?: string;
  /** Whether this viewer may see reasoning/tool internals (omniscient / own POV). */
  canSeeCognition: boolean;
  channelLabel?: string;
  resolveName?: NameResolver;
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
      "enter-stage relative flex gap-3",
      // In flight: the only boxed moment — a live accent on the stage.
      // Settled, the activation joins the conversation as plain typography.
      live && "live-edge rounded-xl border border-live/20 bg-live/[0.05] p-3.5 shadow-[0_0_28px_-16px_oklch(0.77_0.15_160/0.55)]"
    )}>
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <span className={cn("relative inline-flex", live && "on-air")}>
          <AgentAvatar name={name} seed={seed} size="lg" />
        </span>
        {live ? <span className="size-1 animate-pulse rounded-full bg-live" aria-hidden /> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold tracking-tight">{name}</span>
          {live ? (
            <Shimmer className="text-xs text-muted-foreground" duration={1.4}>{`${statusLine}…`}</Shimmer>
          ) : (
            <span className={cn("text-xs", turn.status === "error" ? "text-destructive" : "text-muted-foreground")}>{statusLine}</span>
          )}
          {channelLabel ? <span className="text-xs uppercase tracking-wider text-muted-foreground">{channelLabel}</span> : null}
          <time className="ml-auto font-mono text-xs text-muted-foreground/85">{formatTime(turn.startedAt)}</time>
        </header>

        {canSeeCognition && turn.reasoning && (live || turn.reasoning.text) ? (
          <Reasoning isStreaming={live && !turn.reasoning.done} duration={Math.round(turn.reasoning.elapsedMs / 1000)} className="mb-0">
            <ReasoningTrigger />
            <ReasoningContent>{turn.reasoning.text}</ReasoningContent>
          </Reasoning>
        ) : null}

        {canSeeCognition && turn.tools.length ? (
          <ul className="flex flex-col gap-1.5">
            {turn.tools.map((tool) => (
              <li key={tool.toolCallId} className="min-w-0">
                <ToolStep tool={tool} resolveName={resolveName} />
              </li>
            ))}
          </ul>
        ) : !canSeeCognition && turn.tools.length ? (
          <p className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            {live && turn.tools.at(-1)?.phase === "started"
              ? <Spinner className="size-3" aria-hidden />
              : <Wrench className="size-3" aria-hidden />}
            {live ? "正在执行绑定行动——细节仅全知视角可见。" : "本轮以绑定行动完成，未产生公开发言。"}
          </p>
        ) : null}

        {live ? (
          turn.sealed ? (
            <p className="flex items-center gap-2 rounded-lg border border-secret/25 bg-secret/5 px-3 py-2 text-xs text-secret/90">
              <Spinner className="size-3.5" aria-hidden />
              密封行动进行中——选择在结算前不会公开。
            </p>
          ) : turn.outputText.trim() ? (
            <div className="relative break-words text-base leading-7">
              <MessageResponse isAnimating>{turn.outputText}</MessageResponse>
              <StreamCaret />
            </div>
          ) : null
        ) : turn.outputText ? (
          <div className="break-words text-base leading-7">
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
