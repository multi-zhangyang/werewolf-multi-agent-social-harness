// Historical state schema and replay compatibility. Live cognition is in src/agents/cognition.ts.
import { z } from "zod";
import type { WorldEvent } from "./types";

export const psychologyVersion = "appraisal-v2";
export const emotionLabels = { calm: "平静", hurt: "受伤", anger: "愤怒", anxiety: "不安", guilt: "内疚", gratitude: "感激", hope: "期待" };
export const needLabels = { security: "安全", fairness: "公平", belonging: "联结", autonomy: "自主", achievement: "收益与成就" };
export const strategyLabels = { probe: "试探", cooperate: "合作", protect: "自保", retaliate: "反击", repair: "修复", exploit: "利用", withdraw: "退出" };
const text = (max: number) => z.string().trim().min(1).max(max);
export const psychologicalStateSchema = z.object({
  appraisal: text(200),
  sourceIds: z.array(z.string()).min(1).max(8),
  emotions: z.array(z.object({ emotion: z.enum(["calm", "hurt", "anger", "anxiety", "guilt", "gratitude", "hope"]), intensity: z.number().min(0).max(1) }).strict()).min(1).max(3),
  needs: z.array(z.object({ need: z.enum(["security", "fairness", "belonging", "autonomy", "achievement"]), tension: z.number().min(0).max(1) }).strict()).min(1).max(3),
  relationships: z.array(z.object({
    targetId: text(120), trust: z.number().min(-1).max(1),
    hypothesis: text(160), alternative: text(160), confidence: z.number().min(0).max(1),
    expectedNextMove: text(160),
  }).strict()).max(11),
  strategy: z.object({ kind: z.enum(["probe", "cooperate", "protect", "retaliate", "repair", "exploit", "withdraw"]), aim: text(180), boundary: text(160), publicFace: text(160) }).strict(),
}).strict();
export const predictionSchema = z.object({ targetId: text(120), action: z.enum(["invest", "return_funds", "repair_transfer"]), round: z.number().int().min(1).max(16), threshold: z.number().min(0).max(1000), unit: z.enum(["points", "received-share"]), probability: z.number().min(0).max(1) }).strict();
export const hybridProposalSchema = psychologicalStateSchema.omit({ relationships: true }).extend({
  commitmentIntent: z.object({ plannedReturnPercent: z.number().int().min(0).max(100), expectedInvestment: z.number().int().min(0).max(10), purpose: text(160) }).strict().optional(),
  relationships: z.array(z.object({ targetId: text(120), willingness: z.number().min(0).max(1), competence: z.number().min(0).max(1), hypothesis: text(160), alternative: text(160), confidence: z.number().min(0).max(1), expectedNextMove: text(160), sourceIds: z.array(z.string()).min(1).max(8) }).strict()).max(11),
  conflict: text(180),
  regulation: z.enum(["reappraise", "suppress", "ruminate", "repair", "none"]),
  predictions: z.array(predictionSchema).max(2),
}).strict();
export const hybridStateSchema = hybridProposalSchema.extend({
  emotions: z.array(psychologicalStateSchema.shape.emotions.element).min(1).max(7),
  version: z.literal("hybrid-v1"),
  dynamics: z.object({ stageId: z.string(), processedIds: z.array(z.string()), inertia: z.number(), decay: z.number(), newSourceIds: z.array(z.string()), proposalEmotions: psychologicalStateSchema.shape.emotions }).strict(),
}).strict();
export const storedPsychologySchema = z.union([hybridStateSchema, psychologicalStateSchema]);
export type HybridProposal = z.infer<typeof hybridProposalSchema>;
export type HybridState = z.infer<typeof hybridStateSchema>;
export type PsychologicalState = z.infer<typeof storedPsychologySchema>;
export function isHybrid(state: PsychologicalState): state is HybridState { return "version" in state && state.version === "hybrid-v1"; }

/** The state is a simulated agent's report, never a measurement of another mind. */
export function psychologyFromEvent(event?: WorldEvent): PsychologicalState | undefined {
  if (event?.type !== "note" || event.data.kind !== "psychology") return;
  const parsed = storedPsychologySchema.safeParse(event.data.psychology);
  return parsed.success ? parsed.data : undefined;
}
export function latestPsychology(events: WorldEvent[], actorId: string): PsychologicalState | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].actorId === actorId) {
    const state = psychologyFromEvent(events[i]); if (state) return state;
  }
}
