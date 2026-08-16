import type { AgentMoodState, CoreEmotions, PadState, SocialEmotions } from "./contracts";

/**
 * Dimensional affect model grounded in Mehrabian's PAD framework: a persistent
 * Pleasure-Arousal-Dominance vector, six core emotion intensities, a
 * Maslow-inspired needs layer, and decay-driven dynamics. Because LLM emotion
 * reasoning is fragile under complex context (arXiv:2508.05880), emotion is
 * kept as explicit structured appraisal — a PAD anchor plus a human-readable
 * label and description — that carries across turns, is tagged onto memories,
 * and is surfaced to the model as state rather than left to free-form recall.
 */

interface PadAnchor {
  label: string;
  description: string;
  pad: PadState;
}

/** Hand-picked anchors from Mehrabian's PAD atlas, mapped to Chinese labels. */
const PAD_ANCHORS: PadAnchor[] = [
  { label: "愤怒", description: "你感到被冒犯，想反击或让对方付出代价。愤怒会放大对抗冲动，但不要让它吞掉你的长期目标。", pad: { pleasure: -0.45, arousal: 0.5, dominance: 0.55 } },
  { label: "恐惧", description: "你感到威胁逼近，想避险或示弱求生。恐惧会抬高风险感知，也可能让你低估机会。", pad: { pleasure: -0.55, arousal: 0.55, dominance: -0.6 } },
  { label: "焦虑", description: "你感到不确定和压力，既想行动又想退缩。焦虑会让你更关注最坏情况。", pad: { pleasure: -0.35, arousal: 0.5, dominance: -0.4 } },
  { label: "警惕", description: "你保持戒备，注意对方措辞与行动的一致性，不轻易下注。", pad: { pleasure: -0.05, arousal: 0.35, dominance: 0.15 } },
  { label: "好奇", description: "你对局势感兴趣，愿意探索和试探，倾向于先收集信息再行动。", pad: { pleasure: 0.3, arousal: 0.4, dominance: 0.25 } },
  { label: "期待", description: "你相信机会正在成形，愿意主动推进计划并承担一定风险。", pad: { pleasure: 0.35, arousal: 0.35, dominance: 0.3 } },
  { label: "惊喜", description: "事态超出你的预期，你在快速消化新信息并调整判断。", pad: { pleasure: 0.25, arousal: 0.6, dominance: -0.15 } },
  { label: "兴奋", description: "你情绪高涨，行动欲强，可能高估收益而低估代价。", pad: { pleasure: 0.55, arousal: 0.55, dominance: 0.55 } },
  { label: "愉悦", description: "你心情不错，更愿意合作、共情和建立关系。", pad: { pleasure: 0.6, arousal: 0.25, dominance: 0.45 } },
  { label: "骄傲", description: "你对自己的位置感到满意，想巩固优势并展示掌控力。", pad: { pleasure: 0.5, arousal: 0.15, dominance: 0.55 } },
  { label: "满足", description: "你对当前处境基本满意，倾向维持现状，避免不必要的冲突。", pad: { pleasure: 0.5, arousal: -0.1, dominance: 0.3 } },
  { label: "冷静", description: "你心态平稳，能区分事实与推测，适合做长线判断。", pad: { pleasure: 0.1, arousal: -0.35, dominance: 0.2 } },
  { label: "放松", description: "你压力不大，语气松弛，但也可能因此低估风险。", pad: { pleasure: 0.3, arousal: -0.2, dominance: 0.1 } },
  { label: "疲惫", description: "你精力下降，更想用省力的方式推进，可能降低探索意愿。", pad: { pleasure: -0.15, arousal: -0.4, dominance: -0.3 } },
  { label: "委屈", description: "你觉得自己吃了亏或没被公平对待，想讨回公道。", pad: { pleasure: -0.4, arousal: 0.05, dominance: -0.25 } },
  { label: "厌恶", description: "你对某人或某种做法产生排斥，想保持距离。", pad: { pleasure: -0.5, arousal: 0.15, dominance: 0.1 } },
  { label: "沮丧", description: "你感到受挫和无力，可能想放弃当前路径或降低预期。", pad: { pleasure: -0.5, arousal: -0.3, dominance: -0.45 } },
  { label: "悲伤", description: "你情绪低落，对损失敏感，可能更谨慎也更愿意修复关系。", pad: { pleasure: -0.55, arousal: -0.15, dominance: -0.35 } },
  { label: "顺从", description: "你感到自己处于劣势，倾向配合对方以换取安全。", pad: { pleasure: -0.05, arousal: -0.15, dominance: -0.55 } }
];

const EMOTION_KEYS = ["joy", "sadness", "anger", "fear", "surprise", "disgust"] as const;

/** Turns for a state to decay to half its distance from neutral. */
const PAD_HALF_LIFE = 8;
const EMOTION_HALF_LIFE = 5;
const SOCIAL_HALF_LIFE = 6;
const ENERGY_HOMEOSTASIS = 0.85;

