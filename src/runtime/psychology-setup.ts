import { z } from "zod";
import type { HybridState } from "./psychology";
import type { RunSpec } from "./types";

export const motivationLabels = { balanced: "自主权衡", gain: "个人收益", fairness: "公平与守约", relationship: "维持合作" };
export const psychologySetupSchema = z.object({
  motivation: z.enum(["balanced", "gain", "fairness", "relationship"]).default("balanced"),
  emotion: z.enum(["calm", "hurt", "anger", "anxiety", "guilt", "gratitude", "hope"]).default("calm"),
  intensity: z.number().min(0).max(1).default(.2),
  relationship: z.object({ targetId: z.string().min(1), willingness: z.number().min(0).max(1), competence: z.number().min(0).max(1) }).strict().optional(),
  objective: z.string().trim().max(360).default(""),
}).strict();
export type PsychologySetup = z.infer<typeof psychologySetupSchema>;
const motives = {
  balanced: "在收益、公平与关系之间自主权衡。",
  gain: "本局优先增加自己的累计积分。可以隐瞒自己的打算或争取更有利的承诺，但你自主决定是否这样做，并承担对方后续反应带来的损益。",
  fairness: "本局特别在意公平、对等和自己作出的承诺；仍需考虑自己的收益与风险。",
  relationship: "本局特别在意让合作持续，愿意衡量短期让利是否有助于后续互惠；不保证对方值得信任。",
};

export function setupInstructions(spec: RunSpec, actorId: string) {
  const setup = spec.psychologySetup?.[actorId];
  return setup ? [`本局只给你设定的私下目标：${motives[setup.motivation]}${setup.objective ? `你还希望：${setup.objective}` : ""}`,
    "心理初态是实验设定，不是你经历过的背叛或他人真实意图的证据。可以改变主意、合作或利用机会。对方不知道你的私下目标，公开说法不必暴露它；不要向对方讲实验设置。金额、承诺及补偿都必须由你用合法工具自主提交。"] : [];
}

/** An explicit intervention, never fabricated autobiographical evidence or a forced action. */
export function initialMind(setup: PsychologySetup, sourceId: string, stageId: string, spec: RunSpec): HybridState {
  return {
    version: "hybrid-v1", appraisal: "这是本局的实验初态，尚未根据本局互动形成判断。", sourceIds: [sourceId],
    emotions: setup.emotion === "calm" ? [{ emotion: "calm", intensity: setup.intensity }] : [{ emotion: setup.emotion, intensity: setup.intensity }, { emotion: "calm", intensity: 1 - setup.intensity }],
    needs: [{ need: setup.motivation === "gain" ? "achievement" : setup.motivation === "relationship" ? "belonging" : "fairness", tension: .5 }],
    relationships: setup.relationship ? [{ ...setup.relationship, hypothesis: "初始主观估计，尚待对方的实际行动检验", alternative: "我的起点判断可能不准确", confidence: .3, expectedNextMove: "尚未形成预测", sourceIds: [sourceId] }] : [],
    strategy: { kind: "probe", aim: setup.objective.slice(0, 180) || `尚未决定行动；本局关注${motivationLabels[setup.motivation]}`, boundary: "依据本局实际收到的证据修订", publicFace: "尚未决定怎样表达" },
    conflict: "私下目标、关系与风险仍需在实际处境中权衡", regulation: "none", predictions: [],
    dynamics: { stageId, processedIds: [sourceId], inertia: spec.cognition?.inertia ?? .6, decay: spec.cognition?.decay ?? .1, newSourceIds: [sourceId], proposalEmotions: [{ emotion: setup.emotion, intensity: setup.intensity }] },
  };
}
