/**
 * Event-driven social appraisal (OCC / EMA style, grounded in arXiv:2508.05880).
 *
 * Research shows LLM emotion reasoning is fragile under complex context, so
 * emotions are NOT left to the model to self-report. Instead the world emits
 * structured, observer-scoped events (someone accused me, someone defended me,
 * I was eliminated, my faction won), and this deterministic engine translates
 * them into PAD / core-emotion / social-emotion / need / relationship deltas,
 * modulated by the character's Big Five profile. The model can interpret and
 * express the resulting state, but the underlying update is event-driven and
 * consistent — the same event moves different characters differently.
 *
 * Every update has a causal chain: event -> appraisal -> state (the updated
 * state is injected into every participant's context). Long-term memory is the
 * model's own SDK session history; settlement outcomes reach the spectator
 * MindSheet as display-only notes via `noteOutcome`.
 */

import type { AgentMindState, AgentProfile, AgentTemperament, DecisionBias, SocialEvent } from "./contracts";
import { applyEmotionDeltas, applyNeedsDeltas, applyPadDeltas, clampUnit } from "./affect";

export interface AppraisalSummary {
  changed: boolean;
}

interface Deltas {
  emotions?: Partial<Record<"joy" | "sadness" | "anger" | "fear" | "surprise" | "disgust", number>>;
  social?: Partial<Record<
    "gratitude" | "guilt" | "shame" | "embarrassment" | "pride" | "envy" | "jealousy" | "contempt" | "admiration" | "relief",
    number
  >>;
  pad?: { pleasure?: number; arousal?: number; dominance?: number };
  needs?: { security?: number; connection?: number; status?: number; autonomy?: number; achievement?: number };
  energy?: number;
  relationship?: { trust?: number; affinity?: number; respect?: number; tension?: number };
  salience: number;
}

const SOCIAL_KEYS = [
  "gratitude",
  "guilt",
  "shame",
  "embarrassment",
  "pride",
  "envy",
  "jealousy",
  "contempt",
  "admiration",
  "relief"
] as const;

/** Modulate a base delta by a personality trait: trait pulls amplify the effect. */
function mod(base: number, trait: number | undefined, strength = 1): number {
  if (trait === undefined) return base;
  return base * (1 + (trait - 0.5) * 2 * strength);
}

export function appraiseEvents(
  mind: AgentMindState,
  profile: AgentProfile,
  events: SocialEvent[],
  turn: number,
  effectiveTemperament?: AgentTemperament,
  /** Resolves a world actor id to the character's stable id. */
  resolveCharacterId?: (actorId: string) => string | undefined
): AppraisalSummary {
  // The effective Big Five (baseline + bounded adaptation) modulates how the
  // same event lands; the stored profile baseline stays untouched.
  const temperament = effectiveTemperament ?? profile.temperament;
  const biases = new Set(profile.decisionBiases ?? []);
  let changed = false;

  for (const event of events) {
    const raw = appraisalFor(mind, event, temperament);
    if (!raw) continue;
    const biased = modulateByBiases(raw, biases);
    const deltas = modulateByRegulation(biased, profile.regulation);
    changed = true;
    apply(mind, event, deltas, turn, resolveCharacterId);
    mind.lastAppraisals.push({
      text: `${eventTypeLabel(event.type)}：${event.detail}`,
      turn,
      at: new Date().toISOString()
    });
    if (mind.lastAppraisals.length > 8) mind.lastAppraisals.splice(0, mind.lastAppraisals.length - 8);
  }

  return { changed };
}

const NEGATIVE_EMOTIONS = ["anger", "fear", "sadness", "disgust"] as const;

/**
 * Stable judgment biases, measurably applied: a bias is part of the
 * character, fixed for life, and modulates how the same event lands — it is
 * never a per-round random error. Three biases are measurable here:
 *
 *  - betrayal-hypervigilance deepens trust drops and raises tension;
 *  - loss-aversion amplifies negative affect (losses loom larger);
 *  - recency-weighting boosts the salience of fresh memories, so recent
 *    events crowd out older patterns when the agent recalls.
 */
