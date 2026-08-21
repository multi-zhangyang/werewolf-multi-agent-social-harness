import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  BrainCircuit,
  Castle,
  ChevronsLeftRight,
  Dices,
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatus, ScenarioId, SocialChannel } from "@/society/contracts";

const AVATAR_BACKGROUNDS = [
  "f43f5e", "f97316", "eab308", "84cc16",
  "22c55e", "14b8a6", "06b6d4", "0ea5e9",
  "3b82f6", "6366f1", "8b5cf6", "a855f7",
  "d946ef", "ec4899", "64748b", "78716c"
] as const;

export function AgentAvatar({ name, seed, size = "md" }: { name: string; index?: number; seed?: string; size?: "sm" | "md" | "lg" | "xl" }): ReactNode {
  const sizes = { sm: "size-6", md: "size-8", lg: "size-10", xl: "size-14" };
  const stableSeed = seed ?? name;
  const avatarSeed = encodeURIComponent(stableSeed);
  const background = AVATAR_BACKGROUNDS[avatarHash(stableSeed) % AVATAR_BACKGROUNDS.length];
  const source = `https://api.dicebear.com/9.x/lorelei/svg?seed=${avatarSeed}&backgroundColor=${background}&radius=18&scale=92`;
  const fallback = [...name].slice(0, 1).join("").toUpperCase() || "·";
  return (
    <Avatar className={cn("rounded-lg border border-foreground/25 bg-muted shadow-sm ring-1 ring-background", sizes[size])}>
      <AvatarImage src={source} alt={`${name} 的人物头像`} />
      <AvatarFallback className="rounded-lg font-mono text-xs font-semibold">{fallback}</AvatarFallback>
    </Avatar>
  );
}

function avatarHash(value: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

/** Presence ring: the agent's live state reads off the avatar, no text needed. */
export function AgentPresence({ name, index = 0, seed, size = "md", status, className }: {
  name: string;
  index?: number;
  seed?: string;
  size?: "sm" | "md" | "lg" | "xl";
  status: AgentStatus;
  className?: string;
}): ReactNode {
  const tone = status === "speaking"
    ? "ring-foreground/80"
    : status === "thinking" || status === "acting"
      ? "ring-muted-foreground/70"
      : "ring-transparent";
  const live = status === "speaking" || status === "thinking" || status === "acting";
  return (
    <span className={cn("relative inline-flex rounded-lg", live && "on-air", className)}>
      <span className={cn("inline-flex rounded-lg p-px ring-2 ring-offset-2 ring-offset-background transition-all", tone)}>
        <AgentAvatar name={name} index={index} seed={seed} size={size} />
      </span>
    </span>
  );
}

export function StatusDot({ status, className }: { status: AgentStatus | "running" | "paused" | "finished" | "error"; className?: string }): ReactNode {
  const live = status === "running" || status === "thinking" || status === "acting" || status === "speaking";
  const tone = status === "error"
    ? "bg-destructive"
    : status === "paused" || status === "lobby"
      ? "bg-muted-foreground"
      : status === "finished"
        ? "bg-muted-foreground/40"
        : live
          ? "bg-foreground"
          : "bg-muted-foreground/40";
  return (
    <span className={cn("relative inline-flex size-1.5 rounded-full", tone, className)}>
      {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/40" /> : null}
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
    error: "行动失败"
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
                      : id === "negotiation-game" ? ArrowLeftRight
                        : id === "liars-dice" ? Dices
                          : MoonStar;
  return <Icon className={className} />;
}

export function ChannelBadge({ channel }: { channel: SocialChannel }): ReactNode {
  const config: Record<SocialChannel, { label: string; className: string }> = {
    public: { label: "公开", className: "border-border bg-muted text-muted-foreground" },
    private: { label: "私聊", className: "border-foreground/20 bg-foreground/5 text-foreground/80" },
    team: { label: "阵营", className: "border-foreground/30 bg-foreground/10 text-foreground" }
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
  public: "border-border bg-card",
  private: "border-foreground/20 bg-foreground/5",
  team: "border-foreground/30 bg-foreground/10"
};

export function ModelLabel({ model, className }: { model: string; className?: string }): ReactNode {
  const label = readableModel(model);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-model className={cn("truncate font-mono text-[10px] text-muted-foreground/80", className)}>{label}</span>
      </TooltipTrigger>
      <TooltipContent>{model}</TooltipContent>
    </Tooltip>
  );
}

export function readableModel(model: string): string {
  const name = model.split("/").at(-1) ?? model;
  return name.replace(/^@/, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Localize scenario roles for observer display (werewolf + avalon). */
export function roleLabelZh(role: string | undefined): string {
  const labels: Record<string, string> = {
    wolf: "狼人",
    "wolf-king": "狼王",
    "hidden-wolf": "隐狼",
    "white-wolf-king": "白狼王",
    "wolf-beauty": "狼美人",
    nightmare: "梦魇",
    "spirit-seer": "通灵师",
    seer: "预言家",
    witch: "女巫",
    hunter: "猎人",
    guard: "守卫",
    jester: "小丑",
    idiot: "白痴",
    knight: "骑士",
    villager: "村民",
    merlin: "梅林",
    percival: "派西维尔",
    servant: "忠臣",
    morgana: "莫甘娜",
    assassin: "刺客",
    mordred: "莫德雷德",
    oberon: "奥伯伦",
    minion: "爪牙"
  };
  return role ? labels[role] ?? role : "未知";
}

/** Faction tint for a role badge: red for deceivers, green for loyal, gold for seers. */
export function roleTintClass(role: string | undefined): string {
  return role
    ? "border-foreground/20 bg-foreground/5 text-foreground"
    : "border-border bg-card text-muted-foreground";
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
    knight_challenge: "骑士决斗",
    guard_tonight: "守卫值夜",
    witch_night_choice: "使用药水",
    hunter_shoot: "猎人开枪",
    wolf_king_shoot: "狼王开枪",
    inspect_with_lady: "湖中仙女查验",
    submit_bid: "提交密封出价",
    propose_team: "提出任务队伍",
    cast_team_vote: "表决队伍",
    cast_quest_vote: "暗中决定任务",
    assassinate_merlin: "刺杀梅林",
    centipede_move: "拿走或传递",
    chicken_choice: "闪避或硬冲",
    hunt_choice: "猎鹿或猎兔",
    submit_demand: "提交叫价",
    liars_move: "叫价或质疑",
    liars_challenge: "开盅质疑",
    liars_bid_quantity: "喊个数",
    liars_bid_face: "喊点数"
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

export function SparkleDivider({ children }: { children?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-2 text-muted-foreground/80">
      <Sparkles className="size-3" />
      <span className="text-[10px] font-medium uppercase tracking-[0.18em]">{children}</span>
    </div>
  );
}
