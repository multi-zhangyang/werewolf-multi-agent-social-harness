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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatus, ScenarioId, SocialChannel } from "@/society/contracts";

const avatarPalette = [
  "from-zinc-200 to-zinc-400 text-zinc-900",
  "from-blue-300 to-indigo-400 text-blue-950",
  "from-amber-200 to-orange-300 text-amber-950",
  "from-emerald-300 to-teal-400 text-emerald-950",
  "from-violet-300 to-purple-400 text-violet-950",
  "from-rose-300 to-pink-400 text-rose-950",
  "from-cyan-300 to-sky-400 text-cyan-950",
  "from-lime-300 to-green-400 text-lime-950"
];

export function AgentAvatar({ name, index = 0, size = "md" }: { name: string; index?: number; size?: "sm" | "md" | "lg" | "xl" }): ReactNode {
  const sizes = { sm: "size-6 text-[10px]", md: "size-8 text-xs", lg: "size-10 text-sm", xl: "size-14 text-base" };
  return (
    <Avatar className={cn("rounded-xl", sizes[size])}>
      <AvatarFallback className={cn("rounded-xl bg-gradient-to-br font-semibold", avatarPalette[index % avatarPalette.length])}>
        {name.trim().slice(0, 2)}
      </AvatarFallback>
    </Avatar>
  );
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
    ? "ring-emerald-400/80"
    : status === "thinking"
      ? "ring-sky-400/60"
      : status === "acting"
        ? "ring-amber-400/60"
        : "ring-transparent";
  const live = status === "speaking" || status === "thinking" || status === "acting";
  return (
    <span className={cn("relative inline-flex rounded-xl", live && "on-air", className)}>
      <span className={cn("inline-flex rounded-xl p-px ring-2 ring-offset-2 ring-offset-background transition-all", tone)}>
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
        <span key={bar} className="wave-bar w-[3px] rounded-full bg-emerald-400" style={{ height: `${[8, 12, 6][bar]}px`, animationDelay: `${bar * 140}ms` }} />
      ))}
    </span>
  );
}

export function StatusDot({ status, className }: { status: AgentStatus | "running" | "paused" | "finished" | "error"; className?: string }): ReactNode {
  const live = status === "running" || status === "thinking" || status === "acting" || status === "speaking";
  const tone = status === "error"
    ? "bg-red-400"
    : status === "paused" || status === "lobby"
      ? "bg-amber-400"
      : status === "finished"
        ? "bg-zinc-500"
        : live
          ? "bg-emerald-400"
          : "bg-zinc-600";
  return (
    <span className={cn("relative inline-flex size-1.5 rounded-full", tone, className)}>
      {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/60" /> : null}
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
    public: { label: "公开", className: "border-white/10 bg-white/[0.04] text-zinc-400" },
    private: { label: "私聊", className: "border-violet-400/20 bg-violet-400/10 text-violet-300" },
    team: { label: "阵营", className: "border-rose-400/20 bg-rose-400/10 text-rose-300" }
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
  public: "border-white/[0.06] bg-white/[0.025]",
  private: "border-violet-400/20 bg-violet-400/[0.05]",
  team: "border-rose-400/25 bg-rose-400/[0.06]"
};

export function ModelLabel({ model, className }: { model: string; className?: string }): ReactNode {
  const label = readableModel(model);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("truncate font-mono text-[10px] text-zinc-500", className)}>{label}</span>
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
    <div className="flex items-center gap-2 text-zinc-600">
      <Sparkles className="size-3" />
      <span className="text-[10px] font-medium uppercase tracking-[0.18em]">{children}</span>
    </div>
  );
}