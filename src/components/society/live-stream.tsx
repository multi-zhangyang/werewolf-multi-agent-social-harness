import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Hourglass, Wrench } from "lucide-react";
import type { SocialMessage } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import type { EffectiveViewer, LiveTurn, RoomConnection } from "./use-room";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { AgentAvatar, ChannelBadge, channelSurface, eventLabel, formatTime, ScenarioIcon } from "./shared";
import { TurnCard } from "./turn-card";

/**
 * The centerpiece: one chronological live stream answering "谁在干什么、
 * 说到哪了" — phase dividers, settled speech bubbles and in-flight turn
 * cards interleaved in true order, auto-following while agents speak.
 */

interface StreamItem {
  id: string;
  at: number;
  sort: string;
  render: ReactNode;
}

export const LiveStream = memo(function LiveStream({
  room,
  turns,
  viewer,
  onSubmitAction,
  avatarSeedFor
}: {
  room: SocietyRoomSnapshot;
  turns: LiveTurn[];
  viewer: EffectiveViewer | null;
  onSubmitAction?: RoomConnection["submitAction"];
  avatarSeedFor: (actorId: string) => string | undefined;
}): ReactNode {
  const names = new Map(room.world.agents.map((agent) => [agent.id, agent.displayName]));
  const canSeeCognition = viewer?.mode === "omniscient"
    || (viewer?.mode === "agent-pov" && Boolean(viewer.agentId))
    || (viewer?.mode === "postgame" && viewer.privileged === true);

  const items = useMemo(() => buildStreamItems(room, turns, names, canSeeCognition, avatarSeedFor), [room, turns, names, canSeeCognition, avatarSeedFor]);
  return <StreamItems items={items} room={room} onSubmitAction={onSubmitAction} />;
});

