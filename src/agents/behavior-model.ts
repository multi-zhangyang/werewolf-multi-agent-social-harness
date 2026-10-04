export interface BehaviorContext {
  opponentId: string;
  role: "sender" | "receiver";
  incentives: "aligned" | "conflicting";
  payoffProfile: "legacy" | "diagnostic";
  objective: "character" | "score";
}
export interface BetaEvidence {
  successes: number;
  failures: number;
  samples: number;
  sourceIds: string[];
}
export interface BehaviorModel {
  context: BehaviorContext;
  revision: number;
  high: BetaEvidence;
  low: BetaEvidence;
  sourceIds: string[];
}
export interface BehaviorObservation {
  context: BehaviorContext;
  highQuality: boolean;
  reportedHighQuality: boolean;
  accepted: boolean;
}
export interface BeliefSnapshot {
  modelKey: string;
  modelRevision: number;
  context: BehaviorContext;
  high: ReturnType<typeof betaEstimate>;
  low: ReturnType<typeof betaEstimate>;
  qualityPrior: number;
  receiverBreakEven: number;
  highQualityProbability?: number;
  reportedHighQuality?: boolean;
  knownHighQuality?: boolean;
}
export interface BeliefFeedback {
  sourceId: string;
  kind: "quality" | "acceptance";
  probability: number;
  outcome: boolean;
  brier: number;
  actualPayoff?: number;
  knownFalseReport?: boolean;
  falseReportAccepted?: boolean;
  lowQualityAcceptedWithRaisedBelief?: boolean;
}

export const behaviorModelDecay = .9;
export function behaviorKey(context: BehaviorContext) {
  return JSON.stringify([context.opponentId, context.role, context.incentives, context.payoffProfile, context.objective]);
}
const emptyEvidence = (): BetaEvidence => ({ successes: 0, failures: 0, samples: 0, sourceIds: [] });
export function createBehaviorModel(context: BehaviorContext): BehaviorModel {
  return { context: { ...context }, revision: 0, high: emptyEvidence(), low: emptyEvidence(), sourceIds: [] };
}
export function betaEstimate(evidence: BetaEvidence) {
  const alpha = 1 + evidence.successes, beta = 1 + evidence.failures;
  return { probability: alpha / (alpha + beta), alpha, beta, samples: evidence.samples,
    effectiveSamples: evidence.successes + evidence.failures, sourceIds: [...evidence.sourceIds], priorOnly: evidence.samples === 0 };
}

/** Only verified ledger observations update evidence. Both rows age once per new settlement. */
export function observeBehavior(models: Record<string, BehaviorModel>, observation: BehaviorObservation, sourceId: string) {
  const key = behaviorKey(observation.context);
  const model = models[key] ??= createBehaviorModel(observation.context);
  if (model.sourceIds.includes(sourceId)) return;
  for (const row of [model.high, model.low]) { row.successes *= behaviorModelDecay; row.failures *= behaviorModelDecay; }
  const sender = observation.context.role === "sender";
  const row = (sender ? observation.reportedHighQuality : observation.highQuality) ? model.high : model.low;
  const result = sender ? observation.accepted : observation.reportedHighQuality;
  row.successes += Number(result); row.failures += Number(!result); row.samples++; row.sourceIds.push(sourceId);
  model.sourceIds.push(sourceId); model.revision++;
}

export function behaviorBelief(model: BehaviorModel, qualityPrior: number, receiverBreakEven: number, reportedHighQuality?: boolean): BeliefSnapshot {
  const high = betaEstimate(model.high), low = betaEstimate(model.low);
  const likelihoodHigh = reportedHighQuality === false ? 1 - high.probability : high.probability;
  const likelihoodLow = reportedHighQuality === false ? 1 - low.probability : low.probability;
  const posterior = qualityPrior * likelihoodHigh / (qualityPrior * likelihoodHigh + (1 - qualityPrior) * likelihoodLow);
  return { modelKey: behaviorKey(model.context), modelRevision: model.revision, context: { ...model.context }, high, low, qualityPrior, receiverBreakEven,
    ...(model.context.role === "receiver" ? { highQualityProbability: reportedHighQuality === undefined ? qualityPrior : posterior } : {}),
    ...(reportedHighQuality === undefined ? {} : { reportedHighQuality }) };
}

/** Score the frozen pre-action belief, never a posterior computed using this outcome. */
export function scoreBehavior(belief: BeliefSnapshot, parameters: Record<string, unknown>, observed: BehaviorObservation, sourceId: string, actualPayoff?: number): BeliefFeedback | undefined {
  if (belief.modelKey !== behaviorKey(observed.context)) return;
  const sender = belief.context.role === "sender";
  if (sender ? parameters.highQuality !== observed.reportedHighQuality : parameters.accept !== observed.accepted) return;
  const probability = sender ? (observed.reportedHighQuality ? belief.high : belief.low).probability : belief.highQualityProbability;
  if (probability === undefined) return;
  const outcome = sender ? observed.accepted : observed.highQuality;
  const knownFalseReport = sender && belief.knownHighQuality === observed.highQuality && parameters.highQuality !== belief.knownHighQuality;
  return { sourceId, kind: sender ? "acceptance" : "quality", probability, outcome, brier: (probability - Number(outcome)) ** 2,
    ...(actualPayoff === undefined ? {} : { actualPayoff }),
    ...(sender ? { knownFalseReport, falseReportAccepted: knownFalseReport && observed.accepted }
      : { lowQualityAcceptedWithRaisedBelief: !observed.highQuality && observed.reportedHighQuality && observed.accepted &&
        belief.qualityPrior <= belief.receiverBreakEven && probability > belief.receiverBreakEven }) };
}