export function modulateByBiases(deltas: Deltas, biases: ReadonlySet<DecisionBias>): Deltas {
  if (biases.size === 0) return deltas;
  const next: Deltas = structuredClone(deltas);
  if (biases.has("betrayal-hypervigilance")) {
    if (next.relationship) {
      const { trust, tension } = next.relationship;
      if (trust !== undefined && trust < 0) next.relationship.trust = trust * 1.35;
      if (tension !== undefined && tension > 0) next.relationship.tension = tension * 1.2;
    }
  }
  if (biases.has("loss-aversion")) {
    const emotions = next.emotions ?? {};
    for (const key of NEGATIVE_EMOTIONS) {
      if (emotions[key] !== undefined) emotions[key] *= 1.15;
    }
    if (next.emotions) next.emotions = emotions;
    if (next.pad?.pleasure !== undefined && next.pad.pleasure < 0) next.pad.pleasure *= 1.1;
  }
  if (biases.has("recency-weighting")) {
    next.salience = Math.min(1, next.salience * 1.2);
  }
  return next;
}

/**
 * Gross-style emotion regulation: the same event lands differently depending
 * on how the character copes (arXiv:2508.05880; Gross 1998 process model).
 * Reappraisers blunt the sting and keep the good; suppressors bury the
 * feeling at an energy cost; ruminators amplify and prolong; act-out types
 * externalize anger into dominance; repairers soften relationship damage.
 */
function modulateByRegulation(
  deltas: Deltas,
  regulation: AgentProfile["regulation"]
): Deltas {
  if (!regulation) return deltas;
  const next: Deltas = structuredClone(deltas);
  const emotions = next.emotions ?? {};
  const pad = next.pad ?? {};
  if (regulation === "reappraise") {
    for (const key of NEGATIVE_EMOTIONS) {
      if (emotions[key] !== undefined) emotions[key] *= 0.7;
    }
    if (emotions.joy !== undefined) emotions.joy *= 1.15;
    if (pad.pleasure !== undefined) pad.pleasure *= 0.8;
  } else if (regulation === "suppress") {
    for (const key of NEGATIVE_EMOTIONS) {
      if (emotions[key] !== undefined) emotions[key] *= 0.5;
    }
    if (next.social?.shame !== undefined) next.social.shame *= 0.6;
    next.energy = (next.energy ?? 0) - 0.04;
    if (pad.arousal !== undefined) pad.arousal += 0.03;
  } else if (regulation === "ruminate") {
    for (const key of NEGATIVE_EMOTIONS) {
      if (emotions[key] !== undefined) emotions[key] *= 1.15;
    }
    if (pad.arousal !== undefined) pad.arousal += 0.04;
  } else if (regulation === "act-out") {
    if (emotions.anger !== undefined) emotions.anger *= 1.2;
    if (pad.dominance !== undefined) pad.dominance += 0.04;
    if (next.relationship?.tension !== undefined) next.relationship.tension += 0.04;
  } else if (regulation === "repair") {
    if (next.relationship) {
      for (const key of ["trust", "affinity"] as const) {
        const value = next.relationship[key];
        if (value !== undefined && value < 0) next.relationship[key] = value * 0.6;
      }
      const tension = next.relationship.tension;
      if (tension !== undefined) next.relationship.tension = tension * 0.7;
    }
    if (next.social?.guilt !== undefined) next.social.guilt *= 1.1;
  }
  if (Object.keys(emotions).length) next.emotions = emotions;
  next.pad = pad;
  return next;
}

