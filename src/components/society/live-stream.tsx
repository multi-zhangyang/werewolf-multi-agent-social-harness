import { memo, useMemo, useState, type ReactNode } from "react";
import { Hourglass } from "lucide-react";
import type { SocialMessage } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import type { EffectiveViewer, LiveTurn, RoomConnection } from "./use-room";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { AgentAvatar, beatLabel, ChannelBadge, formatTime, ScenarioIcon } from "./shared";
import { belongsToCluster } from "./stream-cluster";
import { TurnCard } from "./turn-card";
import { SettledTurnProcess } from "./turn-cognition";
import type { NameResolver } from "./tool-summary";

/**
 * The centerpiece: one chronological live stream answering "谁在干什么、
 * 说到哪了" — phase dividers, settled speech bubbles and in-flight turn
 * cards interleaved in true order, auto-following while agents speak.
 * An actor's consecutive messages collapse into one card with stacked
 * paragraphs, so a monologue reads as one utterance instead of card spam.
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

  // Tool payloads reference actor/character ids; summaries speak in names.
  const resolveName = useMemo<NameResolver>(() => {
    const agentNames = new Map(room.world.agents.map((agent) => [agent.id, agent.displayName]));
    const characterNames = new Map((room.participants ?? []).map((participant) => [participant.profile.characterId, participant.profile.displayName]));
    return (id) => agentNames.get(id) ?? characterNames.get(id);
  }, [room.participants, room.world.agents]);

  const items = useMemo(
    () => buildStreamItems(room, turns, names, canSeeCognition, avatarSeedFor, resolveName),
    [room, turns, names, canSeeCognition, avatarSeedFor, resolveName]
  );
  return <StreamItems items={items} room={room} onSubmitAction={onSubmitAction} />;
});

function StreamItems({ items, room, onSubmitAction }: {
  items: StreamItem[];
  room: SocietyRoomSnapshot;
  onSubmitAction?: RoomConnection["submitAction"];
}): ReactNode {
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-2xl gap-6 px-5 pt-6 pb-10">
          {items.map((item) => (
            // The anchor id lets the storyline bar scroll the stream to any
            // retained chapter (log entries render as phase dividers).
            <div key={item.id} id={`anchor:${item.id}`}>{item.render}</div>
          ))}
          {!items.length ? (
            <ConversationEmptyState
              title="等待世界苏醒"
              description="第一个 agent 开始思考时，全过程会在这里直播。"
              icon={<ScenarioIcon id={room.scenarioId} className="size-5" />}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton aria-label="回到最新动态" />
      </Conversation>
      <HumanActionBar room={room} onSubmitAction={onSubmitAction} />
    </div>
  );
}

type StreamEntry =
  | { id: string; at: number; sort: string; kind: "log"; text: string; beat?: string }
  | { id: string; at: number; sort: string; kind: "message"; message: SocialMessage; turn?: LiveTurn }
  | { id: string; at: number; sort: string; kind: "turn"; turn: LiveTurn };

function buildStreamItems(
  room: SocietyRoomSnapshot,
  turns: LiveTurn[],
  names: Map<string, string>,
  canSeeCognition: boolean,
  avatarSeedFor: (actorId: string) => string | undefined,
  resolveName: NameResolver
): StreamItem[] {
  const entries: StreamEntry[] = [];
  for (const entry of room.world.log) {
    entries.push({ id: `log:${entry.id}`, at: Date.parse(entry.at), sort: entry.at, kind: "log", text: entry.text, beat: entry.beat });
  }
  const matchedTurnIds = new Set<string>();
  for (const message of room.world.messages ?? []) {
    // New records carry an exact message link. The time window remains only
    // for backward-compatible archives created before durable turns existed.
    const exact = turns.find((candidate) => candidate.messageId === message.id);
    const turn = exact ?? [...turns]
      .filter((candidate) => candidate.actorId === message.senderId && !candidate.messageId)
      .reverse()
      .find((candidate) => {
        const start = Date.parse(candidate.startedAt);
        const end = candidate.completedAt ? Date.parse(candidate.completedAt) : Number.POSITIVE_INFINITY;
        const sentAt = Date.parse(message.createdAt);
        return sentAt >= start - 2_000 && sentAt <= end + 60_000;
      });
    if (turn) matchedTurnIds.add(turn.id);
    entries.push({ id: `msg:${message.id}`, at: Date.parse(message.createdAt), sort: message.createdAt, kind: "message", message, turn });
  }
  // Turns that produced no persisted message stay visible as their own cards
  // (action-only activations, or speech still streaming before commit).
  for (const turn of turns) {
    if (matchedTurnIds.has(turn.id)) continue;
    const live = !turn.completedAt;
    if (!live && !turn.outputText && !turn.tools.length && !turn.reasoning) continue;
    entries.push({ id: `turn:${turn.id}`, at: Date.parse(turn.startedAt), sort: turn.startedAt, kind: "turn", turn });
  }
  entries.sort((left, right) => left.at - right.at);

  const items: StreamItem[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.kind === "log") {
      items.push({ id: entry.id, at: entry.at, sort: entry.sort, render: <PhaseDivider text={entry.text} beat={entry.beat} /> });
      index += 1;
      continue;
    }
    if (entry.kind === "turn") {
      items.push({
        id: entry.id,
        at: entry.at,
        sort: entry.sort,
        render: (
          <TurnCard
            turn={entry.turn}
            name={names.get(entry.turn.actorId) ?? entry.turn.actorId}
            seed={avatarSeedFor(entry.turn.actorId)}
            canSeeCognition={canSeeCognition}
            resolveName={resolveName}
          />
        )
      });
      index += 1;
      continue;
    }
    // Same actor, same channel, within 15 minutes, nothing in between: one
    // card, stacked paragraphs (chat-app grouping for an agent's monologue).
    const cluster: Extract<StreamEntry, { kind: "message" }>[] = [entry];
    let cursor = index + 1;
    while (cursor < entries.length) {
      const next = entries[cursor]!;
      if (next.kind !== "message") break;
      if (!belongsToCluster(cluster[cluster.length - 1]!.message, next.message)) break;
      cluster.push(next);
      cursor += 1;
    }
    const name = names.get(entry.message.senderId) ?? entry.message.senderId;
    const seed = avatarSeedFor(entry.message.senderId);
    items.push(
      cluster.length === 1
        ? {
            id: entry.id,
            at: entry.at,
            sort: entry.sort,
            render: <MessageBubble message={entry.message} name={name} seed={seed} turn={entry.turn} canSeeCognition={canSeeCognition} resolveName={resolveName} />
          }
        : {
            id: `cluster:${cluster[0]!.id}`,
            at: cluster[0]!.at,
            sort: cluster[0]!.sort,
            render: (
              <MessageCluster
                messages={cluster.map((member) => member.message)}
                turns={new Map(cluster.map((member) => [member.message.id, member.turn]))}
                name={name}
                seed={seed}
                canSeeCognition={canSeeCognition}
                resolveName={resolveName}
              />
            )
          }
    );
    index = cursor;
  }
  return items;
}

const MessageBubble = memo(function MessageBubble({
  message,
  name,
  seed,
  turn,
  canSeeCognition,
  resolveName
}: {
  message: SocialMessage;
  name: string;
  seed?: string;
  turn?: LiveTurn;
  canSeeCognition: boolean;
  resolveName: NameResolver;
}): ReactNode {
  return (
    <Message from="assistant" className="enter-stage max-w-full">
      <div className="flex items-center gap-2">
        <AgentAvatar name={name} seed={seed} size="sm" />
        <span className="text-sm font-semibold tracking-tight">{name}</span>
        {message.channel !== "public" ? <ChannelBadge channel={message.channel} /> : null}
        <time className="ml-auto font-mono text-xs text-muted-foreground/60">{formatTime(message.createdAt, { seconds: false })}</time>
      </div>
      <MessageContent className="w-full max-w-full break-words text-base leading-7">
        <TurnDetails turn={turn} canSeeCognition={canSeeCognition} resolveName={resolveName} />
        <MessageResponse>{message.text}</MessageResponse>
      </MessageContent>
    </Message>
  );
});

/** Several utterances from one actor in a row: one card, stacked paragraphs. */
const MessageCluster = memo(function MessageCluster({
  messages,
  turns,
  name,
  seed,
  canSeeCognition,
  resolveName
}: {
  messages: SocialMessage[];
  turns: Map<string, LiveTurn | undefined>;
  name: string;
  seed?: string;
  canSeeCognition: boolean;
  resolveName: NameResolver;
}): ReactNode {
  const channel = messages[0]!.channel;
  return (
    <Message from="assistant" className="enter-stage max-w-full">
      <div className="flex items-center gap-2">
        <AgentAvatar name={name} seed={seed} size="sm" />
        <span className="text-sm font-semibold tracking-tight">{name}</span>
        {channel !== "public" ? <ChannelBadge channel={channel} /> : null}
        <time className="ml-auto font-mono text-xs text-muted-foreground/60">{formatTime(messages[0]!.createdAt, { seconds: false })}</time>
      </div>
      <MessageContent className="flex w-full max-w-full flex-col gap-3">
        {messages.map((message, messageIndex) => (
          <div key={message.id} className="break-words text-base leading-7">
            <TurnDetails turn={turns.get(message.id)} canSeeCognition={canSeeCognition} resolveName={resolveName} />
            <MessageResponse>{message.text}</MessageResponse>
            {messageIndex > 0 ? (
              <time className="mt-1 block font-mono text-xs text-muted-foreground/60">{formatTime(message.createdAt, { seconds: false })}</time>
            ) : null}
          </div>
        ))}
      </MessageContent>
    </Message>
  );
});

/** Privileged per-turn process (reasoning + tools); shared with the live card. */
function TurnDetails({ turn, canSeeCognition, resolveName }: {
  turn?: LiveTurn;
  canSeeCognition: boolean;
  resolveName: NameResolver;
}): ReactNode {
  if (!turn || !canSeeCognition) return null;
  return <SettledTurnProcess turn={turn} resolveName={resolveName} />;
}

function PhaseDivider({ text, beat }: { text: string; beat?: string }): ReactNode {
  return (
    <div className="cue-enter flex items-center gap-2.5 py-3" role="separator">
      <Separator className="hidden flex-1 sm:block" />
      <Badge variant={beat ? "secondary" : "outline"} className="max-w-full whitespace-normal px-3 py-1 text-center text-xs leading-5 font-normal tracking-wide">
        {beat ? `★ ${beatLabel(beat)} · ` : ""}{text}
      </Badge>
      <Separator className="hidden flex-1 sm:block" />
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
    <footer className="rule-t relative bg-background/90 p-3 backdrop-blur-md shadow-[0_-12px_28px_-20px_oklch(0_0_0/0.8)]">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2">
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