function StreamItems({ items, room, onSubmitAction }: {
  items: StreamItem[];
  room: SocietyRoomSnapshot;
  onSubmitAction?: RoomConnection["submitAction"];
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastCountRef = useRef(0);

  useEffect(() => {
    if (items.length !== lastCountRef.current) {
      lastCountRef.current = items.length;
      if (stickRef.current) scrollToBottom();
    }
  }, [items.length]);

  const scrollToBottom = (): void => {
    const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ScrollArea
        ref={scrollRef}
        className="min-h-0 flex-1"
        onScroll={(event) => {
          const viewport = event.currentTarget.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
          if (!viewport) return;
          stickRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 py-4">
          {items.map((item) => <div key={item.id}>{item.render}</div>)}
          {!items.length ? (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyTitle>等待世界苏醒</EmptyTitle>
                <EmptyDescription>第一个 agent 开始思考时，全过程会在这里直播。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </div>
      </ScrollArea>
      <HumanActionBar room={room} onSubmitAction={onSubmitAction} />
    </div>
  );
}

function buildStreamItems(
  room: SocietyRoomSnapshot,
  turns: LiveTurn[],
  names: Map<string, string>,
  canSeeCognition: boolean,
  avatarSeedFor: (actorId: string) => string | undefined
): StreamItem[] {
  const items: StreamItem[] = [];
  for (const entry of room.world.log) {
    items.push({
      id: `log:${entry.id}`,
      at: Date.parse(entry.at),
      sort: entry.at,
      render: <PhaseDivider key={entry.id} text={entry.text} beat={entry.beat} />
    });
  }
  const messages = room.world.messages ?? [];
  const matchedTurnIds = new Set<string>();
  for (const message of messages) {
    // Attach the actor's most recent completed turn whose window covers the message.
    const turn = [...turns]
      .filter((candidate) => candidate.actorId === message.senderId)
      .reverse()
      .find((candidate) => {
        const start = Date.parse(candidate.startedAt);
        const end = candidate.completedAt ? Date.parse(candidate.completedAt) : Number.POSITIVE_INFINITY;
        const sentAt = Date.parse(message.createdAt);
        return sentAt >= start - 2_000 && sentAt <= end + 60_000;
      });
    if (turn) matchedTurnIds.add(turn.id);
    items.push({
      id: `msg:${message.id}`,
      at: Date.parse(message.createdAt),
      sort: message.createdAt,
      render: (
        <MessageBubble
          key={message.id}
          message={message}
          name={names.get(message.senderId) ?? message.senderId}
          seed={avatarSeedFor(message.senderId)}
          turn={turn}
          canSeeCognition={canSeeCognition}
        />
      )
    });
  }
  // Turns that produced no persisted message stay visible as their own cards
  // (action-only activations, or speech still streaming before commit).
  for (const turn of turns) {
    if (matchedTurnIds.has(turn.id)) continue;
    const live = !turn.completedAt;
    if (!live && !turn.outputText && !turn.tools.length && !turn.reasoning) continue;
    items.push({
      id: `turn:${turn.id}`,
      at: Date.parse(turn.startedAt),
      sort: turn.startedAt,
      render: (
        <TurnCard
          key={turn.id}
          turn={turn}
          name={names.get(turn.actorId) ?? turn.actorId}
          seed={avatarSeedFor(turn.actorId)}
          canSeeCognition={canSeeCognition}
        />
      )
    });
  }
  return items.sort((left, right) => left.at - right.at);
}

const MessageBubble = memo(function MessageBubble({
  message,
  name,
  seed,
  turn,
  canSeeCognition
}: {
  message: SocialMessage;
  name: string;
  seed?: string;
  turn?: LiveTurn;
  canSeeCognition: boolean;
}): ReactNode {
  return (
    <article className={cn("enter-stage rounded-xl border p-3 transition-colors", channelSurface[message.channel], "hover:border-foreground/15")}>
      <header className="mb-1.5 flex items-center gap-2">
        <AgentAvatar name={name} seed={seed} size="sm" />
        <span className="text-sm font-medium">{name}</span>
        {message.channel !== "public" ? <ChannelBadge channel={message.channel} /> : null}
        <time className="ml-auto font-mono text-[10px] text-muted-foreground/60">{formatTime(message.createdAt, { seconds: false })}</time>
      </header>
      <div className="text-sm leading-relaxed [&_p]:my-0">{message.text}</div>
      {turn && canSeeCognition && (turn.reasoning || turn.tools.length) ? (
        <details className="group/process mt-2 border-t border-border/50 pt-2 text-xs text-muted-foreground">
          <summary className="flex w-full cursor-pointer list-none select-none items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] uppercase hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3 transition-transform group-open/process:rotate-180" aria-hidden />
            本轮过程
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {turn.reasoning?.text ? <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-sans leading-relaxed">{turn.reasoning.text}</pre> : null}
            {turn.tools.map((tool) => (
              <p key={tool.toolCallId} className="flex items-center gap-1.5"><Wrench className="size-3 shrink-0" aria-hidden />{tool.label ?? eventLabel(tool.toolName)}{tool.safeOutputSummary ? ` · ${tool.safeOutputSummary}` : ""}</p>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
});

function PhaseDivider({ text, beat }: { text: string; beat?: string }): ReactNode {
  return (
    <div className="cue-enter flex items-center gap-3 py-2" role="separator">
      <span className="h-px w-8 shrink-0 bg-gradient-to-r from-transparent to-foreground/15 sm:w-auto sm:flex-1" />
      <span className={cn("min-w-0 rounded-full border px-3.5 py-1 text-xs leading-5 backdrop-blur-sm", beat ? "border-warn/25 bg-warn/[0.06] text-warn/90" : "border-border bg-muted/40 text-muted-foreground")}>
        {beat ? `★ ${beat} · ` : ""}{text}
      </span>
      <span className="h-px w-8 shrink-0 bg-gradient-to-l from-transparent to-foreground/15 sm:w-auto sm:flex-1" />
    </div>
  );
}

/** Human participant action bar — only rendered when a human seat is waiting. */
function HumanActionBar({ room, onSubmitAction }: { room: SocietyRoomSnapshot; onSubmitAction?: RoomConnection["submitAction"] }): ReactNode {
  const player = room.player;
  const [draft, setDraft] = useState("");
  if (!player?.waiting || player.actions.length === 0) return null;
  const messageAction = player.actions.find((action) => action.kind === "message");
  const otherActions = player.actions.filter((action) => action.kind !== "message");

  const send = (): void => {
    const text = draft.trim();
    if (!text || !onSubmitAction) return;
    void onSubmitAction("communicate", { text, channel: "public" });
    setDraft("");
  };

  return (
    <footer className="border-t border-border bg-background/80 p-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
        <Hourglass className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-xs text-muted-foreground">{player.displayName} · 轮到你了</span>
        {messageAction ? (
          <>
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") send(); }}
              placeholder="以你的身份发言…"
              className="h-8 min-w-0 flex-1 text-sm"
            />
            <Button size="sm" className="shrink-0" onClick={send} disabled={!draft.trim()}>发送</Button>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {otherActions.map((action) => (
            <Button key={action.name} size="sm" variant="secondary" onClick={() => onSubmitAction?.(action.name, {})}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </footer>
  );
}

// Re-export so the shell can render the scenario icon next to the phase strip.
export { ScenarioIcon };
