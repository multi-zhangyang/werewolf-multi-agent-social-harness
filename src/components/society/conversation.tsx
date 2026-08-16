import { useEffect, useRef, useState, type ReactNode } from "react";
import { Send, Sparkles } from "lucide-react";
import type { SocialMessage, WorldLogEntry } from "@/society/contracts";
import type { SocietyPlayerState, SocietyRoomSnapshot } from "@/society/room";
import type { LiveAgentActivity } from "./use-room";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { AgentAvatar, ChannelBadge, formatTime } from "./shared";

type TimelineEntry =
  | { kind: "log"; id: string; time: number; text: string; turn: number; phase: string }
  | { kind: "message"; id: string; time: number; message: SocialMessage };

interface ConversationProps {
  room: SocietyRoomSnapshot;
  activity: Record<string, LiveAgentActivity>;
  onAction: (action: string, payload: unknown) => Promise<void>;
}

export function Conversation({ room, activity, onAction }: ConversationProps): ReactNode {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");

  const entries = useTimeline(room.world.messages, room.world.log);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, room.updatedAt]);

  const human = room.player;
  const humanAction = human?.waiting ? human.actions : [];
  const messageAction = humanAction.find((action) => action.kind === "message");
  const waitingLabel = human?.activationLabel;

  const submit = async (): Promise<void> => {
    if (!messageAction || !draft.trim()) return;
    await onAction(messageAction.name, { text: draft.trim(), channel: "public" });
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-6">
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-xs text-zinc-500">
            <Sparkles className="size-3.5 text-emerald-400" />
            {room.world.summary}
          </div>
          <LiveAgents room={room} activity={activity} />
          <div className="space-y-5">
            {entries.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center text-center">
                <p className="text-sm font-medium text-zinc-400">世界正在苏醒</p>
                <p className="mt-1 text-xs text-zinc-600">参与者入场后，对话将在这里实时出现。</p>
              </div>
            ) : (
              entries.map((entry) => entry.kind === "log" ? <LogEntry key={entry.id} entry={entry} /> : <MessageRow key={entry.id} entry={entry} />)
            )}
          </div>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {human?.waiting ? (
        <div className="border-t border-white/[0.06] bg-[#0b0b0b] px-5 py-4">
          {waitingLabel ? (
            <p className="mb-3 text-xs font-medium text-zinc-400">
              轮到你：<span className="text-zinc-100">{waitingLabel}</span>
            </p>
          ) : null}
          <div className="space-y-3">
            {messageAction ? (
              <div className="flex items-center gap-2">
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
                  placeholder={messageAction.channels?.includes("private") ? "发言（公开频道）…" : "发言…"}
                  maxLength={800}
                  className="h-10 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                />
                <Button size="icon" className="rounded-lg bg-zinc-50 text-zinc-950 hover:bg-white" disabled={!draft.trim()} onClick={() => void submit()}>
                  <Send className="size-4" />
                </Button>
              </div>
            ) : null}
            <ActionRow actions={humanAction.filter((action) => action.kind !== "message")} room={room} onAction={onAction} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LiveAgents({ room, activity }: { room: SocietyRoomSnapshot; activity: Record<string, LiveAgentActivity> }): ReactNode {
  const active = room.participants.filter((participant) => {
    const state = activity[participant.profile.id];
    return state?.text || state?.tool;
  });
  if (!active.length) return null;
  return (
    <div className="mb-5 space-y-2">
      {active.map((participant) => {
        const state = activity[participant.profile.id];
        return (
          <div key={participant.profile.id} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <AgentAvatar name={participant.profile.displayName} index={participant.profile.id.length} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-zinc-300">{participant.profile.displayName}</p>
              <p className="truncate font-mono text-[10px] text-zinc-500">
                {state?.tool ? `正在调用 ${state.tool}` : state?.text ? state.text : "思考中"}
              </p>
            </div>
            <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />
          </div>
        );
      })}
    </div>
  );
}

function LogEntry({ entry }: { entry: Extract<TimelineEntry, { kind: "log" }> }): ReactNode {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      <div className="max-w-[70%] text-center">
        <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">R{entry.turn} · {entry.phase}</p>
        <p className="mt-1 text-[13px] leading-5 text-zinc-400">{entry.text}</p>
      </div>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </div>
  );
}

function MessageRow({ entry }: { entry: Extract<TimelineEntry, { kind: "message" }> }): ReactNode {
  const { message } = entry;
  const privateChat = message.channel !== "public";
  return (
    <div className="group flex gap-3">
      <AgentAvatar name={message.senderName} index={indexOf(message.senderId)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-zinc-200">{message.senderName}</span>
          <ChannelBadge channel={message.channel} />
          {message.recipientIds?.length ? (
            <span className="font-mono text-[10px] text-zinc-600">→ {message.recipientIds.length} 人</span>
          ) : null}
          <span className="font-mono text-[10px] text-zinc-600">{formatTime(message.createdAt)}</span>
        </div>
        <div className={cn(
          "mt-1.5 rounded-xl rounded-tl-sm border px-3.5 py-2.5 text-[13.5px] leading-6",
          privateChat
            ? "border-violet-400/15 bg-violet-400/[0.06] text-zinc-300"
            : "border-white/[0.06] bg-white/[0.03] text-zinc-200"
        )}>
          {message.text}
        </div>
      </div>
    </div>
  );
}

function ActionRow({ actions, room, onAction }: { actions: SocietyPlayerState["actions"]; room: SocietyRoomSnapshot; onAction: (action: string, payload: unknown) => Promise<void> }): ReactNode {
  if (!actions.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action) => (
        <ActionButton key={action.name} action={action} room={room} onAction={onAction} />
      ))}
    </div>
  );
}