export const SOCIAL_EMOTION_KEYS = [
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

export function neutralSocialEmotions(): SocialEmotions {
  return {
    gratitude: 0.06,
    guilt: 0.05,
    shame: 0.05,
    embarrassment: 0.05,
    pride: 0.1,
    envy: 0.05,
    jealousy: 0.05,
    contempt: 0.05,
    admiration: 0.08,
    relief: 0.08
  };
}

export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function initialMood(turn = 0): AgentMoodState {
  return {
    label: "冷静",
    description: "心态平稳。",
    pad: { pleasure: 0.08, arousal: 0.15, dominance: 0.1 },
    emotions: { joy: 0.15, sadness: 0.1, anger: 0.08, fear: 0.15, surprise: 0.12, disgust: 0.05 },
    socialEmotions: neutralSocialEmotions(),
    needs: { security: 0.55, connection: 0.5, status: 0.5, autonomy: 0.6, achievement: 0.55 },
    energy: 0.9,
    updatedAtTurn: turn
  };
}

export function nearestAnchor(pad: PadState): PadAnchor {
  let best = PAD_ANCHORS[0];
  let bestDistance = Infinity;
  for (const anchor of PAD_ANCHORS) {
    const distance = padDistance(pad, anchor.pad);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

export function refreshMood(mood: AgentMoodState, turn: number): AgentMoodState {
  const anchor = nearestAnchor(mood.pad);
  return {
    ...mood,
    label: anchor.label,
    description: anchor.description,
    updatedAtTurn: turn
  };
}

/** Decay toward neutral. Called once per turn before new appraisal input. */
export function decayMood(mood: AgentMoodState, turn: number): AgentMoodState {
  const steps = Math.max(0, turn - mood.updatedAtTurn);
  if (steps <= 0) return mood;
  const padFactor = Math.pow(0.5, steps / PAD_HALF_LIFE);
  const emotionFactor = Math.pow(0.5, steps / EMOTION_HALF_LIFE);
  const socialFactor = Math.pow(0.5, steps / SOCIAL_HALF_LIFE);
  const pad: PadState = {
    pleasure: mood.pad.pleasure * padFactor,
    arousal: mood.pad.arousal * padFactor,
    dominance: mood.pad.dominance * padFactor
  };
  const emotions = Object.fromEntries(
    EMOTION_KEYS.map((key) => [key, mood.emotions[key] * emotionFactor])
  ) as unknown as CoreEmotions;
  const socialEmotions = Object.fromEntries(
    SOCIAL_EMOTION_KEYS.map((key) => [key, mood.socialEmotions[key] * socialFactor])
  ) as unknown as SocialEmotions;
  const energy = mood.energy + (ENERGY_HOMEOSTASIS - mood.energy) * (1 - Math.pow(0.5, steps / 12));
  return refreshMood({ ...mood, pad, emotions, socialEmotions, energy, updatedAtTurn: turn }, turn);
}

export function applyEmotionDeltas(emotions: CoreEmotions, deltas: Partial<CoreEmotions>): CoreEmotions {
  const next = { ...emotions };
  for (const key of EMOTION_KEYS) {
    const delta = deltas[key];
    if (delta !== undefined) next[key] = clampUnit(next[key] + delta);
  }
  return next;
}

export function applyPadDeltas(pad: PadState, deltas: Partial<PadState>): PadState {
  return {
    pleasure: clampSigned(pad.pleasure + (deltas.pleasure ?? 0)),
    arousal: clampSigned(pad.arousal + (deltas.arousal ?? 0)),
    dominance: clampSigned(pad.dominance + (deltas.dominance ?? 0))
  };
}

export function applyNeedsDeltas(needs: AgentMoodState["needs"], deltas: Partial<AgentMoodState["needs"]>): AgentMoodState["needs"] {
  const next = { ...needs };
  for (const key of Object.keys(next) as Array<keyof AgentMoodState["needs"]>) {
    const delta = deltas[key];
    if (delta !== undefined) next[key] = clampUnit(next[key] + delta);
  }
  return next;
}

export function padDistance(left: PadState, right: PadState): number {
  return Math.hypot(
    left.pleasure - right.pleasure,
    left.arousal - right.arousal,
    left.dominance - right.dominance
  );
}

export function describeEmotions(emotions: CoreEmotions): string {
  const labels: Record<keyof CoreEmotions, string> = {
    joy: "愉悦",
    sadness: "悲伤",
    anger: "愤怒",
    fear: "恐惧",
    surprise: "惊讶",
    disgust: "厌恶"
  };
  const active = EMOTION_KEYS
    .filter((key) => emotions[key] >= 0.35)
    .sort((left, right) => emotions[right] - emotions[left])
    .slice(0, 3)
    .map((key) => `${labels[key]} ${Math.round(emotions[key] * 10)}/10`);
  return active.length ? active.join("，") : "情绪平稳";
}

export function describeNeeds(needs: AgentMoodState["needs"]): string {
  const labels: Record<keyof AgentMoodState["needs"], string> = {
    security: "安全感",
    connection: "联结感",
    status: "地位感",
    autonomy: "自主感",
    achievement: "成就感"
  };
  return (Object.keys(needs) as Array<keyof AgentMoodState["needs"]>)
    .map((key) => `${labels[key]} ${Math.round(needs[key] * 10)}/10`)
    .join("，");
}

export function describeSocialEmotions(emotions: SocialEmotions): string {
  const labels: Record<(typeof SOCIAL_EMOTION_KEYS)[number], string> = {
    gratitude: "感激",
    guilt: "内疚",
    shame: "羞耻",
    embarrassment: "尴尬",
    pride: "骄傲",
    envy: "羡慕",
    jealousy: "嫉妒",
    contempt: "蔑视",
    admiration: "敬佩",
    relief: "如释重负"
  };
  const active = SOCIAL_EMOTION_KEYS
    .filter((key) => emotions[key] >= 0.35)
    .sort((left, right) => emotions[right] - emotions[left])
    .slice(0, 3)
    .map((key) => `${labels[key]} ${Math.round(emotions[key] * 10)}/10`);
  return active.length ? active.join("，") : "社会情绪平稳";
}