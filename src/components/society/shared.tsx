import type { ReactNode } from "react";
import {
  BrainCircuit,
  Castle,
  ChevronsLeftRight,
  Gavel,
  HandCoins,
  Handshake,
  MoonStar,
  Scale,
  Sparkles,
  Sword,
  Users,
  Waypoints
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatus, ScenarioId, SocialChannel } from "@/society/contracts";

/**
 * Character avatars are pure geometry: no text, no photos. Each character is
 * a duotone gradient plus a unique ink mark (ring / diamond / arc / triangle /
 * dots / chevron) derived from their name, so a crowd of agents stays
 * readable at a glance and the same character looks the same everywhere —
 * across games, seasons and panels.
 */

const AVATAR_GRADIENTS: Array<[string, string, string]> = [
  ["#e4e4e7", "#a1a1aa", "#3f3f46"],
  ["#bfdbfe", "#818cf8", "#312e81"],
  ["#fde68a", "#fdba74", "#78350f"],
  ["#a7f3d0", "#2dd4bf", "#064e3b"],
  ["#ddd6fe", "#a78bfa", "#4c1d95"],
  ["#fecdd3", "#fb7185", "#881337"],
  ["#a5f3fc", "#38bdf8", "#155e75"],
  ["#d9f99d", "#a3e635", "#365314"]
];

type InkMark = "ring" | "diamond" | "arc" | "triangle" | "dots" | "chevron";

function markFor(seed: number): InkMark {
  return ["ring", "diamond", "arc", "triangle", "dots", "chevron"][Math.floor(seed / 8) % 6] as InkMark;
}

function markPath(mark: InkMark, ink: string): ReactNode {
  const stroke = { stroke: ink, strokeWidth: 2.4, fill: "none", strokeLinecap: "round" as const };
  switch (mark) {
    case "ring":
      return <circle cx="20" cy="20" r="9" {...stroke} />;
    case "diamond":
      return <path d="M20 10 L29 20 L20 30 L11 20 Z" {...stroke} />;
    case "arc":
      return <path d="M12 26 A 11 11 0 0 1 28 26" {...stroke} />;
    case "triangle":
      return <path d="M20 10 L29.5 27 L10.5 27 Z" {...stroke} />;
    case "dots":
      return (<g fill={ink}>
        <circle cx="14" cy="14" r="2.6" /><circle cx="26" cy="14" r="2.6" />
        <circle cx="14" cy="26" r="2.6" /><circle cx="26" cy="26" r="2.6" />
      </g>);
    case "chevron":
      return <path d="M13 15 L20 20 L13 25 M21 15 L28 20 L21 25" {...stroke} />;
  }
}

export function AgentAvatar({ name, index = 0, size = "md" }: { name: string; index?: number; size?: "sm" | "md" | "lg" | "xl" }): ReactNode {
  const sizes = { sm: "size-6", md: "size-8", lg: "size-10", xl: "size-14" };
  const seed = hashString(name) || index + 1;
  const [from, to, ink] = AVATAR_GRADIENTS[seed % AVATAR_GRADIENTS.length];
  const gradientId = `ag-${seed}`;
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn("shrink-0 rounded-lg", sizes[size])}
      aria-label={name}
      role="img"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="9" fill={`url(#${gradientId})`} />
      {markPath(markFor(seed), ink)}
    </svg>
  );
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

/** Presence ring: the agent's live state reads off the avatar, no text needed. */
export function AgentPresence({ name, index = 0, size = "md", status, className }: {
  name: string;
  index?: number;
  size?: "sm" | "md" | "lg" | "xl";
  status: AgentStatus;
  className?: string;
}): ReactNode {
  const tone = status === "speaking"
    ? "ring-emerald-500/70"
    : status === "thinking"
      ? "ring-sky-500/50"
      : status === "acting"
        ? "ring-amber-500/60"
        : "ring-transparent";
  const live = status === "speaking" || status === "thinking" || status === "acting";
  return (
    <span className={cn("relative inline-flex rounded-lg", live && "on-air", className)}>
      <span className={cn("inline-flex rounded-lg p-px ring-2 ring-offset-2 ring-offset-background transition-all", tone)}>
        <AgentAvatar name={name} index={index} size={size} />
      </span>
    </span>
  );
}

/** Three animated bars — the universal "on the record, speaking now" signal. */
export function SpeechBars({ className }: { className?: string }): ReactNode {
  return (
    <span className={cn("flex h-3 items-end gap-[3px]", className)} aria-hidden>
      {[0, 1, 2].map((bar) => (
        <span key={bar} className="wave-bar w-[3px] rounded-full bg-emerald-500" style={{ height: `${[8, 12, 6][bar]}px`, animationDelay: `${bar * 140}ms` }} />
      ))}
    </span>
  );
}

