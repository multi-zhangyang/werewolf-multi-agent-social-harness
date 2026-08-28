import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  BrainCircuit,
  Castle,
  ChevronDown,
  ChevronsLeftRight,
  Dices,
  Gavel,
  HandCoins,
  Handshake,
  MoonStar,
  Scale,
  Sparkles,
  Sword,
  TriangleAlert,
  Users,
  Waypoints
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatus, ScenarioId, SocialChannel } from "@/society/contracts";

/**
 * Deterministic local avatars: a duotone gradient tile with the character
 * initial — the same character renders the same mark everywhere, generated
 * offline from a stable seed. No external image service, no network.
 */
/**
 * Sixteen duotone gradients, ordered around the hue wheel so that palette
 * distance ≈ hue distance — the ×6 ordinal walk then keeps any neighbouring
 * roster entries (horizontal ±1, vertical ±2) at least 135° of hue apart.
 */
const AVATAR_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#b91c1c", "#ef4444"],
  ["#c2410c", "#f97316"],
  ["#a16207", "#eab308"],
  ["#4d7c0f", "#84cc16"],
  ["#15803d", "#10b981"],
  ["#0f766e", "#14b8a6"],
  ["#0e7490", "#06b6d4"],
  ["#0369a1", "#38bdf8"],
  ["#1d4ed8", "#3b82f6"],
  ["#4338ca", "#6366f1"],
  ["#6d28d9", "#8b5cf6"],
  ["#7e22ce", "#a855f7"],
  ["#a21caf", "#d946ef"],
  ["#be185d", "#ec4899"],
  ["#be123c", "#f43f5e"],
  ["#334155", "#64748b"]
] as const;

const AVATAR_LETTER_SIZE = { sm: "text-[10px]", md: "text-[13px]", lg: "text-base", xl: "text-[22px]" } as const;

export function AgentAvatar({ name, seed, size = "md" }: { name: string; seed?: string; size?: "sm" | "md" | "lg" | "xl" }): ReactNode {
  const sizes = { sm: "size-6", md: "size-8", lg: "size-10", xl: "size-14" };
  const stableSeed = seed ?? name;
  const [from, to] = AVATAR_GRADIENTS[gradientIndexFor(stableSeed)];
  const letter = [...name.trim()][0] ?? "·";
  return (
    <span
      role="img"
      aria-label={`${name} 的人物头像`}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-lg border border-white/15 shadow-[inset_0_1px_0_oklch(1_0_0/0.25),0_1px_3px_oklch(0_0_0/0.4)]",
        sizes[size]
      )}
      style={{ backgroundImage: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` }}
    >
      <span className={cn("font-semibold leading-none text-white/95", AVATAR_LETTER_SIZE[size])}>{letter}</span>
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/15 to-transparent to-35%" aria-hidden />
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

/**
 * Palette index for a character. Sequential roster ids ("builtin-04") walk a
 * ×6 step around the hue-ordered palette — horizontal neighbours in a 2-column
 * grid differ by 6 steps (~135° hue), vertical ones by 12 (~270°) — so no two
 * adjacent cards can share a family. Ad-hoc ids fall back to the hash.
 */
function gradientIndexFor(seed: string): number {
  const sequential = /(\d+)\s*$/.exec(seed);
  if (sequential) {
    const ordinal = Number(sequential[1]);
    if (Number.isFinite(ordinal)) return (ordinal * 6) % AVATAR_GRADIENTS.length;
  }
  return (avatarHash(seed) >>> 5) % AVATAR_GRADIENTS.length;
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
  private: "border-dashed border-foreground/20 bg-foreground/5",
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

/** Story-beat keys (StoryBeatKind) as banner words; unknown keys pass through. */
export function beatLabel(beat: string | undefined): string {
  const labels: Record<string, string> = {
    betrayal: "背叛",
    "deception-exposed": "骗局被识破",
    alliance: "结成同盟",
    "promise-kept": "承诺兑现",
    "promise-broken": "承诺违约",
    comeback: "逆风翻盘",
    misplay: "失手",
    win: "一锤定音",
    "cooperative-outcome": "达成合作",
    "high-return": "高回报",
    "low-return": "低回报",
    "commitment-unresolved": "承诺未决",
    "unilateral-defection": "单方面背离",
    "free-riding": "搭便车",
    "adverse-outcome": "事与愿违",
    "agreement-reached": "达成约定",
    "negotiation-failed": "谈判破裂",
    "hidden-role-revealed": "隐藏身份揭晓"
  };
  return beat ? labels[beat] ?? beat : "";
}

export function formatTime(value: string, options?: { seconds?: boolean }): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: options?.seconds === false ? undefined : "2-digit",
    hour12: false
  }).format(date);
}

export function eventLabel(name: string): string {
  const labels: Record<string, string> = {
    communicate: "公开发言",
    message: "发言",
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
    make_offer: "提出报价",
    accept_commitment: "接受承诺",
    make_commitment: "立下承诺",
    log_deception_plan: "谋划欺骗",
    update_role_hypotheses: "推演身份",
    charm_target: "魅惑目标",
    dream_curse: "梦魇低语",
    decline_lady: "婉拒仙女",
    investigate_dead_identity: "验明出局者",
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

/** One shared visual language for provenance across every causality card. */
export function provenanceBadge(source: string): ReactNode {
  const labels: Record<string, string> = {
    "world-fact": "世界事实",
    "authorized-observation": "合法观察",
    "message-claim": "消息主张",
    "agent-self-report": "Agent 自述",
    "system-inference": "系统推断",
    presentation: "展示标签"
  };
  return <Badge variant="outline" className="h-4.5 shrink-0 rounded-full border-border/70 bg-card/60 px-1.5 text-[10px] font-normal text-muted-foreground">{labels[source] ?? source}</Badge>;
}

/** The one accordion section: icon/count shapes cover rail and causality uses. */
export function CollapsibleSection({ title, icon, count, defaultOpen = false, className, contentClassName, children }: {
  title: ReactNode;
  icon?: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("group/section rounded-lg border bg-card/40 shadow-[0_1px_2px_oklch(0_0_0/0.18)]", className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/30">
        {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span> : null}
        <span className="min-w-0 truncate">{title}</span>
        {count !== undefined && count > 0 ? <span className="ml-0.5 shrink-0 rounded-full border border-border/70 bg-muted/60 px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">{count}</span> : null}
        <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-data-[state=open]/section:rotate-180" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("space-y-2 border-t border-border/60 px-2.5 py-2.5", contentClassName)}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Tiny metadata chip; tone maps to the semantic color tokens. */
export function MiniChip({ tone = "neutral", className, title, children }: {
  tone?: "neutral" | "warn" | "secret" | "live";
  className?: string;
  title?: string;
  children: ReactNode;
}): ReactNode {
  const tones = {
    neutral: "border-border bg-card text-muted-foreground",
    warn: "border-warn/40 bg-warn/10 text-warn",
    secret: "border-secret/40 bg-secret/10 text-secret",
    live: "border-live/40 bg-live/10 text-live"
  };
  return <span title={title} className={cn("inline-flex items-center gap-1 rounded border px-1 text-[9px] leading-4", tones[tone], className)}>{children}</span>;
}

/** The one inline error surface: destructive hairline box with an alert glyph. */
export function ErrorNote({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] leading-5 text-destructive">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
