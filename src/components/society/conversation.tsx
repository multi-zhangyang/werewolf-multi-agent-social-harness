import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, Brain, Check, Clock, Eye, Handshake, HeartHandshake, RotateCcw, Send, ShieldCheck, ShieldX, Skull, Sparkles, TrendingDown, TrendingUp, Trophy, UserMinus, Users, VenetianMask, XCircle } from "lucide-react";
import type { SocialMessage, StoryBeatKind, WorldLogEntry } from "@/society/contracts";
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
  formatTime,
  roleLabelZh,
  roleTintClass
} from "./shared";

type TimelineEntry =
  | { kind: "log"; id: string; time: number; text: string; turn: number; phase: string; beat?: StoryBeatKind }
  | { kind: "message"; id: string; time: number; message: SocialMessage };

interface ConversationProps {
  room: SocietyRoomSnapshot;
  activity: Record<string, LiveAgentActivity>;
  onAction: (action: string, payload: unknown) => Promise<void>;
  onReplay?: () => void;
}

export function Conversation({ room, activity, onAction, onReplay, jumpToAt }: ConversationProps & { jumpToAt?: string }): ReactNode {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const entries = useTimeline(room.world.messages, room.world.log);
  const names = useMemo(() => new Map(room.participants.map((p) => [p.profile.id, p.profile.displayName])), [room.participants]);
  const finished = room.world.status === "finished";

  useEffect(() => {
    if (finished) {
      // The finale lives at the top of the list: when the world ends, bring
      // the result hero and identity reveal into view instead of the tail.
      shellRef.current
        ?.querySelector('[data-slot="scroll-area-viewport"]')
        ?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, room.updatedAt, finished]);

  // Jump to the message nearest a highlight timestamp (§8.3): the entry whose
  // `at` is the last one at-or-before the target.
  useEffect(() => {
    if (!jumpToAt || finished) return;
    const viewport = shellRef.current?.querySelector('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const target = Date.parse(jumpToAt);
    let candidate: Element | undefined;
    for (const row of viewport.querySelectorAll<HTMLElement>("[data-msg-at]")) {
      const at = Number(row.dataset.msgAt ?? NaN);
      if (Number.isFinite(at) && at <= target) candidate = row;
    }
    if (!candidate) return;
    candidate.scrollIntoView({ behavior: "smooth", block: "center" });
    candidate.classList.add("msg-jump-flash");
    window.setTimeout(() => candidate?.classList.remove("msg-jump-flash"), 2200);
  }, [jumpToAt, finished]);

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
    <div ref={shellRef} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border/80 bg-card/60 px-6 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium tracking-tight">{room.world.summary}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", finished ? "bg-amber-400" : "live-pulse bg-emerald-400")} />
          {finished ? "对局已结束" : "实时直播"}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-[760px] px-6 pb-14 pt-6">
          {room.world.status === "finished" ? (
            <ResultCard room={room} onReplay={onReplay} />
          ) : null}

          <LiveAgents room={room} activity={activity} />

          <div className="space-y-5">
            {entries.length === 0 ? (
              <CastingSlate room={room} />
            ) : (
              entries.map((entry, index) => {
                if (entry.kind === "log") return <ActDivider key={entry.id} entry={entry} />;
                const previous = entries[index - 1];
                const waveTurn = previous && previous.kind === "message" && previous.message.wave !== undefined
                  && entry.message.wave !== undefined && previous.message.wave !== entry.message.wave;
                return (
                  <div key={entry.id} className="space-y-5" data-msg-at={Date.parse(entry.message.createdAt) || undefined}>
                    {waveTurn ? <WaveDivider wave={entry.message.wave ?? 1} /> : null}
                    <MessageRow entry={entry} names={names} activity={activity} fresh={index >= entries.length - 3 && entry.message.turn === room.world.turn} />
                  </div>
                );
              })
            )}
          </div>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {human?.waiting ? (
        <div className="border-t border-border/80 bg-card/80 px-6 py-4">
          {waitingLabel ? (
            <p className="mb-3 text-xs font-medium text-muted-foreground">
              轮到你：<span className="text-foreground">{waitingLabel}</span>
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
                  className="h-11 flex-1 rounded-lg border border-input bg-card px-5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
                />
                <Button size="icon" className="size-11 rounded-lg bg-foreground text-background hover:bg-foreground/85" disabled={!draft.trim()} onClick={() => void submit()}>
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

/** The reveal: once the world ends, the stage shows who won and why. */
function ResultCard({ room, onReplay }: { room: SocietyRoomSnapshot; onReplay?: () => void }): ReactNode {
  const world = room.world;
  const winners = (world.details.winners ?? []) as string[] | undefined;
  const names = new Map(room.participants.map((p) => [p.profile.id, p.profile.displayName]));
  const leaders = winners?.length
    ? winners
    : [...room.participants]
        .filter((p) => p.score !== undefined)
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
        .slice(0, 1)
        .map((p) => p.profile.id);
  const lastLog = world.log.at(-1)?.text;
  const scored = room.participants
    .filter((participant) => participant.score !== undefined)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const revealed = room.participants.filter((p) => p.role);
  const faction = factionTitle(room, winners);
  return (
    <div className="reveal-up mb-8 overflow-hidden rounded-xl border border-amber-400/25 bg-gradient-to-b from-muted/60 to-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3">
        <Trophy className="size-4 text-amber-400" />
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-amber-300/90">本局结算</p>
      </div>
      <div className="px-5 py-6">
        <p className="enter-stage text-3xl font-semibold tracking-normal text-foreground" style={{ animationDelay: "80ms" }}>{faction}</p>
        <p className="enter-stage mt-1.5 text-sm text-foreground/80" style={{ animationDelay: "200ms" }}>
          {leaders.length ? `胜者：${leaders.map((id) => names.get(id) ?? id).join("、")}` : ""}
        </p>
        {lastLog ? (
          <p className="enter-stage mt-3 text-sm leading-6 text-muted-foreground" style={{ animationDelay: "320ms" }}>
            <span className="mr-1 rounded border border-border bg-muted px-1 py-px text-[10px] text-muted-foreground/80">赛果记录</span>
            {lastLog}
          </p>
        ) : null}
        {scored.length ? (
          <p className="enter-stage nums mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground" style={{ animationDelay: "380ms" }}>
            <span className="text-muted-foreground/70">最终得分</span>
            {scored.map((entry, index) => (
              <span key={entry.profile.id} className={index === 0 ? "font-medium text-amber-300" : ""}>
                {names.get(entry.profile.id) ?? entry.profile.id} {entry.score}
              </span>
            ))}
          </p>
        ) : null}
        {revealed.length ? (
          <div className="enter-stage mt-5" style={{ animationDelay: "440ms" }}>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">身份揭晓</p>
            <div className="flex flex-wrap gap-2">
              {revealed.map((participant) => (
                <span
                  key={participant.profile.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                    roleTintClass(participant.role),
                    !participant.alive && "opacity-60"
                  )}
                >
                  {participant.profile.displayName}
                  <span className="font-medium">{roleLabelZh(participant.role)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="enter-stage mt-4 flex flex-wrap items-center gap-3" style={{ animationDelay: "560ms" }}>
          {onReplay ? (
            <Button size="sm" className="rounded-lg bg-foreground px-4 text-background hover:bg-foreground/85" onClick={onReplay}>
              <RotateCcw className="size-3.5" />
              同场景再来一局
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground/80">
            {room.seasonMode === "one-shot"
              ? "单局模式：本局结束，记忆随房间消散，不留任何历史"
              : "角色们会带着这一局的记忆与恩怨进入下一场"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Faction title for the finale, derived from revealed roles. */
function factionTitle(room: SocietyRoomSnapshot, winners?: string[]): string {
  const roles = new Map(room.participants.map((p) => [p.profile.id, roleLabelZh(p.role)]));
  const winning = winners?.length ? winners : [];
  const winnerRoles = winning.map((id) => roles.get(id) ?? "");
  if (winnerRoles.includes("小丑")) return "小丑达成了目标 —— 被投出去就是胜利";
  const deceptive = ["狼人", "狼王", "刺客", "莫德雷德", "莫甘娜", "奥伯伦", "爪牙"];
  const faithful = ["村民", "忠臣", "女巫", "猎人", "守卫", "白痴"];
  if (winnerRoles.some((role) => deceptive.includes(role))) {
    return room.scenarioId === "werewolf" ? "狼人阵营胜利" : "欺骗阵营胜利";
  }
  if (winnerRoles.some((role) => faithful.includes(role))) {
    return room.scenarioId === "werewolf" ? "村庄阵营胜利" : "忠诚阵营胜利";
  }
  if (winnerRoles.includes("预言家") || winnerRoles.includes("梅林") || winnerRoles.includes("派西维尔")) {
    return room.scenarioId === "werewolf" ? "村庄阵营胜利" : "忠诚阵营胜利";
  }
  return winners?.length ? "胜利者已经产生" : "这一局已经落幕";
}

function CastingSlate({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  return (
    <div className="relative flex min-h-56 flex-col items-center justify-center overflow-hidden rounded-xl border border-border bg-card">
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
      <p className="relative mt-4 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">正在唤醒世界</p>
    </div>
  );
}

function LiveAgents({ room, activity }: {
  room: SocietyRoomSnapshot;
  activity: Record<string, LiveAgentActivity>;
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
          <div key={participant.profile.id} className="enter-stage overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-3 px-4 py-3">
              <AgentPresence name={participant.profile.displayName} index={indexOf(participant.profile.id)} size="md" status={participant.status} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {participant.profile.displayName}
                  {participant.status === "speaking" ? <SpeechBars /> : <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />}
                </p>
                <p className="truncate text-xs text-muted-foreground">{caption}</p>
              </div>
              <span className="nums font-mono text-[10px] text-muted-foreground/50">{formatTime(state?.at ?? new Date().toISOString())}</span>
            </div>
            {state?.reasoning ? <CollapsedReasoning text={state.reasoning} /> : null}
            {state?.thought ? (
              <div className="mx-4 mb-3 rounded-lg border border-border bg-muted/50 px-3.5 py-2.5">
                <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  <Brain className="size-3" /> {thoughtLabel(state.thought.kind)}
                </p>
                <p className="stream-caret line-clamp-4 text-xs leading-5 text-muted-foreground">{state.thought.text}</p>
              </div>
            ) : null}
            {state?.text ? (
              <div className="mx-4 mb-3 rounded-lg border border-border bg-muted/50 px-3.5 py-2.5">
                <p className="stream-caret line-clamp-3 text-xs leading-5 text-foreground/80">{state.text}</p>
              </div>
            ) : null}
            {state?.compacted ? (
              <div className="mx-4 mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3.5 py-2">
                <p className="font-mono text-[10px] uppercase tracking-widest text-amber-300">记忆压缩</p>
                <p className="mt-0.5 text-xs leading-5 text-amber-100/80">{state.compacted}</p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The provider's reasoning SUMMARY, collapsed by default (§8.5). Only a
 * provider-returned reasoning summary may be shown — raw chain-of-thought
 * never crosses the wire — and it is labeled by source, shown only on
 * explicit expansion, never as an auto-playing feed. Public seats never
 * receive these events server-side.
 */
function CollapsedReasoning({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-4 mb-3 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3.5 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={open}
      >
        <Brain className="size-3 shrink-0 text-sky-300" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-sky-300">提供商推理摘要</span>
        <span className="truncate text-[10px] text-sky-200/50">{open ? "点击收起" : "点击展开"}</span>
        <svg viewBox="0 0 12 12" className={cn("ml-auto size-2.5 shrink-0 text-sky-300/70 transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <p className="stream-caret mt-1.5 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-sky-100/80">{text}</p>
      ) : null}
    </div>
  );
}

function thoughtLabel(kind: string): string {
  const labels: Record<string, string> = {
    notice: "有所察觉",
    recall: "回忆涌起",
    doubt: "心生怀疑",
    goal: "目标浮现",
    hypothesis: "洞察他人",
    conflict: "内心冲突",
    plan: "谋划行动",
    decision: "下定决心",
    regret: "事后懊悔",
    realization: "恍然大悟"
  };
  return labels[kind] ?? "心中盘算";
}

function WaveDivider({ wave }: { wave: number }): ReactNode {
  return (
    <div className="flex items-center gap-4 pt-1">
      <div className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {wave === 1 ? "开场发言" : `回应第 ${wave - 1} 轮`}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ActDivider({ entry }: { entry: Extract<TimelineEntry, { kind: "log" }> }): ReactNode {
  const beat = entry.beat ? BEATS[entry.beat] : undefined;
  if (beat) {
    const Icon = beat.icon;
    return (
      <div className="enter-stage flex items-center gap-3 rounded-lg border border-border/70 bg-card px-4 py-3">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full border", beat.chip)}>
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className={cn("font-mono text-[10px] uppercase tracking-[0.2em]", beat.labelColor)}>
            {beat.label} · 第 {entry.turn} 幕
          </p>
          <p className="mt-0.5 text-sm font-medium leading-5 text-foreground/90">{entry.text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-5 py-2">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
      <div className="text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">第 {entry.turn} 幕</p>
        <p className="mt-1 text-sm font-medium tracking-tight text-foreground/90">{entry.text}</p>
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
    </div>
  );
}

const BEATS: Record<StoryBeatKind, { label: string; icon: typeof Trophy; chip: string; labelColor: string }> = {
  betrayal: { label: "背叛", icon: Skull, chip: "border-rose-400/40 bg-rose-400/10 text-rose-300", labelColor: "text-rose-300/80" },
  "deception-exposed": { label: "谎言拆穿", icon: Eye, chip: "border-amber-400/40 bg-amber-400/10 text-amber-300", labelColor: "text-amber-300/80" },
  alliance: { label: "结盟", icon: HeartHandshake, chip: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300", labelColor: "text-emerald-300/80" },
  "promise-kept": { label: "承诺兑现", icon: ShieldCheck, chip: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300", labelColor: "text-emerald-300/80" },
  "promise-broken": { label: "背弃承诺", icon: ShieldX, chip: "border-rose-400/40 bg-rose-400/10 text-rose-300", labelColor: "text-rose-300/80" },
  comeback: { label: "逆转", icon: TrendingUp, chip: "border-sky-400/40 bg-sky-400/10 text-sky-300", labelColor: "text-sky-300/80" },
  misplay: { label: "失手", icon: AlertTriangle, chip: "border-orange-400/40 bg-orange-400/10 text-orange-300", labelColor: "text-orange-300/80" },
  win: { label: "决胜", icon: Sparkles, chip: "border-amber-400/40 bg-amber-400/10 text-amber-300", labelColor: "text-amber-300/80" },
  // P0-09: neutral outcome labels get muted, low-saturation badges — the
  // saturated colors are reserved for the evidence-backed strong labels above.
  "cooperative-outcome": { label: "协同", icon: Handshake, chip: "border-emerald-400/30 bg-emerald-400/5 text-emerald-300/80", labelColor: "text-emerald-300/60" },
  "high-return": { label: "高回报", icon: TrendingUp, chip: "border-sky-400/30 bg-sky-400/5 text-sky-300/80", labelColor: "text-sky-300/60" },
  "low-return": { label: "低回报", icon: TrendingDown, chip: "border-slate-400/30 bg-slate-400/5 text-slate-300/80", labelColor: "text-slate-300/60" },
  "commitment-unresolved": { label: "待结算", icon: Clock, chip: "border-slate-400/30 bg-slate-400/5 text-slate-300/80", labelColor: "text-slate-300/60" },
  "unilateral-defection": { label: "单方退出", icon: UserMinus, chip: "border-amber-400/30 bg-amber-400/5 text-amber-300/80", labelColor: "text-amber-300/60" },
  "free-riding": { label: "搭便车", icon: Users, chip: "border-slate-400/30 bg-slate-400/5 text-slate-300/80", labelColor: "text-slate-300/60" },
  "adverse-outcome": { label: "不利结果", icon: AlertCircle, chip: "border-orange-400/30 bg-orange-400/5 text-orange-300/80", labelColor: "text-orange-300/60" },
  "agreement-reached": { label: "达成一致", icon: Check, chip: "border-emerald-400/30 bg-emerald-400/5 text-emerald-300/80", labelColor: "text-emerald-300/60" },
  "negotiation-failed": { label: "谈判破裂", icon: XCircle, chip: "border-orange-400/30 bg-orange-400/5 text-orange-300/80", labelColor: "text-orange-300/60" },
  "hidden-role-revealed": { label: "身份揭晓", icon: VenetianMask, chip: "border-slate-400/30 bg-slate-400/5 text-slate-300/80", labelColor: "text-slate-300/60" }
};

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
          <span className="text-sm font-semibold tracking-tight">{message.senderName}</span>
          <ChannelBadge channel={message.channel} />
          {message.recipientIds?.length ? (
            <span className="flex items-center gap-1 text-muted-foreground/80">
              <span className="font-mono text-[10px]">{privateChat ? "私发给" : "对"}</span>
              {message.recipientIds.map((id) => (
                <AgentAvatar key={id} name={names.get(id) ?? id} index={indexOf(id)} size="sm" />
              ))}
            </span>
          ) : null}
          <span className="nums font-mono text-[10px] text-muted-foreground/60">{formatTime(message.createdAt)}</span>
        </div>
        <div className={cn(
          "mt-1.5 rounded-lg border border-l-2 px-4 py-3 text-[15px] leading-7",
          privateChat ? cn(channelSurface[message.channel], "opacity-95 text-foreground/90") : cn(channelSurface.public, "text-foreground/90")
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
            className="h-9 rounded-lg border-border bg-card px-4 text-foreground/80 hover:bg-muted hover:text-foreground"
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
          className="h-10 w-28 rounded-lg border border-input bg-card px-4 font-mono text-sm text-foreground focus:border-ring focus:outline-none"
        />
        <Button size="sm" disabled={busy} onClick={() => void run({ [action.field ?? "value"]: Number(value) })} className="h-10 rounded-lg bg-foreground px-5 text-background hover:bg-foreground/85">
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
          <Button key={target.id} size="sm" variant="outline" disabled={busy} onClick={() => void run({ [action.field ?? "targetId"]: target.id })} className="h-9 rounded-lg border-border bg-card px-4 text-foreground/80 hover:bg-muted hover:text-foreground">
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
                "h-9 rounded-lg border px-4",
                selected
                  ? "border-foreground/70 bg-foreground text-background hover:bg-foreground/85"
                  : "border-border bg-card text-foreground/80 hover:bg-muted"
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
          className="h-9 rounded-lg bg-foreground px-5 text-background hover:bg-foreground/85"
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
    phase: entry.phase,
    ...(entry.beat ? { beat: entry.beat } : {})
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