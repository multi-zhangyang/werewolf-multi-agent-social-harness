import type { ReactNode } from "react";
import {
  BrainCircuit,
  Gavel,
  HandCoins,
  Handshake,
  MoonStar,
  Scale,
  Users
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

export function AgentAvatar({ name, index = 0, size = "md" }: { name: string; index?: number; size?: "sm" | "md" | "lg" }): ReactNode {
  const sizes = { sm: "size-6 text-[10px]", md: "size-8 text-xs", lg: "size-10 text-sm" };
  return (
    <Avatar className={cn("rounded-xl", sizes[size])}>
      <AvatarFallback className={cn("rounded-xl bg-gradient-to-br font-semibold", avatarPalette[index % avatarPalette.length])}>
        {name.trim().slice(0, 2)}
      </AvatarFallback>
    </Avatar>
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
    idle: "等待",
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
  return name.replace(/^@/, "").replaceAll("-", " ").replace(/\w/g, (letter) => letter.toUpperCase());
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

export function eventLabel(name: string): string {
  const labels: Record<string, string> = {
    communicate: "发送消息",
    remember_experience: "记录记忆",
    recall_memory: "检索记忆",
    update_inner_state: "更新内在状态",
    reflect_on_social_situation: "策略反思",
    read_the_room: "洞察他人",
    plan_social_strategy: "制定策略",
    choose_move: "提交选择",
    contribute_to_pool: "投入公共池",
    make_investment: "提交投资",
    return_from_trust: "返还资源",
    propose_split: "提出分配",
    respond_to_offer: "回应分配",
    choose_number: "提交数字",
    cast_day_vote: "白天投票",
    choose_night_target: "夜间目标",
    investigate_identity: "身份查验",
    submit_bid: "提交密封出价"
  };
  return labels[name] ?? name.replaceAll("_", " ");
}