function ActionButton({ action, room, onAction }: { action: SocietyPlayerState["actions"][number]; room: SocietyRoomSnapshot; onAction: (action: string, payload: unknown) => Promise<void> }): ReactNode {
  const [value, setValue] = useState<string>(action.kind === "choice" ? action.options?.[0]?.value ?? "" : "");
  const [busy, setBusy] = useState(false);

  const run = async (payload: unknown): Promise<void> => {
    setBusy(true);
    try {
      await onAction(action.name, payload);
    } finally {
      setBusy(false);
    }
  };

  if (action.kind === "choice") {
    return (
      <div className="flex items-center gap-2">
        {action.options?.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run({ [action.field ?? "choice"]: option.value === "true" })}
            className="rounded-lg border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100"
          >
            {option.label}
          </Button>
        ))}
      </div>
    );
  }

  if (action.kind === "number") {
    const min = action.min ?? 0;
    const max = action.max ?? 10;
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={action.step ?? 1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="h-9 w-24 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 font-mono text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
        <Button size="sm" disabled={busy} onClick={() => void run({ [action.field ?? "value"]: Number(value) })} className="rounded-lg bg-zinc-50 text-zinc-950 hover:bg-white">
          {action.label}
        </Button>
      </div>
    );
  }

  if (action.kind === "target") {
    const targets = room.world.agents.filter((agent) => agent.id !== room.player?.actorId && agent.alive);
    return (
      <div className="flex flex-wrap items-center gap-2">
        {targets.map((target) => (
          <Button key={target.id} size="sm" variant="outline" disabled={busy} onClick={() => void run({ [action.field ?? "targetId"]: target.id })} className="rounded-lg border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100">
            {target.displayName}
          </Button>
        ))}
      </div>
    );
  }

  return null;
}

function useTimeline(messages: SocialMessage[], log: WorldLogEntry[]): TimelineEntry[] {
  const messageEntries: TimelineEntry[] = messages.map((message) => ({
    kind: "message",
    id: message.id,
    time: Date.parse(message.createdAt),
    message
  }));
  const logEntries: TimelineEntry[] = log.map((entry) => ({
    kind: "log",
    id: entry.id,
    time: Date.parse(entry.at),
    text: entry.text,
    turn: entry.turn,
    phase: entry.phase
  }));
  return [...messageEntries, ...logEntries]
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => left.time - right.time);
}

function indexOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}
