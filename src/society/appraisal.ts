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
 * Every update has a causal chain: event -> appraisal -> state + memory ->
 * future behavior (state is injected into every participant's context, and
 * salient events become retrievable memories).
 */

import type { AgentMindState, AgentProfile, AgentTemperament, SocialEvent } from "./contracts";
import { applyEmotionDeltas, applyNeedsDeltas, applyPadDeltas, clampSigned, clampUnit } from "./affect";

export interface AppraisalMemorySeed {
  text: string;
  tags: string[];
  salience: number;
  valence: number;
}

export interface AppraisalSummary {
  changed: boolean;
  memories: AppraisalMemorySeed[];
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
  turn: number
): AppraisalSummary {
  const temperament = profile.temperament;
  const memories: AppraisalMemorySeed[] = [];
  let changed = false;

  for (const event of events) {
    const deltas = appraisalFor(mind, event, temperament);
    if (!deltas) continue;
    changed = true;
    apply(mind, event, deltas, turn);
    const valence = estimateValence(deltas);
    memories.push({
      text: event.detail,
      tags: [event.type, `turn:${turn}`, ...(event.actorId ? [event.actorId] : []), ...(event.targetId ? [event.targetId] : [])],
      salience: deltas.salience,
      valence
    });
  }

  return { changed, memories };
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

function apply(mind: AgentMindState, event: SocialEvent, deltas: Deltas, turn: number): void {
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
    const relationship = mind.relationships.find((candidate) => candidate.agentId === event.actorId);
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

function estimateValence(deltas: Deltas): number {
  const pad = deltas.pad;
  const pleasure = pad?.pleasure ?? 0;
  const emotionJoy = deltas.emotions?.joy ?? 0;
  const emotionSadness = deltas.emotions?.sadness ?? 0;
  const emotionAnger = deltas.emotions?.anger ?? 0;
  return clampSigned(pleasure * 0.7 + emotionJoy * 0.5 - emotionSadness * 0.5 - emotionAnger * 0.3);
}
