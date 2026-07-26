import { lazy } from "react";

export const SocietyEvidenceWorkspace = lazy(async () => {
  const module = await import("./SocietyEvidenceWorkspace");
  return { default: module.SocietyEvidenceWorkspace };
});
export const AgentDecisionEvidencePanel = lazy(async () => {
  const module = await import("./AgentDecisionEvidencePanel");
  return { default: module.AgentDecisionEvidencePanel };
});
export const WerewolfLiveBoard = lazy(async () => {
  const module = await import("./WerewolfLiveBoard");
  return { default: module.WerewolfLiveBoard };
});
export const WerewolfReviewBoard = lazy(async () => {
  const module = await import("./WerewolfReviewBoard");
  return { default: module.WerewolfReviewBoard };
});
export const EvaluationWorkspace = lazy(async () => {
  const module = await import("./EvaluationWorkspace");
  return { default: module.EvaluationWorkspace };
});
