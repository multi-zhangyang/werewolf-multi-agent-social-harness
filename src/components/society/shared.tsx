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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatus, ScenarioId, SocialChannel } from "@/society/contracts";

/**
 * Deterministic local avatars (§15.2): the same character renders the same
 * face everywhere, generated offline from a stable seed — no external image
 * service, no network dependency, dark-first high-contrast silhouettes.
 */
const AVATAR_SKINS = ["#f2c9a4", "#e8b48c", "#d9a273", "#c98f63", "#b57d55", "#a06a45", "#8a5638"] as const;
const AVATAR_HAIRS = ["#1f2937", "#374151", "#111827", "#4b2e1e", "#5b3a29", "#2d1e12", "#0f172a"] as const;
const AVATAR_CLOTHES = [
  "#be123c", "#c2410c", "#a16207", "#3f6212",
  "#15803d", "#0f766e", "#0369a1", "#1d4ed8",
  "#4338ca", "#7e22ce", "#a21caf", "#be185d"
] as const;
const AVATAR_BACKGROUNDS = [
  "#27272a", "#1e293b", "#252528", "#20232a", "#2a2320", "#231f2a"
] as const;

export function AgentAvatar({ name, seed, size = "md" }: { name: string; seed?: string; size?: "sm" | "md" | "lg" | "xl" }): ReactNode {
  const sizes = { sm: "size-6", md: "size-8", lg: "size-10", xl: "size-14" };
  const stableSeed = seed ?? name;
  const hash = avatarHash(stableSeed);
  const initial = [...name].slice(0, 1).join("").toUpperCase() || "·";
  return (
    <span
      role="img"
      aria-label={`${name} 的人物头像`}
      className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-foreground/20 shadow-sm ring-1 ring-background", sizes[size])}
      style={{ background: AVATAR_BACKGROUNDS[hash % AVATAR_BACKGROUNDS.length] }}
    >
      <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden>
        {/* shoulders */}
        <path d="M10 64 C12 50 22 44 32 44 C42 44 52 50 54 64 Z" fill={AVATAR_CLOTHES[(hash >> 3) % AVATAR_CLOTHES.length]} />
        {/* neck */}
        <rect x="27.5" y="36" width="9" height="10" rx="3.5" fill={AVATAR_SKINS[hash % AVATAR_SKINS.length]} />
        {/* head */}
        <circle cx="32" cy="26" r="13" fill={AVATAR_SKINS[hash % AVATAR_SKINS.length]} />
        {/* hair: three deterministic silhouettes */}
        {hash % 3 === 0 ? (
          <path d="M19 24 C19 13 25 8 32 8 C39 8 45 13 45 24 C41 18 38 16 32 16 C26 16 23 18 19 24 Z" fill={AVATAR_HAIRS[(hash >> 5) % AVATAR_HAIRS.length]} />
        ) : hash % 3 === 1 ? (
          <path d="M18.5 26 C17 14 24 7.5 32 7.5 C40 7.5 47 14 45.5 26 L42 26 C43 18 39 14 32 14 C25 14 21 18 22 26 Z" fill={AVATAR_HAIRS[(hash >> 5) % AVATAR_HAIRS.length]} />
        ) : (
          <path d="M20 22 C21 12 26 8 32 8 C38 8 43 12 44 22 C44 24 42 24 41 22 C39 17 36 15 32 15 C28 15 25 17 23 22 C22 24 20 24 20 22 Z M18 30 C17 24 18 20 20 18 L22 26 Z M46 30 C47 24 46 20 44 18 L42 26 Z" fill={AVATAR_HAIRS[(hash >> 5) % AVATAR_HAIRS.length]} />
        )}
        {/* eyes */}
        <circle cx="27" cy="26" r="1.4" fill="#111827" />
        <circle cx="37" cy="26" r="1.4" fill="#111827" />
        {/* mouth */}
        <path d="M29 32 Q32 34.2 35 32" stroke="#111827" strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.65" />
      </svg>
      <span className="pointer-events-none absolute -bottom-px right-0 font-mono text-[8px] font-bold leading-none text-foreground/80">{initial}</span>
    </span>
  );
}

function avatarHash(value: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
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

/** §15.9: one shared visual language for provenance across every causality card. */
export function provenanceBadge(source: string): ReactNode {
  const labels: Record<string, string> = {
    "world-fact": "世界事实",
    "authorized-observation": "合法观察",
    "message-claim": "消息主张",
    "agent-self-report": "Agent 自述",
    "system-inference": "系统推断",
    presentation: "展示标签"
  };
  return <Badge variant="outline" className="text-[10px]">{labels[source] ?? source}</Badge>;
}
