/**
 * TensionEngine — deterministic, presentation-only tension scoring.
 *
 * It consumes real event signals (world beats, eliminations, vote swings,
 * role actions, emotional spikes) and produces a decaying tension score with
 * a level (calm / warm / tense / climax). It never touches the world, never
 * advises agents, and never invents drama: signals it cannot observe simply
 * do not fire.
 */
import type { TensionReason, TensionSignal } from "../contracts";

export type TensionLevel = "calm" | "warm" | "tense" | "climax";

export interface TensionState {
  score: number;
  level: TensionLevel;
  reasons: TensionReason[];
  primaryAgentIds: string[];
}

export interface TensionImpact {
  reason: TensionReason;
  /** Overrides the reason's default boost; defaults to the reason's weight. */
  boost?: number;
  agentIds?: string[];
}

const LEVEL_THRESHOLDS: Array<[TensionLevel, number]> = [
  ["climax", 0.78],
  ["tense", 0.5],
  ["warm", 0.22],
  ["calm", 0]
];

const REASON_BOOST: Record<TensionReason, number> = {
  "direct-accusation": 0.18,
  contradiction: 0.16,
  betrayal: 0.34,
  "alliance-break": 0.28,
  "vote-swing": 0.22,
  "role-action": 0.16,
  "deception-exposed": 0.4,
  save: 0.26,
  elimination: 0.42,
  "win-condition-near": 0.3,
  "emotional-spike": 0.12
};

export class TensionEngine {
  private state: TensionState = { score: 0, level: "calm", reasons: [], primaryAgentIds: [] };

  constructor(private readonly options: {
    /** Score decay per tick (default 0.06). */
    decayPerTick?: number;
    /** Seconds between ticks (default 10). */
    tickSeconds?: number;
    /** Minimum seconds between two high-priority impacts (default 2.5). */
    minImpactGapMs?: number;
  } = {}) {}

  snapshot(): TensionState {
    return { ...this.state, reasons: [...this.state.reasons], primaryAgentIds: [...this.state.primaryAgentIds] };
  }

  /** One decay tick; returns true when the level changed. */
  tick(now: number): boolean {
    const decay = this.options.decayPerTick ?? 0.06;
    const before = this.state.level;
    this.state.score = Math.max(0, this.state.score - decay);
    this.state.level = levelFor(this.state.score);
    return before !== this.state.level;
  }

  /** Apply one real event impact; returns the resulting state when it moved. */
  impact(impact: TensionImpact, eventId: string, now: number): { state: TensionState; signal: TensionSignal } | undefined {
    const boost = impact.boost ?? REASON_BOOST[impact.reason];
    if (boost === undefined) return undefined;
    const beforeScore = this.state.score;
    this.state.score = Math.min(1, this.state.score + boost);
    this.state.reasons = [...this.state.reasons.filter((entry) => entry !== impact.reason), impact.reason].slice(-4);
    if (impact.agentIds?.length) {
      this.state.primaryAgentIds = [...new Set([...impact.agentIds, ...this.state.primaryAgentIds])].slice(0, 4);
    }
    const level = levelFor(this.state.score);
    const changed = level !== this.state.level || Math.abs(this.state.score - beforeScore) >= 0.02;
    this.state.level = level;
    if (!changed) return undefined;
    return {
      state: this.snapshot(),
      signal: {
        eventId,
        score: this.state.score,
        reasons: [...this.state.reasons],
        primaryAgentIds: [...this.state.primaryAgentIds]
      }
    };
  }
}

export function reasonBoost(reason: TensionReason): number {
  return REASON_BOOST[reason];
}

export function levelFor(score: number): TensionLevel {
  for (const [level, threshold] of LEVEL_THRESHOLDS) {
    if (score >= threshold) return level;
  }
  return "calm";
}

export function levelLabel(level: TensionLevel): string {
  return level === "calm" ? "平静" : level === "warm" ? "升温" : level === "tense" ? "紧张" : "高潮";
}

export function reasonLabel(reason: TensionReason): string {
  const labels: Record<TensionReason, string> = {
    "direct-accusation": "公开指控",
    contradiction: "前后矛盾",
    betrayal: "背叛",
    "alliance-break": "联盟破裂",
    "vote-swing": "票型翻转",
    "role-action": "角色行动",
    "deception-exposed": "谎言揭穿",
    save: "绝处逢生",
    elimination: "淘汰",
    "win-condition-near": "胜负一线",
    "emotional-spike": "情绪爆发"
  };
  return labels[reason];
}