export function StatusDot({ status, className }: { status: AgentStatus | "running" | "paused" | "finished" | "error"; className?: string }): ReactNode {
  const live = status === "running" || status === "thinking" || status === "acting" || status === "speaking";
  const tone = status === "error"
    ? "bg-red-500"
    : status === "paused" || status === "lobby"
      ? "bg-amber-500"
      : status === "finished"
        ? "bg-zinc-400"
        : live
          ? "bg-emerald-500"
          : "bg-zinc-300";
  return (
    <span className={cn("relative inline-flex size-1.5 rounded-full", tone, className)}>
      {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/50" /> : null}
    </span>
  );
}

export function StatusLabel({ status }: { status: AgentStatus | "running" | "paused" | "finished" | "error" }): ReactNode {
  const labels: Record<string, string> = {
    lobby: "准备中",
    running: "进行中",
    thinking: "思考中",
    acting: "行动中",
    speaking: "发言中",
    idle: "静候",
    paused: "已暂停",
    finished: "已结束",
    error: "异常"
  };
  return <>{labels[status] ?? status}</>;
}

export function ScenarioIcon({ id, className }: { id: ScenarioId; className?: string }): ReactNode {
  const Icon = id === "prisoners-dilemma" ? Scale
    : id === "ultimatum-game" ? Gavel
      : id === "public-goods" ? Users
        : id === "trust-game" ? Handshake
          : id === "beauty-contest" ? BrainCircuit
            : id === "sealed-bid-auction" ? HandCoins
              : id === "avalon" ? Castle
                : id === "centipede-game" ? Waypoints
                  : id === "chicken-game" ? ChevronsLeftRight
                    : id === "stag-hunt" ? Sword
                      : MoonStar;
  return <Icon className={className} />;
}

export function ChannelBadge({ channel }: { channel: SocialChannel }): ReactNode {
  const config: Record<SocialChannel, { label: string; className: string }> = {
    public: { label: "公开", className: "border-zinc-200 bg-zinc-50 text-zinc-500" },
    private: { label: "私聊", className: "border-violet-200 bg-violet-50 text-violet-600" },
    team: { label: "阵营", className: "border-rose-200 bg-rose-50 text-rose-600" }
  };
  const entry = config[channel];
  return (
    <Badge variant="outline" className={cn("h-4.5 rounded-full border px-1.5 text-[10px] font-medium", entry.className)}>
      {entry.label}
    </Badge>
  );
}

/** Channel → surface styling so public/private/team reads at a glance. */
export const channelSurface: Record<SocialChannel, string> = {
  public: "border-zinc-200 bg-white",
  private: "border-violet-200 bg-violet-50/60",
  team: "border-rose-200 bg-rose-50/60"
};

export function ModelLabel({ model, className }: { model: string; className?: string }): ReactNode {
  const label = readableModel(model);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-model className={cn("truncate font-mono text-[10px] text-zinc-400", className)}>{label}</span>
      </TooltipTrigger>
      <TooltipContent>{model}</TooltipContent>
    </Tooltip>
  );
}

export function readableModel(model: string): string {
  const name = model.split("/").at(-1) ?? model;
  return name.replace(/^@/, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

export function eventLabel(name: string): string {
  const labels: Record<string, string> = {
    communicate: "公开发言",
    remember_experience: "铭刻记忆",
    recall_memory: "翻阅记忆",
    update_inner_state: "内心起了变化",
    reflect_on_social_situation: "策略反思",
    read_the_room: "洞察全场",
    plan_social_strategy: "谋划行动",
    choose_move: "提交选择",
    contribute_to_pool: "投入公共池",
    make_investment: "提交投资",
    return_from_trust: "返还资源",
    propose_split: "提出分配",
    respond_to_offer: "回应分配",
    choose_number: "提交数字",
    cast_day_vote: "白天投票",
    choose_night_target: "选定夜袭目标",
    investigate_identity: "查验身份",
    submit_bid: "提交密封出价",
    propose_team: "提出任务队伍",
    cast_team_vote: "表决队伍",
    cast_quest_vote: "暗中决定任务",
    assassinate_merlin: "刺杀梅林",
    centipede_move: "拿走或传递",
    chicken_choice: "闪避或硬冲",
    hunt_choice: "猎鹿或猎兔"
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

export function SparkleDivider({ children }: { children?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-2 text-zinc-400">
      <Sparkles className="size-3" />
      <span className="text-[10px] font-medium uppercase tracking-[0.18em]">{children}</span>
    </div>
  );
}
