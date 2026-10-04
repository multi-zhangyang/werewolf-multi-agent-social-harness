import { memo, useLayoutEffect } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowDownLeft, ArrowUpRight, Check, Flag, HandCoins, LockKeyhole, ReceiptText, ScanEye, ShieldCheck } from "lucide-react";
import type { ActorId, PublicActor, WorldEvent } from "@/partners/contracts";
import type { ToolActivity } from "@/partners/api-types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { AgentRuntime, streamedMessageDraft } from "./agent-runtime";

const actionKinds = new Set(["offer", "investment", "settlement", "repair", "response"]);
const actionTools = new Set(["offer", "invest", "settle", "repair", "respond"]);
const boundaryKinds = new Set(["opening", "round", "closed"]);
const actionNames: Partial<Record<WorldEvent["kind"], string>> = { offer: "提出承诺", investment: "投入资源", settlement: "分配收益", repair: "回应失约", response: "决定是否继续" };

const EventRow = memo(function EventRow({ event, selected, onSelect }: { event: WorldEvent; selected: boolean; onSelect: (id: string) => void }) {
  const Icon = event.kind === "investment" ? ArrowUpRight : event.kind === "settlement" ? ArrowDownLeft : event.kind === "offer" ? ShieldCheck : event.kind === "repair" ? HandCoins : event.kind === "response" ? Check : event.visibility !== "public" ? LockKeyhole : ReceiptText;
  return <div data-event-id={event.id}>
    <Button variant={selected ? "secondary" : "ghost"} className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left" onClick={() => onSelect(event.id)} aria-pressed={selected}>
      <Icon data-icon="inline-start" />
      <span className="min-w-0 whitespace-normal text-sm font-normal leading-6">{event.summary}</span>
      {event.visibility !== "public" && <LockKeyhole data-icon="inline-end" aria-label="私有记录" />}
    </Button>
  </div>;
});

function Boundary({ event }: { event: WorldEvent }) {
  return <div className="flex items-center gap-3 py-3" data-event-id={event.id}>
    <Flag className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="shrink text-xs leading-5 text-muted-foreground">{event.kind === "opening" ? "第 1 轮" : event.summary}</span>
    <Separator className="min-w-5 flex-1" />
  </div>;
}

interface Turn { revision: number; events: WorldEvent[]; activities: ToolActivity[] }
interface TurnProps { turn: Turn; actors: Record<ActorId, PublicActor>; self?: ActorId; selectedEvent?: string; onSelect: (id: string) => void }

