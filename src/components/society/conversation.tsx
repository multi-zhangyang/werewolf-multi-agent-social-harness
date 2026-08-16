import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, Check, Send, Sparkles } from "lucide-react";
import type { SocialMessage, WorldLogEntry } from "@/society/contracts";
import type { SocietyPlayerState, SocietyRoomSnapshot } from "@/society/room";
import type { LiveAgentActivity } from "./use-room";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  AgentAvatar,
  AgentPresence,
  ChannelBadge,
  SpeechBars,
  channelSurface,
  eventLabel,
  formatTime
} from "./shared";

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
  const names = useMemo(() => new Map(room.participants.map((p) => [p.profile.id, p.profile.displayName])), [room.participants]);

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
      <div className="flex items-center gap-3 border-b border-white/[0.05] px-6 py-4">
        <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400">
          <Sparkles className="size-4 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium tracking-tight text-zinc-200">{room.world.summary}</p>
          <p className="mt-0.5 text-xs text-zinc-500">实时直播 · 发言与行动</p>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-6">
          <LiveAgents room={room} activity={activity} names={names} />

          <div className="space-y-5">
            {entries.length === 0 ? (
              <CastingSlate room={room} />
            ) : (
              entries.map((entry, index) => entry.kind === "log"
                ? <ActDivider key={entry.id} entry={entry} />
                : <MessageRow key={entry.id} entry={entry} names={names} activity={activity} fresh={index >= entries.length - 3 && entry.message.turn === room.world.turn} />)
            )}
          </div>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {human?.waiting ? (
        <div className="border-t border-white/[0.06] bg-[#050505]/95 px-6 py-4">
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
                  placeholder="发言…"
                  className="h-11 flex-1 rounded-full border border-white/[0.08] bg-white/[0.02] px-5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                />
                <Button size="icon" className="size-11 rounded-full bg-zinc-50 text-zinc-950 hover:bg-white" disabled={!draft.trim()} onClick={() => void submit()}>
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

function CastingSlate({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  return (
    <div className="relative flex min-h-56 flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/[0.05]">
      <div className="shimmer absolute inset-0" aria-hidden />
      <div className="relative flex items-center gap-3">
        {room.participants.slice(0, 5).map((participant, index) => (
          <AgentAvatar
            key={participant.profile.id}
            name={participant.profile.displayName}
            index={index}
            size={index === 2 ? "lg" : "md"}
            />
        ))}
      </div>
      <p className="relative mt-4 font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">正在唤醒世界</p>
    </div>
  );
}

function LiveAgents({ room, activity, names }: {
  room: SocietyRoomSnapshot;
  activity: Record<string, LiveAgentActivity>;
  names: Map<string, string>;
}): ReactNode {
  const active = room.participants.filter((participant) => {
    const state = activity[participant.profile.id];
    const status = participant.status;
    return (status === "thinking" || status === "acting" || status === "speaking") || Boolean(state?.text || state?.reasoning || state?.thought || state?.tool);
  });
  if (!active.length) return null;
  return (
    <div className="mb-8 space-y-3">
      {active.map((participant) => {
        const state = activity[participant.profile.id];
        const caption = state?.tool
          ? `正在调用 ${eventLabel(state.tool)}`
          : participant.status === "speaking"
            ? "正在发言"
            : participant.status === "acting"
              ? "正在行动"
              : state?.text
                ? "斟酌措辞中"
                : state?.thought || state?.reasoning
                  ? "心中盘算"
                  : "思考中";
        return (
          <div key={participant.profile.id} className="enter-stage overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015]">
            <div className="flex items-center gap-3 px-4 py-3">
              <AgentPresence name={participant.profile.displayName} index={indexOf(participant.profile.id)} size="md" status={participant.status} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  {participant.profile.displayName}
                  {participant.status === "speaking" ? <SpeechBars /> : <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />}
                </p>
                <p className="truncate text-xs text-zinc-500">{caption}</p>
              </div>
              <span className="font-mono text-[10px] text-zinc-600">{formatTime(state?.at ?? new Date().toISOString())}</span>
            </div>
            {state?.reasoning ? (
              <div className="mx-4 mb-3 rounded-xl border border-sky-400/10 bg-sky-400/[0.03] px-3.5 py-2.5">
                <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-sky-300/60">
                  <Brain className="size-3" /> 内心推理
                </p>
                <p className="stream-caret line-clamp-4 font-mono text-xs leading-5 text-zinc-400">{state.reasoning}</p>
              </div>
            ) : null}
            {state?.thought ? (
              <div className="mx-4 mb-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-3.5 py-2.5">
                <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  <Brain className="size-3" /> {thoughtLabel(state.thought.kind)}
                </p>
                <p className="stream-caret line-clamp-4 text-xs leading-5 text-zinc-400">{state.thought.text}</p>
              </div>
            ) : null}
            {state?.text ? (
              <div className="mx-4 mb-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-3.5 py-2.5">
                <p className="stream-caret line-clamp-3 text-xs leading-5 text-zinc-300">{state.text}</p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function thoughtLabel(kind: "reflection" | "mind-read" | "plan"): string {
  return kind === "reflection" ? "策略反思" : kind === "mind-read" ? "洞察他人" : "谋划行动";
}

function ActDivider({ entry }: { entry: Extract<TimelineEntry, { kind: "log" }> }): ReactNode {
  return (
    <div className="flex items-center gap-5 py-2">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/15" />
      <div className="text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-600">第 {entry.turn} 幕</p>
        <p className="mt-1 text-sm font-medium tracking-tight text-zinc-300">{entry.text}</p>
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/15" />
    </div>
  );
}

function MessageRow({ entry, names, activity, fresh }: {
  entry: Extract<TimelineEntry, { kind: "message" }>;
  names: Map<string, string>;
  activity: Record<string, LiveAgentActivity>;
  fresh: boolean;
}): ReactNode {
  const { message } = entry;
  const privateChat = message.channel !== "public";
  const senderLive = Boolean(activity[message.senderId]?.text) && fresh;
  return (
    <div className={cn("group flex gap-3.5", fresh && "enter-stage")}>
      <AgentAvatar name={message.senderName} index={indexOf(message.senderId)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-zinc-100">{message.senderName}</span>
          <ChannelBadge channel={message.channel} />
          {message.recipientIds?.length ? (
            <span className="flex items-center gap-1">
              <span className="font-mono text-[10px] text-violet-300/60">私发给</span>
              {message.recipientIds.map((id) => (
                <AgentAvatar key={id} name={names.get(id) ?? id} index={indexOf(id)} size="sm" />
              ))}
            </span>
          ) : null}
          <span className="font-mono text-[10px] text-zinc-600">{formatTime(message.createdAt)}</span>
        </div>
        <div className={cn(
          "mt-1.5 rounded-2xl rounded-tl-sm border px-4 py-3 text-[15px] leading-7",
          privateChat ? cn(channelSurface[message.channel], "opacity-95 text-zinc-200") : cn(channelSurface.public, "text-zinc-200")
        )}>
          <p className={cn(senderLive && "stream-caret")}>{message.text}</p>
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
  const [team, setTeam] = useState<string[]>([]);

  const run = async (payload: unknown): Promise<void> => {
    setBusy(true);
    try {
      await onAction(action.name, payload);
      setTeam([]);
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
            className="h-9 rounded-full border-white/10 bg-white/[0.02] px-4 text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100"
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
          className="h-10 w-28 rounded-full border border-white/[0.08] bg-white/[0.02] px-4 font-mono text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
        <Button size="sm" disabled={busy} onClick={() => void run({ [action.field ?? "value"]: Number(value) })} className="h-10 rounded-full bg-zinc-50 px-5 text-zinc-950 hover:bg-white">
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
          <Button key={target.id} size="sm" variant="outline" disabled={busy} onClick={() => void run({ [action.field ?? "targetId"]: target.id })} className="h-9 rounded-full border-white/10 bg-white/[0.02] px-4 text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100">
            {target.displayName}
          </Button>
        ))}
      </div>
    );
  }

  if (action.kind === "team") {
    const members = room.world.agents.filter((agent) => agent.alive);
    const min = action.min ?? 1;
    const max = action.max ?? members.length;
    const toggle = (id: string): void => {
      setTeam((current) => current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id].slice(0, max));
    };
    return (
      <div className="flex flex-wrap items-center gap-2">
        {members.map((member) => {
          const selected = team.includes(member.id);
          return (
            <Button
              key={member.id}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => toggle(member.id)}
              className={cn(
                "h-9 rounded-full border px-4",
                selected
                  ? "border-zinc-300/40 bg-zinc-100/[0.08] text-zinc-50"
                  : "border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06]"
              )}
            >
              {selected ? <Check className="mr-1 size-3" /> : null}
              {member.displayName}
            </Button>
          );
        })}
        <Button
          size="sm"
          disabled={busy || team.length < min}
          onClick={() => void run({ [action.field ?? "memberIds"]: team })}
          className="h-9 rounded-full bg-zinc-50 px-5 text-zinc-950 hover:bg-white"
        >
          提出队伍（{team.length}/{max}）
        </Button>
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