function eventTypeLabel(type: SocialEvent["type"]): string {
  const labels: Record<SocialEvent["type"], string> = {
    accused: "被公开指控",
    defended: "被公开辩护",
    threatened: "收到直接威胁",
    endorsed: "得到他人支持",
    "apologized-to": "收到道歉",
    "warning-received": "收到风险提醒",
    "socially-accepted": "提议获得口头接受",
    "socially-rejected": "提议被口头拒绝",
    "vote-against": "被投票针对",
    "vote-cast": "投出一票",
    "voted-with": "有人与你同票",
    eliminated: "被淘汰",
    "eliminated-other": "他人被淘汰",
    revealed: "身份被公开揭示",
    investigation: "查验结果",
    "night-kill": "参与夜间行动",
    included: "被选入队伍",
    excluded: "被排除在队伍外",
    "alliance-proposed": "收到合作提议",
    "agreement-reached": "达成交易协议",
    "negotiation-failed": "交易未达成",
    "offer-proposed": "收到交易报价",
    "offer-rejected": "交易报价被拒绝",
    "quest-passed": "任务成功",
    "quest-failed": "任务失败",
    assassinated: "被刺杀",
    "commitment-proposed": "有人向你公开承诺",
    "commitment-accepted": "承诺被明确接受",
    "commitment-fulfilled": "承诺兑现",
    "commitment-violated": "承诺破裂",
    "opponent-cooperated": "对方选择合作",
    "opponent-defected": "对方选择不合作",
    "competitive-bid-received": "收到新的竞争叫价",
    "bid-challenged": "自己的叫价受到质疑",
    "investment-made": "投资结算",
    "return-made": "返还结算",
    win: "赢得本局",
    lose: "输掉本局"
  };
  return labels[type] ?? type;
}

