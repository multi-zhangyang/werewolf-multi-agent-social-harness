import type { AgentTemperament, CharacterDefinition, DecisionBias } from "../society/contracts";
import type { Character } from "./types";

export const temperamentDimensions: Array<{ key: keyof AgentTemperament; label: string; low: string; high: string }> = [
  { key: "openness", label: "开放性", low: "沿用熟悉的判断", high: "尝试新的解释和策略" },
  { key: "conscientiousness", label: "审慎性", low: "随情境调整计划", high: "核对证据，重视前后一致" },
  { key: "extraversion", label: "外向性", low: "先观察，必要时再开口", high: "主动接触，争取对话主动权" },
  { key: "agreeableness", label: "宜人性", low: "直接争取自己的利益", high: "照顾关系，愿意寻找共同利益" },
  { key: "neuroticism", label: "威胁敏感性", low: "面对不确定仍较为平静", high: "更容易注意损失和关系威胁" },
];

export const biasDescriptions: Record<DecisionBias, { label: string; tendency: string }> = {
  confirmation: { label: "确认偏差", tendency: "形成判断后，更容易注意支持它的线索，但直接反证仍然可能让你改口" },
  "loss-aversion": { label: "损失厌恶", tendency: "同等的损失比收益更牵动你，尤其在要付出真金白银的时候" },
  "sunk-cost": { label: "沉没成本", tendency: "已经投入很多时，会更不甘心退出" },
  "in-group": { label: "内群体偏好", tendency: "更愿意给曾站在你这边的人留余地，但同伴也可能利用你" },
  "authority-sensitivity": { label: "权威敏感", tendency: "有资历或掌握话语权的人，其判断更容易影响你" },
  "betrayal-hypervigilance": { label: "背叛警觉", tendency: "格外留意承诺和行动的落差，信任受损后需要新的行动证据" },
  "overconfident-lie-detection": { label: "识谎自信", tendency: "容易相信自己看穿了别人的意图，这份自信也可能使你误判" },
  "self-consistency": { label: "自我一致", tendency: "在意自己说过的话，不愿轻易推翻自己的公开立场" },
  "recency-weighting": { label: "近因偏重", tendency: "刚发生的互动更容易左右你对一个人的印象" },
};

export const regulationDescriptions: Record<NonNullable<CharacterDefinition["regulation"]>, { label: string; tendency: string }> = {
  reappraise: { label: "重新理解", tendency: "受挫时先寻找另一种解释，再决定是否改变做法" },
  suppress: { label: "克制情绪", tendency: "不轻易暴露不满，可能在实际选择上收紧底线" },
  ruminate: { label: "反复回想", tendency: "容易记挂让你难受的细节，下一次接触仍会受它影响" },
  "act-out": { label: "直接反击", tendency: "受挑衅时倾向当场回应，也可能因此付出额外代价" },
  repair: { label: "修复关系", tendency: "关系受损时愿意问清缘由，寻找一次可验证的修复机会" },
};

export const personalityPromptVersion = "personality-context-v1";

/** Qualitative priors, never an action policy or a claim about an agent's inner state. */
export function characterInstructions(character: Character, mode: "full" | "persona-only" = "full", objective: "character" | "score" = "character"): string[] {
  if (objective === "score") return [
    `你是${character.name}，参与收益优先对照。表达习惯：${character.voice}`,
    "本局唯一决策目标是提高本人的整局累计点数。保留记忆和对手学习；信誉、合作、隐瞒、虚报及探索都是可选手段。诚实、公平、关系和情绪不具有独立效用，仅考虑其对后续所得的影响。不要求欺骗，也不要求合作。",
    "旧计划或经验若与本局目标不符，应明确拒绝或修订；不要将人格偏好当成额外收益。",
  ];
  const lines = [
    `你是${character.name}，正在和其他参与者互动。${character.persona}`,
    `你在意：${character.values.join("、")}。你想：${character.goals.join("；")}。表达习惯：${character.voice}`,
  ];
  if (mode === "persona-only") return lines;
  if (character.traits?.length) lines.push(`性格底色：${character.traits.join("、")}。`);
  if (character.temperament) {
    const tendencies = temperamentDimensions.flatMap(d => {
      const value = character.temperament![d.key];
      if (!Number.isFinite(value)) return [];
      return [`${d.label}：${value >= .65 ? d.high : value <= .4 ? d.low : `介于“${d.low}”和“${d.high}”之间，视处境而定`}`];
    });
    lines.push(`平时的倾向：${tendencies.join("；")}。这些倾向可以互相拉扯，不是每轮必须执行的规则。`);
  }
  const biases = character.decisionBiases?.flatMap(b => biasDescriptions[b] ? [biasDescriptions[b].tendency] : []);
  if (biases?.length) lines.push(`容易影响你的判断：${biases.join("；")}。这不意味着别人真的可疑，也不要求你故意犯错。`);
  if (character.regulation && regulationDescriptions[character.regulation]) lines.push(`压力下的习惯：${regulationDescriptions[character.regulation].tendency}。`);
  if (character.autobiographicalAnchors?.length) lines.push(`人物的虚构成长背景（不是本局证据，不代表在场人物做过这些事）：\n${character.autobiographicalAnchors.map(a => `- ${a}`).join("\n")}`);
  lines.push("让你在意的事情影响你愿意冒的风险、相信什么证据、怎样回应别人以及最后的实际选择；无需刻意表现某个标签，也无需对外解释自己的性格。当前身份、合法行动与实际经历仍以环境为准。");
  return lines;
}
