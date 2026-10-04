import type { BeliefSnapshot } from "./behavior-model";

export interface DecisionStructure {
  information: "private-information" | "unverified-claim" | "public-history" | "sealed-actions" | "hidden-roles";
  control: "signal" | "accept-or-reject" | "entrust" | "distribute" | "contribute" | "compensate" | "social-deduction";
  verification: "after-decision" | "public-action";
  incentives: "aligned" | "conflicting" | "mixed";
  horizon: "repeated" | "final" | "unknown";
}

export interface PayoffOption {
  label: string;
  parameters: Record<string, unknown>;
  branches: Array<{ probability: number; condition: Record<string, number | boolean>; own: number; others: number }>;
  expectedOwn: number;
  expectedOthers: number;
  ownRange: [number, number];
  reportAccurate?: boolean;
}

export interface PayoffComparison {
  action: string;
  rationale: string;
  options: PayoffOption[];
  beliefSnapshot?: BeliefSnapshot;
  note: string;
}

export function sameChoice(left: Record<string, unknown>, right: Record<string, unknown>) {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key] === value);
}

/** Compare an ex-ante estimate only with its committed action's observed outcome. */
export function payoffFeedback(comparison: PayoffComparison, parameters: Record<string, unknown>, data: Record<string, unknown>, reward: number) {
  const selected = comparison.options.find(option => sameChoice(option.parameters, parameters));
  if (!selected) return;
  const observations: Record<string, number | boolean> = {};
  for (const field of ["accepted", "highQuality", "returned"] as const) {
    if (typeof data[field] === "boolean" || typeof data[field] === "number") observations[field] = data[field];
  }
  if (comparison.action === "contribute" && data.amounts) {
    observations.otherTotal = Object.values(data.amounts as Record<string, number>).reduce((sum, amount) => sum + amount, 0) - Number(parameters.amount);
  }
  const possible = selected.branches.filter(branch => Object.entries(branch.condition).every(([field, value]) => observations[field] === value));
  const verifiable = selected.branches.every(branch => Object.keys(branch.condition).every(field => field in observations));
  return { expectedOwn: selected.expectedOwn, actualOwn: reward, residual: reward - selected.expectedOwn,
    observed: observations, modeledOutcomeProbability: verifiable ? possible.reduce((sum, branch) => sum + branch.probability, 0) : null,
    note: "只有已提交选项得到观察反馈；收益与期望之差不是后悔值，未采取动作的对手反应没有被验证。" };
}
