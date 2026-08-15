import type { ReactNode } from "react";
import {
  BrainCircuit,
  CircleDollarSign,
  Handshake,
  MoonStar,
  Scale,
  Users
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatus, ScenarioId } from "@/society/contracts";

const avatarStyles = [
  "bg-zinc-100 text-zinc-950",
  "bg-blue-400 text-blue-950",
  "bg-amber-300 text-amber-950",
  "bg-emerald-400 text-emerald-950",
  "bg-violet-400 text-violet-950",
  "bg-rose-400 text-rose-950"
];

export function AgentAvatar({ name, index = 0, className }: { name: string; index?: number; className?: string }): ReactNode {
  return (
    <Avatar className={cn("size-8 rounded-lg", className)}>
      <AvatarFallback className={cn("rounded-lg text-xs font-semibold", avatarStyles[index % avatarStyles.length])}>
        {name.trim().slice(0, 2)}
      </AvatarFallback>
    </Avatar>
  );
}

export function StatusBadge({ status, compact = false }: { status: AgentStatus | "running" | "paused" | "finished" | "error"; compact?: boolean }): ReactNode {
  const live = status === "running" || status === "thinking" || status === "acting" || status === "speaking";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-white/10 bg-white/[0.03] font-normal text-muted-foreground",
        compact && "h-5 px-1.5 text-[10px]",
        status === "error" && "border-red-500/20 text-red-400",
        status === "finished" && "text-zinc-300"
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-zinc-600", live && "live-pulse bg-emerald-400", status === "paused" && "bg-amber-400", status === "error" && "bg-red-400")} />
      {statusLabel(status)}
    </Badge>
  );
}

export function ScenarioIcon({ id, className }: { id: ScenarioId; className?: string }): ReactNode {
  const Icon = id === "prisoners-dilemma" ? Scale : id === "public-goods" ? Users : id === "trust-game" ? Handshake : MoonStar;
  return <Icon className={className} />;
}

export function RoleBadge({ role }: { role?: string }): ReactNode {
  if (!role) return null;
  return <Badge variant="secondary" className="h-5 rounded-md bg-white/[0.06] px-1.5 text-[10px] font-medium text-zinc-300">{role}</Badge>;
}

export function ModelLabel({ model, compact = false }: { model: string; compact?: boolean }): ReactNode {
  const label = model.includes("yourmodel") ? "Your Model" : model.includes("pro") ? "Your Model" : model.includes("flash") ? "Your Model" : model;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("truncate font-mono text-[11px] text-muted-foreground", compact && "max-w-28")}>{label}</span>
      </TooltipTrigger>
      <TooltipContent>{model}</TooltipContent>
    </Tooltip>
  );
}

export function EmptyPanel({ icon, title, detail }: { icon?: ReactNode; title: string; detail?: string }): ReactNode {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground">
        {icon ?? <BrainCircuit className="size-4" />}
      </div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {detail ? <p className="mt-1 max-w-72 text-xs leading-5 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

export function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

export function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function statusLabel(status: string): string {
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
  return labels[status] ?? status;
}

export function eventLabel(name: string): string {
  const labels: Record<string, string> = {
    communicate: "发送消息",
    remember_experience: "写入记忆",
    recall_memory: "检索记忆",
    update_social_model: "更新社会模型",
    reflect_on_social_situation: "社会反思",
    choose_move: "提交选择",
    contribute_to_pool: "投入公共池",
    make_investment: "提交投资",
    return_from_trust: "返还资源",
    cast_day_vote: "白天投票",
    choose_night_target: "夜间目标",
    investigate_identity: "身份查验"
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

export function scenarioMetricIcon(id: ScenarioId): ReactNode {
  if (id === "public-goods") return <CircleDollarSign className="size-4" />;
  return <ScenarioIcon id={id} className="size-4" />;
}