function appraisalFor(mind: AgentMindState, event: SocialEvent, t: AgentTemperament | undefined): Deltas | null {
  const N = t?.neuroticism;
  const A = t?.agreeableness;
  const C = t?.conscientiousness;
  const E = t?.extraversion;

  switch (event.type) {
    case "accused": {
      const anger = mod(0.2, N, 1.2);
      return {
        emotions: { anger, fear: mod(0.08, N, 1.4), surprise: mod(0.06, t?.openness, 0.8) },
        social: { shame: mod(0.1, E, 0.8), contempt: mod(0.06, A, -0.6) },
        pad: { pleasure: -0.12, arousal: 0.1, dominance: -0.08 },
        needs: { status: -0.1, security: -0.06 },
        relationship: { trust: -0.06, tension: 0.16, respect: -0.04 },
        salience: 0.6
      };
    }
    case "defended": {
      return {
        emotions: { joy: 0.08 },
        social: { gratitude: mod(0.22, A, 0.8), relief: 0.12 },
        pad: { pleasure: 0.1 },
        needs: { security: 0.08, connection: 0.08 },
        relationship: { trust: 0.06, affinity: 0.1, tension: -0.04 },
        salience: 0.55
      };
    }
    case "threatened": {
      return {
        emotions: { fear: mod(0.18, N, 1.3), anger: mod(0.14, N, 0.9) },
        social: { contempt: mod(0.08, A, -0.5) },
        pad: { pleasure: -0.12, arousal: 0.14, dominance: -0.08 },
        needs: { security: -0.16, autonomy: -0.08 },
        relationship: { trust: -0.12, affinity: -0.06, tension: 0.18, respect: -0.03 },
        salience: 0.72
      };
    }
    case "endorsed": {
      return {
        emotions: { joy: 0.07 },
        social: { gratitude: mod(0.12, A, 0.7), pride: mod(0.06, E, 0.5) },
        pad: { pleasure: 0.08, dominance: 0.04 },
        needs: { connection: 0.07, status: 0.06 },
        relationship: { trust: 0.05, affinity: 0.08, respect: 0.04, tension: -0.03 },
        salience: 0.48
      };
    }
    case "apologized-to": {
      return {
        emotions: { surprise: 0.04 },
        social: { relief: mod(0.1, A, 0.6) },
        pad: { pleasure: 0.04, arousal: -0.04 },
        needs: { connection: 0.05 },
        relationship: { trust: 0.03, affinity: 0.05, respect: 0.04, tension: -0.09 },
        salience: 0.52
      };
    }
    case "warning-received": {
      return {
        emotions: { fear: mod(0.07, N, 1), surprise: 0.05 },
        social: { gratitude: mod(0.05, A, 0.5) },
        pad: { arousal: 0.07 },
        needs: { security: -0.03 },
        relationship: { trust: 0.02, respect: 0.03 },
        salience: 0.42
      };
    }
    case "socially-accepted": {
      return {
        emotions: { joy: 0.06 },
        social: { gratitude: mod(0.07, A, 0.5), relief: 0.04 },
        pad: { pleasure: 0.06, dominance: 0.03 },
        needs: { connection: 0.05, achievement: 0.04 },
        relationship: { trust: 0.03, affinity: 0.05, respect: 0.02, tension: -0.03 },
        salience: 0.43
      };
    }
    case "socially-rejected": {
      return {
        emotions: { sadness: 0.04, anger: mod(0.025, N, 0.7) },
        pad: { pleasure: -0.04, dominance: -0.025 },
        needs: { connection: -0.035, achievement: -0.03 },
        relationship: { affinity: -0.025, tension: 0.035 },
        salience: 0.4
      };
    }
    case "alliance-proposed": {
      return {
        emotions: { joy: mod(0.04, A, 0.5), surprise: 0.04 },
        pad: { pleasure: 0.04, arousal: 0.04 },
        needs: { connection: 0.06, status: 0.03 },
        relationship: { affinity: 0.04, respect: 0.02, tension: -0.02 },
        salience: 0.45
      };
    }
    case "offer-proposed": {
      return {
        emotions: { surprise: 0.04 },
        pad: { arousal: 0.04, dominance: 0.02 },
        needs: { autonomy: 0.03, achievement: 0.03 },
        relationship: { respect: 0.01 },
        salience: 0.4
      };
    }
    case "offer-rejected": {
      return {
        emotions: { sadness: 0.04, anger: mod(0.03, N, 0.8) },
        pad: { pleasure: -0.04, dominance: -0.03 },
        needs: { achievement: -0.04 },
        relationship: { affinity: -0.02, tension: 0.03 },
        salience: 0.38
      };
    }
    case "agreement-reached": {
      return {
        emotions: { joy: 0.08 },
        social: { gratitude: mod(0.06, A, 0.5), relief: 0.05 },
        pad: { pleasure: 0.08, dominance: 0.03 },
        needs: { achievement: 0.07, connection: 0.04 },
        relationship: { trust: 0.04, affinity: 0.04, respect: 0.03, tension: -0.02 },
        salience: 0.5
      };
    }
    case "negotiation-failed": {
      return {
        emotions: { sadness: 0.04 },
        pad: { pleasure: -0.04 },
        needs: { achievement: -0.05 },
        salience: 0.38
      };
    }
    case "vote-against": {
      return {
        emotions: { anger: mod(0.14, N, 1.2), sadness: 0.06, fear: mod(0.06, N, 1.4) },
        social: { contempt: mod(0.08, A, -0.6) },
        pad: { pleasure: -0.1, dominance: -0.04 },
        needs: { security: -0.1, status: -0.06 },
        relationship: { trust: -0.14, affinity: -0.06, tension: 0.14 },
        salience: 0.7
      };
    }
    case "vote-cast": {
      return { pad: { arousal: 0.03, dominance: 0.04 }, energy: -0.02, salience: 0.2 };
    }
    case "voted-with": {
      return {
        emotions: { joy: 0.05 },
        social: { gratitude: 0.1, admiration: 0.03 },
        relationship: { trust: 0.05, affinity: 0.06 },
        salience: 0.4
      };
    }
    case "eliminated": {
      const satisfied = Boolean(event.facts?.satisfied);
      if (satisfied) {
        // The jester's goal: being voted out IS the win.
        return {
          emotions: { joy: 0.2, surprise: 0.08 },
          social: { pride: mod(0.25, E, 0.8), relief: 0.3 },
          pad: { pleasure: 0.2, dominance: 0.1 },
          needs: { achievement: 0.15, status: 0.1 },
          salience: 0.9
        };
      }
      const byVote = event.facts?.by === "vote";
      return {
        emotions: { fear: mod(0.22, N, 1.2), sadness: 0.18, ...(byVote ? { anger: mod(0.12, N, 1.2) } : {}) },
        social: { shame: mod(0.08, E, 0.8) },
        pad: { pleasure: -0.2, dominance: -0.22 },
        needs: { security: -0.22, status: -0.12 },
        energy: -0.12,
        salience: 0.9
      };
    }
    case "eliminated-other": {
      const role = event.facts?.role as string | undefined;
      const evil = role === "狼人" || role === "刺客" || role === "莫德雷德" || role === "内奸";
      const iVoted = Boolean(event.facts?.iVoted);
      const ally = Boolean(event.facts?.ally);
      if (evil && iVoted) {
        return {
          emotions: { joy: 0.1 },
          social: { pride: mod(0.16, E, 0.8), relief: 0.08 },
          pad: { pleasure: 0.12, dominance: 0.08 },
          needs: { status: 0.06, achievement: 0.08 },
          salience: 0.6
        };
      }
      if (ally || role === "村民" || role === "预言家" || role === "好人") {
        return {
          emotions: { sadness: 0.12, fear: mod(0.1, N, 1.2) },
          social: { ...(iVoted ? { guilt: mod(0.12, A, 1), shame: mod(0.08, C, 1) } : {}) },
          pad: { pleasure: -0.12 },
          needs: { security: -0.08, status: -0.04 },
          energy: -0.04,
          salience: 0.6
        };
      }
      // Role unknown or third-party (jester).
      return {
        emotions: { surprise: 0.12, ...(role === "小丑" ? { anger: 0.06, disgust: 0.08 } : {}) },
        social: { ...(role === "小丑" ? { shame: mod(0.08, C, 0.8) } : {}) },
        pad: { arousal: 0.08 },
        salience: 0.5
      };
    }
    case "investigation": {
      const foundWolf = event.facts?.role === "狼人";
      return {
        emotions: { surprise: mod(0.08, t?.openness, 0.6), ...(foundWolf ? { joy: 0.04 } : { fear: 0.06 }) },
        social: foundWolf ? { relief: 0.1, admiration: 0.04 } : undefined,
        salience: 0.5
      };
    }
    case "night-kill": {
      return {
        emotions: { fear: mod(0.08, N, 1.2), ...(A && A > 0.55 ? { sadness: 0.06 } : {}) },
        social: { guilt: mod(0.14, A, 1) },
        pad: { dominance: 0.1, arousal: 0.06 },
        needs: { status: 0.06 },
        salience: 0.6
      };
    }
    case "included": {
      return {
        emotions: { joy: 0.06 },
        social: { pride: mod(0.08, E, 0.8) },
        pad: { pleasure: 0.06, dominance: 0.04 },
        needs: { status: 0.08, connection: 0.06 },
        relationship: { trust: 0.04, affinity: 0.05 },
        salience: 0.4
      };
    }
    case "excluded": {
      return {
        emotions: { sadness: 0.06 },
        needs: { status: -0.08, connection: -0.05 },
        relationship: { trust: -0.03, tension: 0.05 },
        salience: 0.45
      };
    }
    case "quest-passed": {
      const onTeam = Boolean(event.facts?.onTeam);
      if (onTeam) {
        return {
          emotions: { joy: 0.1 },
          social: { pride: mod(0.12, E, 0.8), relief: 0.1 },
          pad: { pleasure: 0.1, dominance: 0.06 },
          needs: { status: 0.08, achievement: 0.1 },
          salience: 0.55
        };
      }
      return {
        emotions: { joy: 0.06 },
        social: { relief: 0.08 },
        salience: 0.35
      };
    }
    case "quest-failed": {
      const onTeam = Boolean(event.facts?.onTeam);
      const evil = Boolean(event.facts?.evil);
      if (onTeam && evil) {
        // The mission succeeded for evil — but exposure risk is real.
        return {
          emotions: { fear: mod(0.12, N, 1.2) },
          social: { relief: 0.12, pride: 0.1 },
          needs: { security: -0.06 },
          salience: 0.6
        };
      }
      if (onTeam) {
        // A loyal member of a failed team: implicated, ashamed, afraid.
        return {
          emotions: { fear: mod(0.16, N, 1.2), sadness: 0.1 },
          social: { shame: mod(0.1, C, 0.8) },
          pad: { pleasure: -0.12, dominance: -0.08 },
          needs: { security: -0.12, status: -0.08 },
          salience: 0.7
        };
      }
      return {
        emotions: { fear: mod(0.1, N, 1.2), anger: mod(0.08, N, 1) },
        social: { contempt: mod(0.08, A, -0.6) },
        pad: { arousal: 0.06 },
        needs: { security: -0.08 },
        salience: 0.5
      };
    }
    case "assassinated": {
      const correct = Boolean(event.facts?.correct);
      return {
        emotions: { fear: 0.12, sadness: 0.12 },
        social: correct ? { relief: 0.2, pride: 0.1 } : { relief: 0.15 },
        pad: { pleasure: -0.1, dominance: -0.1 },
        needs: { security: -0.15 },
        salience: 0.8
      };
    }
    case "commitment-proposed": {
      // A declaration is only a claim until the action settles; it earns
      // attention, not relationship credit — nothing has been kept yet.
      return { pad: { arousal: 0.04 }, needs: { security: 0.04 }, salience: 0.45 };
    }
    case "commitment-accepted": {
      return {
        social: { gratitude: mod(0.05, A, 0.5) },
        pad: { pleasure: 0.03 },
        needs: { connection: 0.03 },
        salience: 0.4
      };
    }
    case "commitment-fulfilled": {
      return {
        emotions: { joy: 0.06 },
        social: { gratitude: mod(0.18, A, 0.8) },
        pad: { pleasure: 0.08 },
        needs: { security: 0.08, connection: 0.06 },
        relationship: { trust: 0.12, affinity: 0.08, tension: -0.04 },
        salience: 0.6
      };
    }
    case "commitment-violated": {
      return {
        emotions: { anger: mod(0.2, N, 1.2), sadness: 0.08 },
        social: { contempt: mod(0.1, A, -0.6) },
        pad: { pleasure: -0.14, dominance: -0.06 },
        needs: { security: -0.12 },
        relationship: { trust: -0.25, affinity: -0.1, tension: 0.2, respect: -0.08 },
        salience: 0.8
      };
    }
    case "investment-made": {
      // The actor's own sealed action; light engagement, no relationship effect.
      return { pad: { arousal: 0.03 }, energy: -0.02, salience: 0.2 };
    }
    case "return-made": {
      return { pad: { arousal: 0.03 }, salience: 0.25 };
    }
    case "opponent-cooperated": {
      return {
        emotions: { joy: 0.07 },
        social: { gratitude: mod(0.12, A, 0.7) },
        pad: { pleasure: 0.08 },
        needs: { security: 0.06, connection: 0.06 },
        relationship: { trust: 0.1, affinity: 0.05, tension: -0.04 },
        salience: 0.58
      };
    }
    case "opponent-defected": {
      const selfCooperated = event.facts?.selfMove === "cooperate";
      return {
        emotions: selfCooperated
          ? { anger: mod(0.16, N, 1), sadness: 0.07 }
          : { surprise: 0.03 },
        ...(selfCooperated ? { social: { contempt: mod(0.07, A, -0.5) } } : {}),
        pad: selfCooperated ? { pleasure: -0.11, arousal: 0.07 } : { arousal: 0.02 },
        ...(selfCooperated ? { needs: { security: -0.1, connection: -0.05 } } : {}),
        relationship: selfCooperated
          ? { trust: -0.16, affinity: -0.06, tension: 0.13, respect: -0.03 }
          : { trust: -0.04, tension: 0.03 },
        salience: selfCooperated ? 0.74 : 0.42
      };
    }
    case "competitive-bid-received": {
      return {
        emotions: { surprise: 0.035 },
        pad: { arousal: 0.06, dominance: -0.02 },
        needs: { autonomy: -0.025, achievement: 0.04 },
        relationship: { tension: 0.025, respect: 0.01 },
        salience: 0.34
      };
    }
    case "bid-challenged": {
      const bidWasTrue = Boolean(event.facts?.bidWasTrue);
      return {
        emotions: bidWasTrue
          ? { anger: mod(0.055, N, 0.8), surprise: 0.03 }
          : { fear: mod(0.06, N, 1), surprise: 0.055 },
        social: bidWasTrue
          ? { pride: mod(0.055, E, 0.6) }
          : { shame: mod(0.075, C, 0.7) },
        pad: { arousal: 0.085, dominance: bidWasTrue ? 0.025 : -0.06 },
        needs: { status: bidWasTrue ? 0.025 : -0.065, security: -0.035 },
        relationship: { tension: 0.075, respect: bidWasTrue ? -0.01 : 0.035 },
        salience: 0.58
      };
    }
    case "win": {
      return {
        emotions: { joy: 0.22 },
        social: { pride: mod(0.18, E, 0.8), relief: 0.1 },
        pad: { pleasure: 0.18, dominance: 0.12 },
        needs: { status: 0.12, achievement: 0.14, security: 0.06 },
        energy: 0.04,
        salience: 0.8
      };
    }
    case "lose": {
      return {
        emotions: { sadness: 0.18, anger: mod(0.1, N, 1) },
        social: { shame: mod(0.08, C, 0.8) },
        pad: { pleasure: -0.16, dominance: -0.1 },
        needs: { status: -0.12, achievement: -0.1 },
        energy: -0.06,
        salience: 0.7
      };
    }
    default:
      return null;
  }
}