/** A turn keeps its identity from the first stream chunk through the committed ledger. */
const AgentTurn = memo(function AgentTurn({ turn, actors, self, selectedEvent, onSelect }: TurnProps) {
  const primary = turn.events.find(event => actionKinds.has(event.kind));
  const speech = turn.events.find(event => event.kind === "message");
  const actorId = primary?.actor ?? speech?.actor ?? turn.activities[0]?.actorId;
  const boundaries = turn.events.filter(event => boundaryKinds.has(event.kind));
  const facts = turn.events.filter(event => !boundaryKinds.has(event.kind) && event.kind !== "message" && event.kind !== "intent");
  if (!actorId) return <>{turn.events.map(event => boundaryKinds.has(event.kind) ? <Boundary key={event.id} event={event} /> : <EventRow key={event.id} event={event} selected={selectedEvent === event.id} onSelect={onSelect} />)}</>;
  const actor = actors[actorId];
  const committed = Boolean(primary || speech);
  const running = turn.activities.some(item => item.status === "running");
  const latestModel = turn.activities.findLast(item => item.kind === "model" && item.channel !== "shadow");
  const draftArguments = latestModel?.stream?.toolCalls?.find(call => actionTools.has(call.name ?? ""))?.arguments;
  const draft = committed ? "" : streamedMessageDraft(draftArguments ?? latestModel?.stream?.outputText ?? "");
  const text = speech ? typeof speech.data.text === "string" ? speech.data.text : speech.summary : draft;
  const selected = turn.events.some(event => event.id === selectedEvent);
  return <>
    <Message from="assistant" className="max-w-none gap-0" data-turn-revision={turn.revision} data-selected={selected || undefined}>
      <div className="flex items-start gap-3 py-3 md:gap-4">
        <Avatar className="mt-0.5 size-8 shrink-0"><AvatarFallback>{actor.name.slice(0, 1)}</AvatarFallback></Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex min-h-7 items-center gap-2">
            <span className="text-sm font-semibold">{actor.name}{actorId === self ? " · 你" : ""}</span>
            <span className="text-xs text-muted-foreground">{primary ? actionNames[primary.kind] : running ? "正在决策" : "本次未提交"}</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">{String(turn.revision).padStart(2, "0")}</span>
            {(primary || speech) && <MessageActions><MessageAction label="回看这次行动" tooltip="查看此时的心理与协议" aria-pressed={selected} onClick={() => onSelect((primary ?? speech)!.id)}><ScanEye /></MessageAction></MessageActions>}
          </div>
          {text && <MessageContent className="w-full" data-event-id={speech?.id} data-testid={draft ? "agent-message-draft" : undefined}>
            {draft && <span className="text-xs text-muted-foreground">发言草稿 · 尚未发送</span>}
            <MessageResponse>{text}</MessageResponse>
          </MessageContent>}
          {turn.activities.length > 0 && <AgentRuntime actor={actor} revision={turn.revision - 1} activities={turn.activities} />}
          {facts.length > 0 && <div className="flex flex-col gap-0.5 border-l-2 border-border pl-2" data-testid="turn-ledger">
            {facts.map(event => <EventRow key={event.id} event={event} selected={selectedEvent === event.id} onSelect={onSelect} />)}
          </div>}
        </div>
      </div>
    </Message>
    {boundaries.map(event => <Boundary key={event.id} event={event} />)}
  </>;
});

function FollowActivity({ active }: { active: boolean }) {
  const { stopScroll, scrollToBottom, scrollRef } = useStickToBottomContext();
  useLayoutEffect(() => {
    if (!active) { stopScroll(); return; }
    const scroll = scrollRef.current;
    if (scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 3) void scrollToBottom("instant");
  }, [active, stopScroll, scrollToBottom, scrollRef]);
  return null;
}

/** AI Elements follows active output; settled history releases its follow lock. */
export function PartnersConversation({ events, actors, self, selectedEvent, onSelect, activities = [], active = false }: { events: WorldEvent[]; actors: Record<ActorId, PublicActor>; self?: ActorId; selectedEvent?: string; onSelect: (id: string) => void; activities?: ToolActivity[]; active?: boolean }) {
  const turns = new Map<number, Turn>();
  const getTurn = (revision: number) => { let turn = turns.get(revision); if (!turn) { turn = { revision, events: [], activities: [] }; turns.set(revision, turn); } return turn; };
  for (const event of events) getTurn(event.revision).events.push(event);
  for (const activity of activities) getTurn(activity.revision + 1).activities.push(activity);
  return <Conversation className="h-full min-w-0" initial="instant" resize="instant" aria-label="对话与交易时间线" data-testid="partners-conversation">
    {({ stopScroll }) => <>
      <FollowActivity active={active} />
      <ConversationContent scrollClassName="overflow-y-auto overscroll-contain" className="mx-auto w-full max-w-4xl gap-1 px-4 py-3 md:px-7" onFocusCapture={stopScroll}>
        {[...turns.values()].sort((a, b) => a.revision - b.revision).map(turn => <AgentTurn key={turn.revision} turn={turn} actors={actors} self={self} selectedEvent={selectedEvent} onSelect={onSelect} />)}
      </ConversationContent>
      <ConversationScrollButton aria-label="回到最新事件" />
    </>}
  </Conversation>;
}