function apply(
  mind: AgentMindState,
  event: SocialEvent,
  deltas: Deltas,
  turn: number,
  resolveCharacterId?: (actorId: string) => string | undefined
): void {
  if (deltas.emotions) mind.mood.emotions = applyEmotionDeltas(mind.mood.emotions, deltas.emotions);
  if (deltas.pad) mind.mood.pad = applyPadDeltas(mind.mood.pad, deltas.pad);
  if (deltas.needs) mind.mood.needs = applyNeedsDeltas(mind.mood.needs, deltas.needs);
  if (deltas.energy !== undefined) mind.mood.energy = clampUnit(mind.mood.energy + deltas.energy);
  if (deltas.social) {
    for (const key of SOCIAL_KEYS) {
      const delta = deltas.social[key];
      if (delta !== undefined) mind.mood.socialEmotions[key] = clampUnit(mind.mood.socialEmotions[key] + delta);
    }
  }
  if (deltas.relationship && event.actorId && event.actorId !== event.targetId) {
    const targetId = resolveCharacterId?.(event.actorId) ?? event.actorId;
    const relationship = mind.relationships.find((candidate) => candidate.targetCharacterId === targetId);
    if (relationship) {
      relationship.trust = clampUnit(relationship.trust + (deltas.relationship.trust ?? 0));
      relationship.affinity = clampUnit(relationship.affinity + (deltas.relationship.affinity ?? 0));
      relationship.respect = clampUnit(relationship.respect + (deltas.relationship.respect ?? 0));
      relationship.tension = clampUnit(relationship.tension + (deltas.relationship.tension ?? 0));
      relationship.familiarity = clampUnit(relationship.familiarity + 0.05);
      relationship.updatedAtTurn = turn;
      relationship.note = event.detail;
    }
  }
}
